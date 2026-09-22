import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../shared/contracts';

/**
 * Saved history (daily terminal UX). A truthful, read-only view of a past
 * session's persisted scrollback. It never resumes an agent or a process and
 * never writes saved bytes into the live terminal: the snapshot is rendered
 * as plain text in a <pre>, with terminal control sequences stripped first.
 */

interface SavedHistory {
  sessionId: string;
  capturedAt: number;
  scrollback: string[];
}

/** Strip OSC / CSI / other C0 controls so saved output renders as plain text. */
export function stripTerminalControls(line: string): string {
  return line
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function fmtAge(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function HistoryPanel(props: {
  sessions: SessionSummary[];
  currentSessionId: string;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<SavedHistory | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);

  const sessions = useMemo(
    () => [...props.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [props.sessions],
  );

  const load = useCallback(async (sessionId: string) => {
    setSelected(sessionId);
    setError('');
    setCopied(false);
    setBusy(true);
    try {
      const h = await window.selfconnect.sessionHistory(sessionId);
      setHistory({ ...h, scrollback: h.scrollback.map(stripTerminalControls) });
    } catch (e) {
      setHistory(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  // If the selected session disappears from the list, drop the stale view.
  useEffect(() => {
    if (selected && !sessions.some((s) => s.sessionId === selected)) {
      setSelected(null);
      setHistory(null);
    }
  }, [sessions, selected]);

  const shown = useMemo(() => {
    if (!history) return [];
    const q = filter.trim().toLowerCase();
    const lines = history.scrollback;
    if (!q) return lines.map((text, i) => ({ n: i + 1, text }));
    return lines
      .map((text, i) => ({ n: i + 1, text }))
      .filter((l) => l.text.toLowerCase().includes(q));
  }, [history, filter]);

  const copy = useCallback(async () => {
    if (!history) return;
    try {
      await window.selfconnect.clipboardWrite(history.scrollback.join('\n'));
      setCopied(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [history]);

  const now = Date.now();

  return (
    <div className="card history-card">
      <div className="card-title">
        <span>Saved history</span>
        <span className="history-hint muted">read-only</span>
      </div>

      {sessions.length === 0 && <div className="muted">No saved sessions yet. A snapshot is written when the app closes.</div>}

      <div className="history-list">
        {sessions.map((s) => {
          const isCurrent = s.sessionId === props.currentSessionId;
          const isSelected = s.sessionId === selected;
          return (
            <div key={s.sessionId} className={`session-row${isSelected ? ' history-selected' : ''}`}>
              <div className="kv">
                <span className="mono" title={s.sessionId}>
                  {s.sessionId.slice(0, 18)}…
                </span>
                <span className={s.chainOk ? 'good' : 'bad'} title="global ledger hash chain at the time of listing (not a per-session proof)">
                  {s.chainOk ? 'global chain OK' : 'global chain BROKEN'}
                </span>
              </div>
              <div className="kv">
                <span className="muted" title={fmtWhen(s.lastActiveAt)}>
                  {fmtAge(s.lastActiveAt, now)} · {s.eventCount} events · ${s.sessionSpendUsd.toFixed(4)}
                  {isCurrent && ' · this session'}
                </span>
                <button
                  className="btn btn-small"
                  disabled={busy && isSelected}
                  onClick={() => void load(s.sessionId)}
                  aria-label={`View saved history for session ${s.sessionId}`}
                >
                  {isSelected ? 'Reload' : 'View'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div role="alert" className="history-error">
          {error}
        </div>
      )}

      {history && (
        <div className="history-view">
          <div className="history-meta mono muted">
            snapshot saved {fmtWhen(history.capturedAt)} · {history.scrollback.length} lines
            {history.sessionId === props.currentSessionId ? ' · this session (as last saved)' : ''}
          </div>
          <div className="history-notice">
            This is saved output only; viewing it does not start or restore a shell or agent. Nothing here is sent to
            the live terminal.
          </div>
          <div className="history-tools">
            <input
              className="history-filter mono"
              type="search"
              placeholder="filter lines"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter saved history lines"
            />
            <button className="btn btn-small" onClick={() => void copy()} disabled={!history.scrollback.length}>
              {copied ? 'Copied' : 'Copy all'}
            </button>
            <button
              className="btn btn-small"
              onClick={() => {
                setHistory(null);
                setSelected(null);
                setFilter('');
              }}
            >
              Close
            </button>
          </div>
          {history.scrollback.length === 0 ? (
            <div className="muted">The saved snapshot has no terminal output.</div>
          ) : shown.length === 0 ? (
            <div className="muted">No lines match the filter.</div>
          ) : (
            <pre className="history-pre mono" aria-label="Saved terminal output">
              {shown.map((l) => (
                <div key={l.n} className="history-line">
                  <span className="history-ln muted">{String(l.n).padStart(4)}</span> {l.text}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
