import { platform } from 'node:os';
import type { IPty } from 'node-pty';

/**
 * PTY manager — the ONLY module that imports node-pty (HARD constraint: isolate
 * the native dependency so tests never require the compiled binary). On Windows
 * this drives ConPTY; on POSIX it spawns the user's shell.
 *
 * node-pty is imported lazily inside `spawn` so that merely importing this
 * module (e.g. for type-checking or tooling) does not load the native addon.
 */

export interface PtyManagerOptions {
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
}

export type PtyDataHandler = (data: string) => void;
export type PtyExitHandler = (code: number, signal?: number) => void;

function defaultShell(): string {
  if (platform() === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

export class PtyManager {
  private pty: IPty | null = null;
  private readonly shell: string;
  private dataHandlers = new Set<PtyDataHandler>();
  private exitHandlers = new Set<PtyExitHandler>();

  constructor(private readonly opts: PtyManagerOptions) {
    this.shell = opts.shell || defaultShell();
  }

  get shellPath(): string {
    return this.shell;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  async spawn(): Promise<void> {
    if (this.pty) return;
    // Lazy native import keeps the addon out of non-PTY code paths.
    const nodePty = await import('node-pty');
    this.pty = nodePty.spawn(this.shell, [], {
      name: 'xterm-color',
      cols: this.opts.cols,
      rows: this.opts.rows,
      cwd: this.opts.cwd,
      env: process.env as { [key: string]: string },
    });
    this.pty.onData((data) => {
      for (const h of this.dataHandlers) h(data);
    });
    this.pty.onExit(({ exitCode, signal }) => {
      for (const h of this.exitHandlers) h(exitCode, signal);
    });
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.pty?.resize(cols, rows);
  }

  onData(handler: PtyDataHandler): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onExit(handler: PtyExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  dispose(): void {
    try {
      this.pty?.kill();
    } catch {
      /* ignore */
    }
    this.pty = null;
  }
}
