import React, { useCallback, useEffect, useState } from 'react';
import type { LabReport } from '../../shared/contracts';

/**
 * D6 Harness Lab panel. Shows the most recent lab run's side-by-side arm
 * comparison, scored purely from the ledger. Read-only: the renderer just
 * displays the report the daemon stored; arms are executed daemon-side under
 * the governed tool path. Run a lab via `/lab run <file>` or the CLI.
 */
export function LabPanel(): React.JSX.Element {
  const [report, setReport] = useState<LabReport | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await window.selfconnect.labLatest());
    } catch {
      /* daemon not ready */
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 2000);
    return () => clearInterval(poll);
  }, [load]);

  return (
    <div className="card lab-card">
      <div className="card-title">
        <span>Harness Lab</span>
        <button className="btn btn-small" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {!report || report.scores.length === 0 ? (
        <p className="muted">
          No lab run yet. Run <code>/lab run &lt;task-file&gt; --arms a,b</code> to compare harness
          configs.
        </p>
      ) : (
        <>
          <div className="lab-task mono muted">
            {report.task} · {new Date(report.ranAt).toLocaleTimeString()}
          </div>
          <table className="lab-table">
            <thead>
              <tr>
                <th>arm</th>
                <th>turns</th>
                <th>tokens</th>
                <th>cache%</th>
                <th>err%</th>
                <th>appr</th>
                <th>ms</th>
                <th>ok</th>
              </tr>
            </thead>
            <tbody>
              {report.scores.map((s) => (
                <tr key={s.runId}>
                  <td>{s.arm}</td>
                  <td>{s.turns}</td>
                  <td>{s.totalTokens}</td>
                  <td>{s.cacheHitPct.toFixed(1)}</td>
                  <td>{s.toolErrorRate.toFixed(1)}</td>
                  <td>{s.approvalsTriggered}</td>
                  <td>{s.wallTimeMs}</td>
                  <td className={s.success ? 'lab-pass' : 'lab-fail'}>
                    {s.success ? 'PASS' : 'FAIL'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
