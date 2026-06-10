import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Daemon } from '../src/daemon/daemon';
import { PtyManager } from '../src/daemon/pty-manager';
import {
  IPC,
  PtyInputSchema,
  PtyResizeSchema,
  ReviewRequestSchema,
  ApprovalDecisionSchema,
  LocalOnlyToggleSchema,
  SlashCommandSchema,
  PermissionModeSetSchema,
  ResumeSessionSchema,
} from '../src/shared/contracts';

// Provider keys live ONLY in the daemon process env (HARD RULE 1).
loadDotenv();

let win: BrowserWindow | null = null;
let daemon: Daemon | null = null;
let pty: PtyManager | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0b0f14',
    webPreferences: {
      // HARD SECURITY RULES 2/3/4: lock down the renderer.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.js'),
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../../dist/renderer/index.html'));
  }
}

function wireDaemon(): void {
  daemon = new Daemon();

  // Bridge every bus event to the renderer (it only ever sees derived data).
  daemon.bus.on((evt) => {
    win?.webContents.send(IPC.busEvent, evt);
  });

  // Real PTY via node-pty / ConPTY.
  pty = new PtyManager({ cwd: process.cwd(), cols: 120, rows: 32 });
  pty.onData((data) => {
    daemon?.ingestTerminalOutput(data);
    win?.webContents.send(IPC.ptyData, data);
  });
  daemon.setTerminalContext(pty.cwd, pty.shellPath);
  void pty.spawn();

  // v2: bring up the A2A transport (file/ws/off per config). Best-effort.
  void daemon.a2aStart().catch(() => {});
}

function registerIpc(): void {
  // pty input (validated). We also inspect submitted lines for risk.
  ipcMain.on(IPC.ptyInput, (_e, raw) => {
    const { data } = PtyInputSchema.parse(raw);
    if (data.includes('\r') || data.includes('\n')) {
      daemon?.inspectInput(data.replace(/[\r\n]+$/, ''));
    }
    pty?.write(data);
  });

  ipcMain.on(IPC.ptyResize, (_e, raw) => {
    const { cols, rows } = PtyResizeSchema.parse(raw);
    pty?.resize(cols, rows);
  });

  ipcMain.handle(IPC.reviewRun, async (_e, raw) => {
    const { mode } = ReviewRequestSchema.parse(raw);
    return daemon!.runReview(mode);
  });

  ipcMain.handle(IPC.approvalDecide, async (_e, raw) => {
    const { id, approve } = ApprovalDecisionSchema.parse(raw);
    daemon!.decideApproval(id, approve);
  });

  ipcMain.handle(IPC.localOnlySet, async (_e, raw) => {
    const { localOnly } = LocalOnlyToggleSchema.parse(raw);
    return daemon!.setLocalOnly(localOnly);
  });

  ipcMain.handle(IPC.ledgerVerify, async () => daemon!.verifyLedger());

  ipcMain.handle(IPC.stateSnapshot, async () => daemon!.snapshotAsync());

  // v2: slash commands are intercepted in the renderer and dispatched here so
  // they NEVER reach the PTY. The daemon parses, audits (command.slash), and
  // returns formatted text + optional scrollback/clear directives.
  ipcMain.handle(IPC.slashRun, async (_e, raw) => {
    const { line } = SlashCommandSchema.parse(raw);
    return daemon!.dispatchSlash(line);
  });

  ipcMain.handle(IPC.permissionModeSet, async (_e, raw) => {
    const { mode } = PermissionModeSetSchema.parse(raw);
    daemon!.setPermissionMode(mode);
    return daemon!.snapshot();
  });

  ipcMain.handle(IPC.sessionsList, async () => daemon!.listSessions());

  ipcMain.handle(IPC.sessionResume, async (_e, raw) => {
    const { sessionId } = ResumeSessionSchema.parse(raw);
    return daemon!.resumeSession(sessionId);
  });
}

app.whenReady().then(() => {
  wireDaemon();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // v2: persist a final session snapshot so the session can be resumed later.
  daemon?.persistSnapshot();
  pty?.dispose();
  if (process.platform !== 'darwin') app.quit();
});
