import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installMockBridgeIfNeeded } from './mock-bridge';
import './styles.css';

// Obtain the bridge. In Electron the preload provides window.selfconnect ('real').
// In the static browser-preview build (and only there) a simulated bridge is
// installed ('mock'). If we are in the real app but the preload bridge is
// missing, the build is broken — render a loud fatal screen instead of silently
// simulating (Problem 7).
const bridgeMode = installMockBridgeIfNeeded();

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');
const root = createRoot(container);

if (bridgeMode === 'fatal') {
  root.render(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.75rem',
        padding: '2rem',
        background: '#1a0000',
        color: '#ff6b6b',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>
        FATAL: preload bridge missing — build is broken
      </div>
      <div style={{ maxWidth: 640, lineHeight: 1.5, color: '#ffb3b3' }}>
        The Electron preload did not expose <code>window.selfconnect</code>, so there is no
        connection to the real daemon. This is a broken build, not a preview — the app will
        NOT fall back to a simulation. Rebuild with <code>npm run build</code> and confirm
        <code> dist-electron/electron/preload.js</code> loads (it must require only{' '}
        <code>electron</code> under <code>sandbox: true</code>). See{' '}
        <code>docs/WINDOWS-FINDINGS.md</code> → Problem 7.
      </div>
    </div>,
  );
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
