import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalManager } from '../src/daemon/approvals';

const TIMEOUT = 120_000; // 2 minutes, per spec

function input() {
  return {
    kind: 'cloud-send' as const,
    summary: 'test',
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4-5',
    estimatedCostUsd: 0.05,
  };
}

describe('approval manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires approval and resolves approved on explicit yes', async () => {
    const m = new ApprovalManager(TIMEOUT);
    const { id, promise } = m.request(input());
    expect(m.list()).toHaveLength(1);
    m.decide(id, true);
    await expect(promise).resolves.toBe('approved');
    expect(ApprovalManager.isGranted('approved')).toBe(true);
    expect(m.list()).toHaveLength(0);
  });

  it('resolves denied on explicit no', async () => {
    const m = new ApprovalManager(TIMEOUT);
    const { id, promise } = m.request(input());
    m.decide(id, false);
    await expect(promise).resolves.toBe('denied');
    expect(ApprovalManager.isGranted('denied')).toBe(false);
  });

  it('times out to denied after exactly 2 minutes', async () => {
    const m = new ApprovalManager(TIMEOUT);
    const { promise } = m.request(input());

    // Not yet expired just before the deadline.
    vi.advanceTimersByTime(TIMEOUT - 1);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Cross the 2-minute deadline -> timeout == denied.
    vi.advanceTimersByTime(1);
    await expect(promise).resolves.toBe('timeout');
    expect(ApprovalManager.isGranted('timeout')).toBe(false);
    expect(m.list()).toHaveLength(0);
  });

  it('emits onChange for request and resolution', async () => {
    const m = new ApprovalManager(TIMEOUT);
    const seen: string[] = [];
    m.onChange((req) => seen.push(req.status));
    const { id, promise } = m.request(input());
    m.decide(id, true);
    await promise;
    expect(seen).toEqual(['pending', 'approved']);
  });

  it('decide on unknown id is a no-op', () => {
    const m = new ApprovalManager(TIMEOUT);
    expect(m.decide('nope', true)).toBeNull();
  });

  it('sets a 2-minute expiry window on the request', () => {
    const start = Date.now();
    vi.setSystemTime(start);
    const m = new ApprovalManager(TIMEOUT);
    m.request(input());
    const req = m.list()[0];
    expect(req.expiresAt - req.createdAt).toBe(TIMEOUT);
  });
});
