import type { CostEstimate, CostSnapshot, MeteringRecord, ProviderTier } from '../shared/contracts';

/**
 * Cost Kernel. Tracks estimated-before-send vs verified-after-response token
 * costs, cumulative session spend, and the "avoided" cloud spend that local
 * calls save (computed against the configured baseline cloud pricing).
 *
 * Prices are expressed in USD per 1M tokens (matching the .env knobs:
 * COST_BASELINE_INPUT_PRICE / OUTPUT_PRICE, ANTHROPIC_INPUT_PRICE / OUTPUT).
 */

export interface PricePair {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface CostKernelOptions {
  perCallCapUsd: number;
  baseline: PricePair;
}

const PER_MILLION = 1_000_000;

export function priceFor(
  inputTokens: number,
  outputTokens: number,
  price: PricePair,
): number {
  return (
    (inputTokens / PER_MILLION) * price.inputPerMillion +
    (outputTokens / PER_MILLION) * price.outputPerMillion
  );
}

/** Rough heuristic token estimate from a character count (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class CostKernel {
  private sessionSpendUsd = 0;
  private avoidedSpendUsd = 0;
  private last: CostEstimate | null = null;
  // --- v3: Context Economy savings accounting ---
  private tokensNotResent = 0;
  private cacheSavingsUsd = 0;
  private distillationSavingsUsd = 0;
  private freshInputTokens = 0;
  private totalInputTokens = 0;
  // --- v3b: per-agent metering (B2.4 inter-agent accounting) ---
  private metering = new Map<string, MeteringRecord>();

  constructor(private opts: CostKernelOptions) {}

  /**
   * Book resource consumption against a specific agent (B2.4). The primitive
   * for future agent-to-agent settlement — provable accounting, no payments.
   */
  meter(agentId: string, delta: { toolCalls?: number; spendUsd?: number; inputTokens?: number; outputTokens?: number }): MeteringRecord {
    const cur = this.metering.get(agentId) ?? {
      agentId,
      toolCalls: 0,
      spendUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      updatedAt: 0,
    };
    const next: MeteringRecord = {
      agentId,
      toolCalls: cur.toolCalls + (delta.toolCalls ?? 0),
      spendUsd: cur.spendUsd + (delta.spendUsd ?? 0),
      inputTokens: cur.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: cur.outputTokens + (delta.outputTokens ?? 0),
      updatedAt: Date.now(),
    };
    this.metering.set(agentId, next);
    return next;
  }

  meteringFor(agentId: string): MeteringRecord {
    return (
      this.metering.get(agentId) ?? {
        agentId,
        toolCalls: 0,
        spendUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        updatedAt: 0,
      }
    );
  }

  meteringList(): MeteringRecord[] {
    return [...this.metering.values()];
  }

  get perCallCapUsd(): number {
    return this.opts.perCallCapUsd;
  }

  /**
   * Record a dedup hit: `savedTokens` were NOT resent because the model had
   * already seen the blob. Priced at the baseline cloud input rate (this is the
   * money a cloud-only harness would have burned re-sending the same bytes).
   */
  recordDedup(savedTokens: number): void {
    if (savedTokens <= 0) return;
    this.tokensNotResent += savedTokens;
    this.cacheSavingsUsd += (savedTokens / PER_MILLION) * this.opts.baseline.inputPerMillion;
  }

  /**
   * Record a distillation that ran on the local model instead of cloud. The
   * tokens it would have cost at baseline cloud input pricing are booked as
   * distillation savings.
   */
  recordDistillation(distilledTokens: number): void {
    if (distilledTokens <= 0) return;
    this.distillationSavingsUsd += (distilledTokens / PER_MILLION) * this.opts.baseline.inputPerMillion;
  }

  /**
   * Account a model call's input tokens for Context Efficiency: `freshTokens`
   * are genuinely new (useful) tokens; the remainder of `totalTokens` is
   * re-sent / boilerplate overhead.
   */
  accountContext(freshTokens: number, totalTokens: number): void {
    this.freshInputTokens += Math.max(0, freshTokens);
    this.totalInputTokens += Math.max(0, totalTokens);
  }

  /** useful-new-tokens / total-tokens, 0..100. 100 when nothing accounted yet. */
  contextEfficiencyPct(): number {
    if (this.totalInputTokens <= 0) return 100;
    return Math.max(0, Math.min(100, (this.freshInputTokens / this.totalInputTokens) * 100));
  }

  /**
   * Estimate the cost of a call before sending. For local tiers the real cost
   * is always 0, and we surface the cloud baseline cost as "avoided".
   */
  estimate(
    tier: ProviderTier,
    inputTokens: number,
    outputTokens: number,
    cloudPrice: PricePair,
  ): CostEstimate {
    const baselineCost = priceFor(inputTokens, outputTokens, this.opts.baseline);
    if (tier === 'local') {
      return {
        kind: 'ESTIMATED',
        inputTokens,
        outputTokens,
        costUsd: 0,
        avoidedUsd: baselineCost,
      };
    }
    return {
      kind: 'ESTIMATED',
      inputTokens,
      outputTokens,
      costUsd: priceFor(inputTokens, outputTokens, cloudPrice),
      avoidedUsd: 0,
    };
  }

  /**
   * Record the verified cost after a response, updating session totals. Local
   * calls contribute 0 to spend but add their baseline cost to avoided spend.
   */
  record(
    tier: ProviderTier,
    inputTokens: number,
    outputTokens: number,
    cloudPrice: PricePair,
  ): CostEstimate {
    const baselineCost = priceFor(inputTokens, outputTokens, this.opts.baseline);
    let costUsd: number;
    let avoidedUsd: number;
    if (tier === 'local') {
      costUsd = 0;
      avoidedUsd = baselineCost;
    } else {
      costUsd = priceFor(inputTokens, outputTokens, cloudPrice);
      avoidedUsd = 0;
    }
    this.sessionSpendUsd += costUsd;
    this.avoidedSpendUsd += avoidedUsd;
    const verified: CostEstimate = {
      kind: 'VERIFIED',
      inputTokens,
      outputTokens,
      costUsd,
      avoidedUsd,
    };
    this.last = verified;
    return verified;
  }

  setLast(estimate: CostEstimate): void {
    this.last = estimate;
  }

  /** Restore cumulative totals from a persisted snapshot (session resume). */
  restore(snapshot: CostSnapshot): void {
    this.sessionSpendUsd = snapshot.sessionSpendUsd;
    this.avoidedSpendUsd = snapshot.avoidedSpendUsd;
    this.last = snapshot.last;
    this.tokensNotResent = snapshot.tokensNotResent ?? 0;
    this.cacheSavingsUsd = snapshot.cacheSavingsUsd ?? 0;
    this.distillationSavingsUsd = snapshot.distillationSavingsUsd ?? 0;
  }

  snapshot(): CostSnapshot {
    return {
      sessionSpendUsd: this.sessionSpendUsd,
      avoidedSpendUsd: this.avoidedSpendUsd,
      perCallCapUsd: this.opts.perCallCapUsd,
      last: this.last,
      tokensNotResent: this.tokensNotResent,
      cacheSavingsUsd: this.cacheSavingsUsd,
      distillationSavingsUsd: this.distillationSavingsUsd,
      contextEfficiencyPct: this.contextEfficiencyPct(),
    };
  }
}
