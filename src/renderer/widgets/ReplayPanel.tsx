import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { LedgerEntry } from '../../shared/contracts';

const KIND_COLOR: Record<string, string> = {
  'terminal.input': '#7fd3ff',
  'terminal.output': '#9aa',
  'tool.call': '#c8a2ff',
  'tool.result': '#a2ffc8',
  'route.decision': '#ffd479',
  'risk.detected': '#ff7b72',
  'approval.requested': '#ffd479',
  'approval.resolved': '#a2ffc8',
  'delegation.issued': '#c8a2ff',
  'grant.root': '#ffd479',
  'checkpoint.signed': '#7fd3ff',
  'run.start': '#9aa',
  'run.end': '#9aa',
};

function color(type: string): string {
  return KIND_COLOR[type] ?? '#9aa';
}

/**
 * Flight recorder (B): scrub through a past session's ledger events on a
 * timeline. Read-only — the renderer only ever receives redaction-gated ledger
 * entries from the daemon, never keys. Exports a signed .screplay via the CLI;
 * here we offer a JSON download of the timeline for offline inspection.
 */
export function ReplayPanel(): React.JSX.Element {
  const [events, setEvents] = useState<LedgerEntry[]>([]);
  const [pos, setPos] = useState(0);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const evts = await window.selfconnect.replayEvents();
      setEvents(evts);
      setPos(evts.length ? evts.length - 1 : 0);
    } catch {
      /* daemon not ready */
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const current = events[pos];
  const span = useMemo(() => {
    if (events.length < 2) return 0;
    return events[events.length - 1].ts - events[0].ts;
  }, [events]);

  const download = useCallback(() => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${current?.sessionId ?? 'session'}.screplay.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [events, current]);

  if (!open) {
    return (
      <div className="card replay-card">
        <div className="card-title">
          <span>Flight Recorder</span>
          <button className="btn btn-small" onClick={() => setOpen(true)}>
            Open replay
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card replay-card">
      <div className="card-title">
        <span>Flight Recorder</span>
        <div className="replay-actions">
          <button className="btn btn-small" onClick={() => void load()}>
            Reload
          </button>
          <button className="btn btn-small" onClick={download} disabled={!events.length}>
            Export .screplay
          </button>
          <button className="btn btn-small" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>

      {events.length === 0 ? (
        <p className="muted">No replayable events for this session yet.</p>
      ) : (
        <>
          <input
            className="replay-scrub"
            type="range"
            min={0}
            max={events.length - 1}
            value={pos}
            onChange={(e) => setPos(Number(e.target.value))}
          />
          <div className="replay-meta mono muted">
            event {pos + 1} / {events.length} · +
            {((current.ts - events[0].ts) / 1000).toFixed(1)}s of {(span / 1000).toFixed(1)}s
          </div>

          <div className="replay-ticks">
            {events.map((e, i) => (
              <button
                key={e.seq}
                className={`replay-tick${i === pos ? ' active' : ''}`}
                style={{ background: color(e.type) }}
                title={`#${e.seq} ${e.type}`}
                onClick={() => setPos(i)}
              />
            ))}
          </div>

          <div className="replay-detail">
            <div className="replay-detail-head">
              <span className="feed-type" style={{ color: color(current.type) }}>
                {current.type}
              </span>
              <span className="mono muted">#{current.seq}</span>
              <span className="mono muted">{current.agentId}</span>
              <span className="mono muted">{new Date(current.ts).toLocaleTimeString()}</span>
            </div>
            <pre className="replay-payload mono">{JSON.stringify(current.payload ?? {}, null, 2)}</pre>
            <div className="mono muted replay-hash">hash {current.hash.slice(0, 24)}…</div>
          </div>
        </>
      )}
    </div>
  );
}
