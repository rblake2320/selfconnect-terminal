import React, { useState } from 'react';
import type { ReviewMode, ReviewResult } from '../../shared/contracts';

const MODES: ReviewMode[] = ['optimize', 'bugs', 'architecture', 'security', 'next-steps', 'full'];

/**
 * Widget 1 — Review Mascot (floating). Click a mode to trigger the daemon's
 * snapshot -> redact -> route -> review pipeline. Read-only; it never executes.
 */
export function ReviewMascot(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(mode: ReviewMode): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await window.selfconnect.runReview(mode);
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mascot">
      <button className="mascot-orb" onClick={() => setOpen((v) => !v)} title="SelfConnect Review">
        {busy ? '…' : 'SC'}
      </button>
      {open && (
        <div className="mascot-panel">
          <div className="mascot-modes">
            {MODES.map((m) => (
              <button key={m} className="btn" disabled={busy} onClick={() => run(m)}>
                {m}
              </button>
            ))}
          </div>
          {error && <div className="mascot-error">{error}</div>}
          {result && (
            <div className="mascot-result">
              <div className="mascot-result-head">
                {result.mode} · {result.provider}/{result.model} · redactions{' '}
                {result.redactionCount} · ${result.cost.costUsd.toFixed(4)}
              </div>
              <pre>{result.content}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
