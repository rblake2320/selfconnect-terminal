import type {
  BusEvent,
  ReviewResult,
  UiState,
  ChainStatus,
  SlashResult,
  PermissionMode,
  SessionSummary,
  ResumeResult,
  LedgerEntry,
  LabReport,
} from '../src/shared/contracts';

/**
 * The narrow, typed contextBridge surface exposed to the renderer as
 * `window.selfconnect` (HARD SECURITY RULE 5). This is the ONLY capability the
 * untrusted renderer has. No Node, no fs, no keys — only these methods, all of
 * which are Zod-validated on the daemon side before doing anything.
 */
export interface SelfConnectApi {
  /** Send keystrokes to the PTY. */
  ptyInput(data: string): void;
  /** Resize the PTY. */
  ptyResize(cols: number, rows: number): void;
  /** Trigger a review run (snapshot -> redact -> route -> review). */
  runReview(mode: string): Promise<ReviewResult>;
  /** Resolve a pending approval. */
  decideApproval(id: string, approve: boolean): Promise<void>;
  /** Toggle local-only mode. */
  setLocalOnly(localOnly: boolean): Promise<UiState>;
  /** Verify the audit ledger hash chain. */
  verifyLedger(): Promise<ChainStatus>;
  /** Pull the full aggregate UI state. */
  getState(): Promise<UiState>;
  /** v2: dispatch a slash command (daemon-side, audited; never hits the PTY). */
  slashRun(line: string): Promise<SlashResult>;
  /** v2: set the permission mode (plan|ask|auto). Returns the new state. */
  setPermissionMode(mode: PermissionMode): Promise<UiState>;
  /** v2: list resumable sessions. */
  listSessions(): Promise<SessionSummary[]>;
  /** v2: resume a past session; returns restored scrollback. */
  resumeSession(sessionId: string): Promise<ResumeResult>;
  /** v3b: read-only ledger slice for the flight-recorder replay panel. */
  replayEvents(sessionId?: string): Promise<LedgerEntry[]>;
  /** v3c: the most recent harness-lab report (D6), or null. */
  labLatest(): Promise<LabReport | null>;
  /** Subscribe to raw PTY byte stream. Returns an unsubscribe fn. */
  onPtyData(handler: (data: string) => void): () => void;
  /** Subscribe to identity-stamped bus events. Returns an unsubscribe fn. */
  onBusEvent(handler: (evt: BusEvent) => void): () => void;
}

declare global {
  interface Window {
    selfconnect: SelfConnectApi;
  }
}
