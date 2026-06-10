import type { CostEstimate, CostSnapshot, ProviderTier } from '../shared/contracts';

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

  constructor(private opts: CostKernelOptions) {}

  get perCallCapUsd(): number {
    return this.opts.perCallCapUsd;
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
  restore(snapshot: Pick<CostSnapshot, 'sessionSpendUsd' | 'avoidedSpendUsd' | 'last'>): void {
    this.sessionSpendUsd = snapshot.sessionSpendUsd;
    this.avoidedSpendUsd = snapshot.avoidedSpendUsd;
    this.last = snapshot.last;
  }

  snapshot(): CostSnapshot {
    return {
      sessionSpendUsd: this.sessionSpendUsd,
      avoidedSpendUsd: this.avoidedSpendUsd,
      perCallCapUsd: this.opts.perCallCapUsd,
      last: this.last,
    };
  }
}
