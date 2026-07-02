import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * The main terminal surface. Renders an xterm.js terminal wired to the daemon's
 * real PTY over the narrow window.selfconnect bridge.
 *
 * v2: slash commands are intercepted HERE before they reach the PTY. While the
 * user is typing a line that begins with '/', keystrokes are buffered + locally
 * echoed (never sent to the shell). On Enter the buffered line is dispatched via
 * `slashRun` (daemon-side: parsed, identity-stamped, audited as command.slash)
 * and the formatted result is printed back into the terminal view. /clear wipes
 * the screen; /resume repaints the restored scrollback.
 *
 * Clipboard:
 *   Copy  — Ctrl+C (with selection) or right-click: xterm selection → IPC bridge
 *            → Electron clipboard. Ctrl+C with no selection passes through as ^C.
 *   Paste — Ctrl+V: xterm handles natively (paste event on its internal textarea →
 *            onData → PTY). Right-click with no selection: IPC bridge reads
 *            clipboard → term.paste() which applies bracketed-paste markers exactly
 *            as xterm would. We do NOT intercept Ctrl+V or the paste event — letting
 *            xterm own that path removes an async IPC round-trip from the hot path
 *            and avoids silent failures when clipboardData is empty.
 */
export function TerminalView(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Code", "Consolas", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0b0f14', foreground: '#cfe3f7' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const BACKSPACE = String.fromCharCode(127);
    const CTRL_C = String.fromCharCode(3);

    // Slash-line capture state. We only "capture" once a line is known to start
    // with '/'; ordinary shell input passes straight through to the PTY.
    let capturing = false;
    let buffer = '';

    const write = (s: string) => term.write(s);
    const writeln = (s: string) => term.write(s.replace(/\n/g, '\r\n') + '\r\n');

    const finishSlash = async () => {
      const line = buffer;
      capturing = false;
      buffer = '';
      write('\r\n');
      const result = await window.selfconnect.slashRun(line);
      if (result.clear) term.clear();
      if (result.scrollback && result.scrollback.length > 0) {
        term.clear();
        for (const l of result.scrollback) writeln(l);
      }
      if (result.output) writeln(result.output);
    };

    const onInput = term.onData((data) => {
      // Begin capturing if a fresh line starts with '/'.
      if (!capturing && data === '/') {
        capturing = true;
        buffer = '/';
        write('/');
        return;
      }
      if (!capturing) {
        window.selfconnect.ptyInput(data);
        return;
      }
      // --- capturing a slash line ---
      if (data === '\r' || data === '\n') {
        void finishSlash();
        return;
      }
      if (data === BACKSPACE || data === '\b') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          write('\b \b');
        }
        if (buffer.length === 0) capturing = false;
        return;
      }
      if (data === CTRL_C) {
        capturing = false;
        buffer = '';
        write('^C\r\n');
        return;
      }
      // Printable.
      buffer += data;
      write(data);
    });

    const offData = window.selfconnect.onPtyData((data) => {
      term.write(data);
    });

    // --- Copy / paste -------------------------------------------------------
    // Copy uses the IPC bridge (Electron clipboard module in the main process)
    // because xterm's selection is not a DOM selection so the browser's own
    // copy mechanism would grab an empty string.
    const copyText = async (text: string): Promise<void> => {
      if (!text) return;
      try {
        await window.selfconnect.clipboardWrite(text);
      } catch {
        try {
          await navigator.clipboard.writeText(text);
        } catch { /* nothing more we can do */ }
      }
    };

    // Ctrl+C: copy selection when present; otherwise pass through as interrupt.
    // Ctrl+V is intentionally NOT intercepted here — xterm handles it natively
    // via the paste event on its internal textarea, which fires onData → PTY.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (!(e.ctrlKey || e.metaKey)) return true;
      if (e.key.toLowerCase() === 'c') {
        const sel = term.getSelection();
        if (sel) {
          void copyText(sel);
          return false; // consume; don't also send ^C
        }
      }
      return true;
    });

    // Right-click: PuTTY-style — copy if text is selected, paste if not.
    // Paste goes through term.paste() so xterm applies bracketed-paste markers
    // exactly as it would for a native Ctrl+V paste.
    const onContextMenu = async (e: MouseEvent): Promise<void> => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        void copyText(sel);
        return;
      }
      try {
        const text = await window.selfconnect.clipboardRead();
        if (text) term.paste(text);
      } catch {
        try {
          const text = await navigator.clipboard.readText();
          if (text) term.paste(text);
        } catch { /* clipboard unavailable */ }
      }
    };
    host.addEventListener('contextmenu', onContextMenu);

    const resize = () => {
      fit.fit();
      window.selfconnect.ptyResize(term.cols, term.rows);
    };
    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      host.removeEventListener('contextmenu', onContextMenu);
      offData();
      onInput.dispose();
      term.dispose();
    };
  }, []);

  return <div className="terminal-host" ref={hostRef} />;
}
