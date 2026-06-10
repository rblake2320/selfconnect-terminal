import { contextBridge, ipcRenderer } from 'electron';
import type { SelfConnectApi } from './ipc-contract';
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
 * IPC channel names are INLINED here (not imported from ../src/shared/contracts)
 * on purpose. This preload runs under `sandbox: true`, where Electron's
 * restricted `require` resolves only `electron` and a few polyfilled builtins —
 * NOT arbitrary relative file-path modules. A runtime `require("../src/shared/
 * contracts")` throws inside the sandbox, aborting the preload before
 * contextBridge.exposeInMainWorld runs, leaving window.selfconnect undefined.
 * These values MUST stay byte-for-byte identical to IPC in src/shared/contracts.ts
 * (a test asserts this).
 */
const IPC = {
  ptyInput: 'pty:input',
  ptyResize: 'pty:resize',
  reviewRun: 'review:run',
  approvalDecide: 'approval:decide',
  localOnlySet: 'localonly:set',
  ledgerVerify: 'ledger:verify',
  stateSnapshot: 'state:snapshot',
  slashRun: 'slash:run',
  permissionModeSet: 'permission:set',
  sessionsList: 'sessions:list',
  sessionResume: 'session:resume',
  replayEvents: 'replay:events',
  labLatest: 'lab:latest',
  busEvent: 'bus:event',
  ptyData: 'pty:data',
} as const;

/**
 * Preload. Runs with context isolation; exposes ONLY the narrow typed API
 * (HARD SECURITY RULE 5). No Node globals, no fs, no ipcRenderer leak to the
 * renderer — just these functions.
 */
const api: SelfConnectApi = {
  ptyInput(data: string): void {
    ipcRenderer.send(IPC.ptyInput, { data });
  },
  ptyResize(cols: number, rows: number): void {
    ipcRenderer.send(IPC.ptyResize, { cols, rows });
  },
  runReview(mode: string): Promise<ReviewResult> {
    return ipcRenderer.invoke(IPC.reviewRun, { mode }) as Promise<ReviewResult>;
  },
  decideApproval(id: string, approve: boolean): Promise<void> {
    return ipcRenderer.invoke(IPC.approvalDecide, { id, approve }) as Promise<void>;
  },
  setLocalOnly(localOnly: boolean): Promise<UiState> {
    return ipcRenderer.invoke(IPC.localOnlySet, { localOnly }) as Promise<UiState>;
  },
  verifyLedger(): Promise<ChainStatus> {
    return ipcRenderer.invoke(IPC.ledgerVerify) as Promise<ChainStatus>;
  },
  getState(): Promise<UiState> {
    return ipcRenderer.invoke(IPC.stateSnapshot) as Promise<UiState>;
  },
  slashRun(line: string): Promise<SlashResult> {
    return ipcRenderer.invoke(IPC.slashRun, { line }) as Promise<SlashResult>;
  },
  setPermissionMode(mode: PermissionMode): Promise<UiState> {
    return ipcRenderer.invoke(IPC.permissionModeSet, { mode }) as Promise<UiState>;
  },
  listSessions(): Promise<SessionSummary[]> {
    return ipcRenderer.invoke(IPC.sessionsList) as Promise<SessionSummary[]>;
  },
  resumeSession(sessionId: string): Promise<ResumeResult> {
    return ipcRenderer.invoke(IPC.sessionResume, { sessionId }) as Promise<ResumeResult>;
  },
  replayEvents(sessionId?: string): Promise<LedgerEntry[]> {
    return ipcRenderer.invoke(IPC.replayEvents, { sessionId }) as Promise<LedgerEntry[]>;
  },
  labLatest(): Promise<LabReport | null> {
    return ipcRenderer.invoke(IPC.labLatest) as Promise<LabReport | null>;
  },
  onPtyData(handler: (data: string) => void): () => void {
    const listener = (_e: unknown, data: string) => handler(data);
    ipcRenderer.on(IPC.ptyData, listener);
    return () => ipcRenderer.off(IPC.ptyData, listener);
  },
  onBusEvent(handler: (evt: BusEvent) => void): () => void {
    const listener = (_e: unknown, evt: BusEvent) => handler(evt);
    ipcRenderer.on(IPC.busEvent, listener);
    return () => ipcRenderer.off(IPC.busEvent, listener);
  },
};

contextBridge.exposeInMainWorld('selfconnect', api);
