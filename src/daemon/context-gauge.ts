import type { ContextLevel, ContextSnapshot } from '../shared/contracts';

/**
 * Context Gauge. Tracks token pressure against a budget and maps it to a level:
 *   normal < 60, warn >= 60, danger >= 80, migrate >= 90  (per spec).
 *
 * In v3 the gauge is an ACTUATOR, not just a readout: it tracks the HOT / WARM /
 * pinned token split and tells the daemon which automation to fire at each
 * threshold (auto-compact at warn, aggressive dedup at danger, successor
 * migration at migrate). The gauge stays pure — it computes state and the
 * recommended action; the daemon performs the action and audits it.
 */
const DEFAULT_MAX_TOKENS = 200_000;

export function levelFor(pressure: number): ContextLevel {
  if (pressure >= 90) return 'migrate';
  if (pressure >= 80) return 'danger';
  if (pressure >= 60) return 'warn';
  return 'normal';
}

export type GaugeAction = 'none' | 'compact' | 'dedup' | 'migrate';

export function actionFor(level: ContextLevel): GaugeAction {
  switch (level) {
    case 'migrate':
      return 'migrate';
    case 'danger':
      return 'dedup';
    case 'warn':
      return 'compact';
    default:
      return 'none';
  }
}

export class ContextGauge {
  private hotTokens = 0;
  private warmTokens = 0;
  private pinnedTokens = 0;
  private dedupHits = 0;
  private compactions = 0;

  constructor(private readonly maxTokens: number = DEFAULT_MAX_TOKENS) {}

  /** Add tokens to the HOT (verbatim) tier — the default for live turns. */
  add(tokens: number): void {
    if (tokens > 0) this.hotTokens += tokens;
  }

  /** Add tokens already distilled into the WARM tier. */
  addWarm(tokens: number): void {
    if (tokens > 0) this.warmTokens += tokens;
  }

  setPinnedTokens(tokens: number): void {
    this.pinnedTokens = Math.max(0, tokens);
  }

  recordDedupHit(): void {
    this.dedupHits += 1;
  }

  /**
   * Move `tokens` of the oldest HOT context to WARM (auto-compaction). WARM is
   * counted at a heavy discount because it is a distilled delta, not verbatim.
   */
  compactHotToWarm(tokens: number, discount = 0.15): number {
    const moved = Math.min(this.hotTokens, Math.max(0, tokens));
    this.hotTokens -= moved;
    const warmAdded = Math.ceil(moved * discount);
    this.warmTokens += warmAdded;
    this.compactions += 1;
    return warmAdded;
  }

  reset(): void {
    this.hotTokens = 0;
    this.warmTokens = 0;
  }

  /** Restore absolute used-token count from a persisted snapshot. */
  restore(usedTokens: number): void {
    this.hotTokens = usedTokens > 0 ? usedTokens : 0;
    this.warmTokens = 0;
  }

  /** Seed the WARM/pinned/counter breakdown from a persisted ContextSnapshot. */
  restoreBreakdown(snap: Pick<ContextSnapshot, 'hotTokens' | 'warmTokens' | 'pinnedTokens' | 'dedupHits' | 'compactions'>): void {
    this.hotTokens = snap.hotTokens ?? this.hotTokens;
    this.warmTokens = snap.warmTokens ?? 0;
    this.pinnedTokens = snap.pinnedTokens ?? 0;
    this.dedupHits = snap.dedupHits ?? 0;
    this.compactions = snap.compactions ?? 0;
  }

  get used(): number {
    return this.hotTokens + this.warmTokens + this.pinnedTokens;
  }

  level(): ContextLevel {
    return this.snapshot().level;
  }

  /** Which automation the daemon should fire at the current pressure. */
  recommendedAction(): GaugeAction {
    return actionFor(this.level());
  }

  snapshot(): ContextSnapshot {
    const usedTokens = this.used;
    const pressure = Math.min(100, (usedTokens / this.maxTokens) * 100);
    return {
      usedTokens,
      maxTokens: this.maxTokens,
      pressure,
      level: levelFor(pressure),
      hotTokens: this.hotTokens,
      warmTokens: this.warmTokens,
      pinnedTokens: this.pinnedTokens,
      dedupHits: this.dedupHits,
      compactions: this.compactions,
    };
  }
}
