import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installMockBridgeIfNeeded } from './mock-bridge';
import './styles.css';

// In a browser (no Electron preload), install a simulated window.selfconnect so
// the UI is fully interactive. No-op under real Electron, where the bridge exists.
installMockBridgeIfNeeded();

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
