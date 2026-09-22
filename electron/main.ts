import { ComputerToolInputSchema } from '../src/daemon/computer-use';
import { nativeMeshState, nativeWindows } from './native-mesh';
import { app, BrowserWindow, ipcMain, clipboard, Menu, dialog } from 'electron';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { loadConfig } from '../src/daemon/config';
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
  ReplayEventsSchema,
  ClipboardWriteSchema,
} from '../src/shared/contracts';

// Provider keys live ONLY in the daemon process env (HARD RULE 1).
loadDotenv();
app.setName('SelfConnect Terminal');
if (process.env.SELFCONNECT_USER_DATA_DIR) app.setPath('userData', process.env.SELFCONNECT_USER_DATA_DIR);

let win: BrowserWindow | null = null;
let daemon: Daemon | null = null;
let pty: PtyManager | null = null;
let unsubscribeRenderer: (() => void) | null = null;
let saveTimer: ReturnType<typeof setInterval> | null = null;
let outputChanged = false;
function settingsPath(): string { return join(app.getPath('userData'),'settings.json'); }
function savePreference(localOnly: boolean): void {
  mkdirSync(app.getPath('userData'),{recursive:true});
  const file=settingsPath();writeFileSync(file+'.tmp',JSON.stringify({localOnly}));renameSync(file+'.tmp',file);
}

function sendToRenderer(channel: string, data: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, data);
}

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

  win.on('closed', () => {
    win = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../../dist/renderer/index.html'));
  }
}

function wireDaemon(): void {
  const cfg = loadConfig();
  if(!process.env.SELFCONNECT_MCP_CONFIG)cfg.mcpConfigPath=join(app.getPath('userData'),'mcp-servers.json');
  if (process.env.SELFCONNECT_LOCAL_ONLY === undefined && existsSync(settingsPath())) {
    const settings=z.object({localOnly:z.boolean()}).parse(JSON.parse(readFileSync(settingsPath(),'utf8')));
    cfg.localOnly=settings.localOnly;
  }
  // Writable user state is independent of install location or the shell cwd.
  const locations = {
    ledgerPath:['SELFCONNECT_LEDGER_PATH','ledger.jsonl'], sessionsDir:['SELFCONNECT_SESSIONS_DIR','sessions'],
    a2aDir:['SELFCONNECT_A2A_DIR','a2a'], checkpointsDir:['SELFCONNECT_CHECKPOINTS_DIR','checkpoints'],
    contextStoreDir:['SELFCONNECT_CONTEXT_STORE_DIR','context-store'], scratchpadPath:['SELFCONNECT_SCRATCHPAD_PATH','scratchpad.json'],
    playbooksPath:['SELFCONNECT_PLAYBOOKS_PATH','playbooks.jsonl'], failuresPath:['SELFCONNECT_FAILURES_PATH','failures.jsonl'],
    keysDir:['SELFCONNECT_KEYS_DIR','keys'], checkpointsLedgerPath:['SELFCONNECT_CHECKPOINTS_LEDGER','ledger-checkpoints.jsonl'],
    delegationsPath:['SELFCONNECT_DELEGATIONS_PATH','delegations.jsonl'],
  } as const;
  for(const key of Object.keys(locations) as (keyof typeof locations)[]) {
    const [variable,file]=locations[key];if(!process.env[variable])cfg[key]=join(app.getPath('userData'),'data',file);
  }
  daemon = new Daemon(cfg);

  // Bridge every bus event to the renderer (it only ever sees derived data).
  unsubscribeRenderer = daemon.bus.on((evt) => {
    sendToRenderer(IPC.busEvent, evt);
  });

  // Real PTY via node-pty / ConPTY.
  pty = new PtyManager({ cwd: process.cwd(), cols: 120, rows: 32 });
  pty.onData((data) => {
    outputChanged = true;
    daemon?.ingestTerminalOutput(data);
    sendToRenderer(IPC.ptyData, data);
  });
  daemon.setTerminalContext(pty.cwd, pty.shellPath);
  void pty.spawn().catch(() => sendToRenderer(IPC.ptyData,'\r\nTERMINAL ERROR: The shell could not start. Check the shell and node-pty installation.\r\n'));
  pty.onExit((code) => sendToRenderer(IPC.ptyData,`\r\n[Shell exited ${code}. Reopen SelfConnect Terminal to start a new shell.]\r\n`));
  daemon.persistSnapshot();
  saveTimer=setInterval(()=>{if(!outputChanged)return;try{daemon?.persistSnapshot();outputChanged=false;}catch{sendToRenderer(IPC.ptyData,'\r\nSESSION SAVE FAILED: Check available disk space and file permissions.\r\n');}},10000);

  // v2: bring up the A2A transport (file/ws/off per config). Best-effort.
  void daemon.a2aStart().catch(() => {});
}

function registerIpc(): void {
  ipcMain.handle(IPC.computerUse,async(_e,raw)=>{
    const command=z.discriminatedUnion('operation',[z.object({operation:z.literal('windows')}).strict(),z.object({operation:z.literal('list')}).strict(),z.object({operation:z.literal('stop'),sessionId:z.string().uuid()}).strict(),z.object({operation:z.literal('image'),sessionId:z.string().uuid()}).strict(),...ComputerToolInputSchema.options]).parse(raw);
    if(!win)throw Error('Window unavailable');
    daemon!.configureComputerUse(app.isPackaged?join(process.resourcesPath,'computer-use-driver.py'):join(app.getAppPath(),'scripts','computer-use-driver.py'),join(app.getPath('userData'),'computer-evidence'),Number(win.getNativeWindowHandle().readBigUInt64LE()));
    if(command.operation==='windows')return nativeWindows();
    if(command.operation==='list')return daemon!.computerSessions();
    if(command.operation==='stop')return daemon!.computerStop(command.sessionId);
    if(command.operation==='image')return daemon!.computerImage(command.sessionId);
    return daemon!.computerInvoke(command);
  });
  ipcMain.handle(IPC.nativeMesh, async (_e, raw) => {
    const {join}=z.object({join:z.boolean()}).strict().parse(raw);
    if(!win || win.isDestroyed())throw new Error('Terminal window unavailable.');
    const handle=win.getNativeWindowHandle();
    return nativeMeshState({hwnd:Number(handle.readBigUInt64LE()),pid:process.pid,title:win.getTitle()},join);
  });
  ipcMain.handle(IPC.jevPreview, async () => daemon!.previewJev());
  ipcMain.handle(IPC.jevAnalyze, async (_e,raw) => {
    const value=z.object({snapshotId:z.string().uuid(),approved:z.literal(true)}).strict().parse(raw);
    return daemon!.analyzeJev(value.snapshotId,value.approved);
  });
  // pty input (validated). We also inspect submitted lines for risk.
  ipcMain.on(IPC.ptyInput, (_e, raw) => {
    const parsed = PtyInputSchema.safeParse(raw); if(!parsed.success)return;
    const { data } = parsed.data;
    if (data.includes('\r') || data.includes('\n')) {
      daemon?.inspectInput(data.replace(/[\r\n]+$/, ''));
    }
    pty?.write(data);
  });

  ipcMain.on(IPC.ptyResize, (_e, raw) => {
    const parsed = PtyResizeSchema.safeParse(raw); if(!parsed.success)return;
    const { cols, rows } = parsed.data;
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
    savePreference(localOnly);
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
  ipcMain.handle(IPC.sessionHistory, async (_e,raw)=>{
    const {sessionId}=ResumeSessionSchema.parse(raw);
    return daemon!.sessionHistory(sessionId);
  });

  ipcMain.handle(IPC.replayEvents, async (_e, raw) => {
    const { sessionId } = ReplayEventsSchema.parse(raw ?? {});
    return daemon!.replayEvents(sessionId);
  });

  // v3c: latest harness-lab report for the renderer's LabPanel (polled).
  ipcMain.handle(IPC.labLatest, async () => daemon!.latestLabReport());

  // Clipboard. Main owns the OS clipboard so the sandboxed renderer doesn't
  // depend on navigator.clipboard (which is blocked under sandbox: true).
  ipcMain.handle(IPC.clipboardRead, async () => clipboard.readText());

  ipcMain.handle(IPC.clipboardWrite, async (_e, raw) => {
    const { text } = ClipboardWriteSchema.parse(raw);
    await clipboard.writeText(text);
  });
}

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.whenReady().then(() => {
  if(!primary)return;
  // Native SelfConnect readback needs the Windows accessibility tree.
  app.setAccessibilitySupportEnabled(true);
  // Remove the default application menu so Electron's Edit→Copy/Paste
  // accelerators don't race against xterm's IPC-based clipboard handling.
  Menu.setApplicationMenu(null);
  wireDaemon();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error=>{
  dialog.showErrorBox('SelfConnect Terminal could not start', error instanceof Error ? error.message : 'Unknown startup error');
  app.exit(1);
});

let stopped = false;
function shutdown(): void {
  if(stopped)return;
  stopped=true;
  if(saveTimer)clearInterval(saveTimer);
  unsubscribeRenderer?.();
  unsubscribeRenderer = null;
  daemon?.computerClose();
  daemon?.mcp.closeAll();
  pty?.dispose();
  pty = null;
  // v2: persist a final session snapshot so the session can be resumed later.
  try {
    daemon?.persistSnapshot();
  } catch (error) {
    console.error('Failed to persist session during shutdown', error);
    app.exit(1);
    return;
  }
}
app.on('before-quit', shutdown);
app.on('window-all-closed', () => {
  shutdown();
  if (process.platform !== 'darwin') app.quit();
});
