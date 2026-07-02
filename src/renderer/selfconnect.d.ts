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
} from '../shared/contracts';

/**
 * Renderer-side declaration of the narrow contextBridge surface. Mirrors
 * electron/ipc-contract.ts SelfConnectApi (which lives in the daemon tsconfig).
 */
export interface SelfConnectApi {
  ptyInput(data: string): void;
  ptyResize(cols: number, rows: number): void;
  runReview(mode: string): Promise<ReviewResult>;
  decideApproval(id: string, approve: boolean): Promise<void>;
  setLocalOnly(localOnly: boolean): Promise<UiState>;
  verifyLedger(): Promise<ChainStatus>;
  getState(): Promise<UiState>;
  slashRun(line: string): Promise<SlashResult>;
  setPermissionMode(mode: PermissionMode): Promise<UiState>;
  listSessions(): Promise<SessionSummary[]>;
  resumeSession(sessionId: string): Promise<ResumeResult>;
  replayEvents(sessionId?: string): Promise<LedgerEntry[]>;
  labLatest(): Promise<LabReport | null>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  onPtyData(handler: (data: string) => void): () => void;
  onBusEvent(handler: (evt: BusEvent) => void): () => void;
}

declare global {
  interface Window {
    selfconnect: SelfConnectApi;
  }

  /**
   * Compile-time flag injected by Vite (see vite.config.ts `define`). True ONLY
   * in the static browser-preview build (SELFCONNECT_PREVIEW=1). The real
   * Electron renderer bundle is built with this false, so the simulated mock
   * bridge is dead-code-eliminated and can never run inside the app.
   */
  const __SELFCONNECT_PREVIEW__: boolean;
}
