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
 */
export function TerminalView(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Code", "Consolas", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0b0f14', foreground: '#cfe3f7' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
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

    const offData = window.selfconnect.onPtyData((data) => term.write(data));

    const resize = () => {
      fit.fit();
      window.selfconnect.ptyResize(term.cols, term.rows);
    };
    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      offData();
      onInput.dispose();
      term.dispose();
    };
  }, []);

  return <div className="terminal-host" ref={hostRef} />;
}
