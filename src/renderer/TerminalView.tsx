import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * The main terminal surface. Renders an xterm.js terminal wired to the daemon's
 * real PTY over the narrow window.selfconnect bridge.
 *
 * App commands run from the separate command field. Every terminal keystroke,
 * including URLs and CLI agent slash commands, goes to the real PTY.
 *
 * Clipboard:
 *   Copy  — Ctrl+C (with selection) or right-click: xterm selection → IPC bridge
 *            → Electron clipboard. Ctrl+C with no selection passes through as ^C.
 *   Paste — Ctrl+V or right-click reads the Electron clipboard through IPC.
 *            The input queue keeps a following Enter behind the paste, and
 *            term.paste preserves xterm bracketed-paste handling.
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
      screenReaderMode: true,
      theme: { background: '#0b0f14', foreground: '#cfe3f7' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.textarea?.setAttribute('aria-label','SelfConnect terminal input');
    fit.fit();

    // The PTY owns every keystroke, including URLs and agent slash commands.
    // SelfConnect commands have a separate explicit UI field.
    let inputQueue = Promise.resolve();
    let deliveringPaste = false;
    const onInput = term.onData((data) => {
      if(deliveringPaste)window.selfconnect.ptyInput(data);
      else inputQueue=inputQueue.then(()=>window.selfconnect.ptyInput(data));
    });
    const pasteClipboard = () => {
      inputQueue=inputQueue.then(async()=>{
        try {
          const text=await window.selfconnect.clipboardRead();
          deliveringPaste=true;
          try { if(text)term.paste(text); } finally { deliveringPaste=false; }
        } catch { term.write('\r\n[Clipboard could not be read.]\r\n'); }
      });
    };

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
    // Explicit clipboard IPC is needed because this app has no Edit menu.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (!(e.ctrlKey || e.metaKey)) return true;
      if(e.key.toLowerCase()==='v'){
        e.preventDefault();pasteClipboard();return false;
      }
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
      pasteClipboard();
    };
    host.addEventListener('contextmenu', onContextMenu);

    const resize = () => {
      fit.fit();
      window.selfconnect.ptyResize(term.cols, term.rows);
    };
    resize();
    window.addEventListener('resize', resize);
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      window.removeEventListener('resize', resize);
      observer.disconnect();
      host.removeEventListener('contextmenu', onContextMenu);
      offData();
      onInput.dispose();
      term.dispose();
    };
  }, []);

  return <div className="terminal-host" ref={hostRef} />;
}
