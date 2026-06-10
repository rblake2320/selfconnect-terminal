import type { ContextLevel, ContextSnapshot } from '../shared/contracts';

/**
 * Context Gauge. Tracks token pressure against a budget and maps it to a level:
 *   normal < 60, warn >= 60, danger >= 80, migrate >= 90  (per spec).
 */
const DEFAULT_MAX_TOKENS = 200_000;

export function levelFor(pressure: number): ContextLevel {
  if (pressure >= 90) return 'migrate';
  if (pressure >= 80) return 'danger';
  if (pressure >= 60) return 'warn';
  return 'normal';
}

export class ContextGauge {
  private usedTokens = 0;

  constructor(private readonly maxTokens: number = DEFAULT_MAX_TOKENS) {}

  add(tokens: number): void {
    if (tokens > 0) this.usedTokens += tokens;
  }

  reset(): void {
    this.usedTokens = 0;
  }

  /** Restore absolute used-token count from a persisted snapshot. */
  restore(usedTokens: number): void {
    this.usedTokens = usedTokens > 0 ? usedTokens : 0;
  }

  snapshot(): ContextSnapshot {
    const pressure = Math.min(100, (this.usedTokens / this.maxTokens) * 100);
    return {
      usedTokens: this.usedTokens,
      maxTokens: this.maxTokens,
      pressure,
      level: levelFor(pressure),
    };
  }
}
