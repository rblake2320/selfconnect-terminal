import React from 'react';
import type {
  CostSnapshot,
  ContextSnapshot,
  RouteDecision,
  ProviderLiveness,
  SentinelSnapshot,
  AgentInfo,
  ChainStatus,
  A2aPeer,
  TodoItem,
  SessionSummary,
  PermissionMode,
} from '../../shared/contracts';

function Card(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="card">
      <div className="card-title">{props.title}</div>
      <div className="card-body">{props.children}</div>
    </div>
  );
}

/** Widget 2 — Cost Kernel. */
export function CostKernelWidget(props: { cost: CostSnapshot }): React.JSX.Element {
  const { cost } = props;
  return (
    <Card title="Cost Kernel">
      <div className="kv">
        <span>Session spend</span>
        <span>${cost.sessionSpendUsd.toFixed(4)}</span>
      </div>
      <div className="kv">
        <span>Avoided cloud spend</span>
        <span className="good">${cost.avoidedSpendUsd.toFixed(4)}</span>
      </div>
      <div className="kv">
        <span>Per-call cap</span>
        <span>${cost.perCallCapUsd.toFixed(2)}</span>
      </div>
      <div className="kv">
        <span>Context efficiency</span>
        <span className="good">{cost.contextEfficiencyPct.toFixed(1)}%</span>
      </div>
      <div className="kv">
        <span>Tokens not resent</span>
        <span className="good">{cost.tokensNotResent.toLocaleString()}</span>
      </div>
      <div className="kv">
        <span>Cache / distill savings</span>
        <span className="good">
          ${cost.cacheSavingsUsd.toFixed(4)} / ${cost.distillationSavingsUsd.toFixed(4)}
        </span>
      </div>
      {cost.last && (
        <div className="kv">
          <span>
            <span className={`badge badge-${cost.last.kind.toLowerCase()}`}>{cost.last.kind}</span>{' '}
            {cost.last.inputTokens}in / {cost.last.outputTokens}out
          </span>
          <span>${cost.last.costUsd.toFixed(4)}</span>
        </div>
      )}
    </Card>
  );
}

/** Widget 3 — Context Gauge. */
export function ContextGaugeWidget(props: { context: ContextSnapshot }): React.JSX.Element {
  const { context } = props;
  return (
    <Card title="Context Gauge">
      <div className={`gauge gauge-${context.level}`}>
        <div className="gauge-fill" style={{ width: `${context.pressure}%` }} />
      </div>
      <div className="kv">
        <span>{context.level.toUpperCase()}</span>
        <span>
          {context.usedTokens} / {context.maxTokens} ({context.pressure.toFixed(0)}%)
        </span>
      </div>
      <div className="kv">
        <span>hot / warm / pinned</span>
        <span>
          {context.hotTokens} / {context.warmTokens} / {context.pinnedTokens}
        </span>
      </div>
      <div className="kv">
        <span>dedup hits / compactions</span>
        <span className="good">
          {context.dedupHits} / {context.compactions}
        </span>
      </div>
    </Card>
  );
}

/** Widget 4 — Model Router. */
export function ModelRouterWidget(props: {
  route: RouteDecision | null;
  liveness: ProviderLiveness[];
  localOnly: boolean;
  onToggleLocalOnly: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <Card title="Model Router">
      {props.route && (
        <>
          <div className="kv">
            <span>Active</span>
            <span>
              {props.route.provider}/{props.route.model}{' '}
              <span className={`tag tag-${props.route.tier}`}>{props.route.tier}</span>
            </span>
          </div>
          <div className="route-reason">{props.route.reason}</div>
        </>
      )}
      <label className="toggle">
        <input
          type="checkbox"
          checked={props.localOnly}
          onChange={(e) => props.onToggleLocalOnly(e.target.checked)}
        />
        Local-only mode
      </label>
      <div className="liveness">
        {props.liveness.map((l) => (
          <div key={l.kind} className="kv">
            <span>
              <span className={`dot ${l.alive ? 'dot-on' : 'dot-off'}`} /> {l.kind}
            </span>
            <span className="muted">{l.detail}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Widget 5 — Security Sentinel. */
export function SecuritySentinelWidget(props: { sentinel: SentinelSnapshot }): React.JSX.Element {
  const { sentinel } = props;
  return (
    <Card title="Security Sentinel">
      <div className="kv">
        <span>Redactions</span>
        <span>{sentinel.redactionCount}</span>
      </div>
      <div className="kv">
        <span>Risk findings</span>
        <span>{sentinel.riskCount}</span>
      </div>
      <div className="kv">
        <span>High / Critical</span>
        <span className={sentinel.criticalCount > 0 ? 'bad' : ''}>
          {sentinel.highCount} / {sentinel.criticalCount}
        </span>
      </div>
      <div className="findings">
        {sentinel.findings.slice(-4).map((f, i) => (
          <div key={i} className={`finding sev-${f.severity}`}>
            <code>{f.command.slice(0, 40)}</code>
            <span>{f.reason}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Widget 6 — Agent Mesh (v2: now also shows live A2A peers + chain health). */
export function AgentMeshWidget(props: {
  agents: AgentInfo[];
  peers?: A2aPeer[];
}): React.JSX.Element {
  const peers = props.peers ?? [];
  return (
    <Card title="Agent Mesh">
      {props.agents.map((a) => (
        <div key={a.agentId} className="kv">
          <span>
            {a.role}
            {a.readOnly && <span className="tag tag-ro">RO</span>}
          </span>
          <span className={`state state-${a.state}`}>{a.state}</span>
        </div>
      ))}
      {peers.length > 0 && (
        <>
          <div className="card-subtitle">A2A peers</div>
          {peers.map((p) => (
            <div key={p.peer} className="kv">
              <span>
                {p.peer}
                {p.allowlisted ? (
                  <span className="tag tag-ro">allow</span>
                ) : (
                  <span className="tag tag-premium">untrusted</span>
                )}
              </span>
              <span className={p.chainOk ? 'good' : 'bad'}>
                {p.sent}↑/{p.received}↓ {p.chainOk ? 'chain OK' : 'BROKEN'}
              </span>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

/** Widget 8 — Permission Mode (plan | ask | auto). */
export function PermissionModeWidget(props: {
  mode: PermissionMode;
  onSet: (mode: PermissionMode) => void;
}): React.JSX.Element {
  const modes: PermissionMode[] = ['plan', 'ask', 'auto'];
  return (
    <Card title="Permission Mode">
      <div className="seg">
        {modes.map((m) => (
          <button
            key={m}
            className={`seg-btn ${props.mode === m ? 'seg-on' : ''}`}
            onClick={() => props.onSet(m)}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="route-reason">
        {props.mode === 'plan' && 'plan: all mutating tools blocked'}
        {props.mode === 'ask' && 'ask: mutating tools require approval'}
        {props.mode === 'auto' && 'auto: low-risk runs; high/critical gated'}
      </div>
    </Card>
  );
}

/** Widget 9 — Todos. */
export function TodoWidget(props: { todos: TodoItem[] }): React.JSX.Element {
  const mark: Record<TodoItem['status'], string> = {
    pending: '○',
    in_progress: '◐',
    completed: '●',
  };
  return (
    <Card title="Todos">
      {props.todos.length === 0 && <div className="muted">no todos</div>}
      {props.todos.map((t) => (
        <div key={t.id} className="kv">
          <span className={`todo-${t.status}`}>
            {mark[t.status]} {t.content}
          </span>
        </div>
      ))}
    </Card>
  );
}

/** Widget 10 — Sessions (resume past sessions). */
export function SessionsWidget(props: {
  sessions: SessionSummary[];
  onResume: (sessionId: string) => void;
}): React.JSX.Element {
  return (
    <Card title="Sessions">
      {props.sessions.length === 0 && <div className="muted">no saved sessions</div>}
      {props.sessions.map((s) => (
        <div key={s.sessionId} className="session-row">
          <div className="kv">
            <span className="mono">{s.sessionId.slice(0, 18)}…</span>
            <span className={s.chainOk ? 'good' : 'bad'}>{s.chainOk ? 'OK' : 'BROKEN'}</span>
          </div>
          <div className="kv">
            <span className="muted">
              {s.eventCount} events · ${s.sessionSpendUsd.toFixed(4)}
            </span>
            <button className="btn btn-small" onClick={() => props.onResume(s.sessionId)}>
              Resume
            </button>
          </div>
        </div>
      ))}
    </Card>
  );
}

/** Widget 7 — Ledger Status (status bar). */
export function LedgerStatusWidget(props: {
  ledger: ChainStatus;
  onVerify: () => void;
}): React.JSX.Element {
  const { ledger } = props;
  return (
    <div className="ledger-status">
      <span className={`chip ${ledger.ok ? 'chip-ok' : 'chip-broken'}`}>
        Ledger {ledger.ok ? 'OK' : 'BROKEN'}
      </span>
      <span className="muted">{ledger.entries} entries</span>
      <span className="muted mono">…{ledger.lastHash.slice(-12)}</span>
      <button className="btn btn-small" onClick={props.onVerify}>
        Verify chain
      </button>
    </div>
  );
}
