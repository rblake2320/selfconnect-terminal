import { randomUUID } from 'node:crypto';
import {
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalStatus,
  type ProviderKind,
} from '../shared/contracts';

/**
 * Approval gate. HARD SECURITY RULES 8 & 9: cloud/premium calls require human
 * approval, and the approval window is 2 minutes — a timeout is treated as a
 * denial (fail-closed). Implemented with injectable timer functions so tests
 * can drive it with fake timers deterministically.
 */

export interface CreateApprovalInput {
  kind: ApprovalKind;
  summary: string;
  provider: ProviderKind;
  model: string;
  estimatedCostUsd: number;
}

type Resolver = (status: ApprovalStatus) => void;

export interface ApprovalDeps {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const defaultDeps: ApprovalDeps = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

export type ApprovalListener = (req: ApprovalRequest) => void;

export class ApprovalManager {
  private pending = new Map<string, ApprovalRequest>();
  private resolvers = new Map<string, Resolver>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<ApprovalListener>();

  constructor(
    private readonly timeoutMs: number,
    private readonly deps: ApprovalDeps = defaultDeps,
  ) {}

  onChange(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(req: ApprovalRequest): void {
    for (const l of this.listeners) l(req);
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()];
  }

  /**
   * Open an approval request and return a promise that resolves to the final
   * status. The promise resolves 'timeout' (== denied) if no decision arrives
   * within `timeoutMs`.
   */
  request(input: CreateApprovalInput): { id: string; promise: Promise<ApprovalStatus> } {
    const id = `appr_${randomUUID()}`;
    const createdAt = this.deps.now();
    const req: ApprovalRequest = {
      id,
      kind: input.kind,
      summary: input.summary,
      provider: input.provider,
      model: input.model,
      estimatedCostUsd: input.estimatedCostUsd,
      createdAt,
      expiresAt: createdAt + this.timeoutMs,
      status: 'pending',
    };
    this.pending.set(id, req);

    const promise = new Promise<ApprovalStatus>((resolve) => {
      this.resolvers.set(id, resolve);
      const handle = this.deps.setTimeout(() => {
        this.finalize(id, 'timeout');
      }, this.timeoutMs);
      this.timers.set(id, handle);
    });

    this.emit(req);
    return { id, promise };
  }

  /** Resolve a pending approval from a human decision. */
  decide(id: string, approve: boolean): ApprovalStatus | null {
    if (!this.pending.has(id)) return null;
    return this.finalize(id, approve ? 'approved' : 'denied');
  }

  private finalize(id: string, status: ApprovalStatus): ApprovalStatus | null {
    const req = this.pending.get(id);
    if (!req) return null;
    const timer = this.timers.get(id);
    if (timer) this.deps.clearTimeout(timer);
    this.timers.delete(id);

    const resolved: ApprovalRequest = { ...req, status };
    this.pending.delete(id);
    const resolver = this.resolvers.get(id);
    this.resolvers.delete(id);
    this.emit(resolved);
    resolver?.(status);
    return status;
  }

  /** True if the status represents an authorized go-ahead. */
  static isGranted(status: ApprovalStatus): boolean {
    return status === 'approved';
  }
}
