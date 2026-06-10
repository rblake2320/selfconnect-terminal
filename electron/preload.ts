import { contextBridge, ipcRenderer } from 'electron';
import type { SelfConnectApi } from './ipc-contract';
import {
  IPC,
  type BusEvent,
  type ReviewResult,
  type UiState,
  type ChainStatus,
  type SlashResult,
  type PermissionMode,
  type SessionSummary,
  type ResumeResult,
  type LedgerEntry,
} from '../src/shared/contracts';

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
