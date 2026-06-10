import React, { useCallback, useEffect, useState } from 'react';
import type { BusEvent, PermissionMode, UiState } from '../shared/contracts';
import { TerminalView } from './TerminalView';
import { ApprovalsPanel } from './ApprovalsPanel';
import { ReviewMascot } from './widgets/ReviewMascot';
import { ReplayPanel } from './widgets/ReplayPanel';
import {
  CostKernelWidget,
  ContextGaugeWidget,
  ModelRouterWidget,
  SecuritySentinelWidget,
  AgentMeshWidget,
  LedgerStatusWidget,
  PermissionModeWidget,
  TodoWidget,
  SessionsWidget,
} from './widgets/DockWidgets';

const POLL_MS = 1500;
const MAX_FEED = 200;

export function App(): React.JSX.Element {
  const [state, setState] = useState<UiState | null>(null);
  const [feed, setFeed] = useState<BusEvent[]>([]);
  const [showFeed, setShowFeed] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      setState(await window.selfconnect.getState());
    } catch {
      /* daemon not ready yet */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 500);
    const off = window.selfconnect.onBusEvent((evt) => {
      if (evt.type === 'terminal.output') return;
      setFeed((f) => [evt, ...f].slice(0, MAX_FEED));
      void refresh();
    });
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      off();
    };
  }, [refresh]);

  const onToggleLocalOnly = useCallback(async (v: boolean) => {
    setState(await window.selfconnect.setLocalOnly(v));
  }, []);

  const onVerify = useCallback(async () => {
    await window.selfconnect.verifyLedger();
    await refresh();
  }, [refresh]);

  const onDecide = useCallback(
    async (id: string, approve: boolean) => {
      await window.selfconnect.decideApproval(id, approve);
      await refresh();
    },
    [refresh],
  );

  const onSetPermissionMode = useCallback(async (mode: PermissionMode) => {
    setState(await window.selfconnect.setPermissionMode(mode));
  }, []);

  const onResumeSession = useCallback(
    async (sessionId: string) => {
      await window.selfconnect.resumeSession(sessionId);
      await refresh();
    },
    [refresh],
  );

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">SelfConnect Terminal</span>
        {state && (
          <span className="identity mono">
            {state.identity.sessionId.slice(0, 14)}… · agent {state.identity.agentId.slice(0, 16)}…
            {' · '}ctx {state.metabolic.contextRemainingPct.toFixed(0)}% · $
            {state.metabolic.budgetRemainingUsd.toFixed(2)} left ·{' '}
            {Math.round(state.metabolic.elapsedMs / 1000)}s
          </span>
        )}
        <button className="btn btn-small" onClick={() => setShowFeed((v) => !v)}>
          {showFeed ? 'Hide' : 'Show'} event feed
        </button>
      </header>

      <div className="main">
        <section className="terminal-pane">
          <TerminalView />
          {showFeed && (
            <div className="event-feed">
              {feed.map((e) => (
                <div key={e.id} className="feed-row">
                  <span className="mono muted">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className="feed-type">{e.type}</span>
                  <span className="mono muted">{e.runId?.slice(0, 12)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="dock">
          {state && (
            <>
              <CostKernelWidget cost={state.cost} />
              <ContextGaugeWidget context={state.context} />
              <ModelRouterWidget
                route={state.route}
                liveness={state.liveness}
                localOnly={state.localOnly}
                onToggleLocalOnly={onToggleLocalOnly}
              />
              <SecuritySentinelWidget sentinel={state.sentinel} />
              <AgentMeshWidget agents={state.agents} peers={state.peers} />
              <PermissionModeWidget mode={state.permissionMode} onSet={onSetPermissionMode} />
              <TodoWidget todos={state.todos} />
              <SessionsWidget sessions={state.sessions} onResume={onResumeSession} />
              <ReplayPanel />
            </>
          )}
        </aside>
      </div>

      {state && <ApprovalsPanel approvals={state.approvals} onDecide={onDecide} now={now} />}

      <footer className="statusbar">
        {state && <LedgerStatusWidget ledger={state.ledger} onVerify={onVerify} />}
      </footer>

      <ReviewMascot />
    </div>
  );
}
