import React from 'react';
import type { ApprovalRequest } from '../shared/contracts';

/**
 * ApprovalsPanel: surfaces pending cloud/premium approval requests. Approving
 * or denying calls back through the bridge; a 2-minute daemon-side timeout
 * denies automatically (HARD RULES 8/9). We render a live countdown.
 */
export function ApprovalsPanel(props: {
  approvals: ApprovalRequest[];
  onDecide: (id: string, approve: boolean) => void;
  now: number;
}): React.JSX.Element | null {
  if (props.approvals.length === 0) return null;
  return (
    <div className="approvals-panel">
      <div className="approvals-title">Pending approvals</div>
      {props.approvals.map((a) => {
        const remainingMs = Math.max(0, a.expiresAt - props.now);
        const secs = Math.ceil(remainingMs / 1000);
        return (
          <div key={a.id} className="approval-card">
            <div className="approval-summary">{a.summary}</div>
            <div className="approval-meta">
              <span className={`tag tag-${a.kind}`}>{a.kind}</span>
              <span>~${a.estimatedCostUsd.toFixed(4)}</span>
              <span className="approval-timer">{secs}s</span>
            </div>
            <div className="approval-actions">
              <button className="btn btn-approve" onClick={() => props.onDecide(a.id, true)}>
                Approve
              </button>
              <button className="btn btn-deny" onClick={() => props.onDecide(a.id, false)}>
                Deny
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
