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
  onPtyData(handler: (data: string) => void): () => void;
  onBusEvent(handler: (evt: BusEvent) => void): () => void;
}

declare global {
  interface Window {
    selfconnect: SelfConnectApi;
  }
}
