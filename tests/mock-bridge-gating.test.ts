import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Problem 7 regression tests.
 *
 * The simulated browser-preview mock bridge must NEVER activate inside Electron.
 * In the real app, if the preload failed to expose window.selfconnect, the
 * renderer must report 'fatal' (caller shows a loud error screen) rather than
 * silently installing the simulation. These tests pin all four cases.
 *
 * mock-bridge.ts reads a compile-time global __SELFCONNECT_PREVIEW__ and the
 * runtime navigator.userAgent, so each test sets up the relevant globals,
 * imports the module fresh, and tears them down.
 */

type BridgeMode = 'real' | 'mock' | 'fatal';

interface MutableGlobal {
  window?: { selfconnect?: unknown };
  navigator?: { userAgent: string };
  __SELFCONNECT_PREVIEW__?: boolean;
}

const g = globalThis as unknown as MutableGlobal;

async function loadFresh(): Promise<{
  installMockBridgeIfNeeded: () => BridgeMode;
  isRunningUnderElectron: () => boolean;
}> {
  vi.resetModules();
  return import('../src/renderer/mock-bridge');
}

function setEnv(opts: { preview?: boolean; userAgent?: string; hasBridge?: boolean }): void {
  g.__SELFCONNECT_PREVIEW__ = opts.preview ?? false;
  g.window = opts.hasBridge ? { selfconnect: {} } : {};
  g.navigator = { userAgent: opts.userAgent ?? 'Mozilla/5.0 (browser)' };
}

describe('Problem 7: mock-bridge install gating', () => {
  beforeEach(() => {
    delete g.window;
    delete g.navigator;
    delete g.__SELFCONNECT_PREVIEW__;
  });

  afterEach(() => {
    delete g.window;
    delete g.navigator;
    delete g.__SELFCONNECT_PREVIEW__;
    vi.useRealTimers();
  });

  it("uses the REAL bridge when window.selfconnect exists (even in a preview build)", async () => {
    setEnv({ preview: true, hasBridge: true });
    const { installMockBridgeIfNeeded } = await loadFresh();
    expect(installMockBridgeIfNeeded()).toBe('real');
    expect((g.window as { selfconnect?: unknown }).selfconnect).toBeDefined();
  });

  it('installs the MOCK only in a preview build that is NOT Electron', async () => {
    vi.useFakeTimers(); // startStreaming() schedules intervals/timeouts
    setEnv({ preview: true, userAgent: 'Mozilla/5.0 (browser)', hasBridge: false });
    const { installMockBridgeIfNeeded } = await loadFresh();
    expect(installMockBridgeIfNeeded()).toBe('mock');
    expect((g.window as { selfconnect?: unknown }).selfconnect).toBeDefined();
  });

  it('is FATAL (never mock) inside Electron when the preload bridge is missing — even in a preview build', async () => {
    setEnv({
      preview: true,
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Electron/31.0.0 SelfConnect',
      hasBridge: false,
    });
    const { installMockBridgeIfNeeded } = await loadFresh();
    expect(installMockBridgeIfNeeded()).toBe('fatal');
    expect((g.window as { selfconnect?: unknown }).selfconnect).toBeUndefined();
  });

  it('is FATAL in the real (non-preview) build with no bridge, regardless of user agent', async () => {
    setEnv({ preview: false, userAgent: 'Mozilla/5.0 (browser)', hasBridge: false });
    const { installMockBridgeIfNeeded } = await loadFresh();
    expect(installMockBridgeIfNeeded()).toBe('fatal');
    expect((g.window as { selfconnect?: unknown }).selfconnect).toBeUndefined();
  });

  it('detects Electron from the user agent', async () => {
    setEnv({ userAgent: 'foo Electron/31.0.0 bar' });
    const { isRunningUnderElectron } = await loadFresh();
    expect(isRunningUnderElectron()).toBe(true);
  });

  it('does not mistake a plain browser for Electron', async () => {
    setEnv({ userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/120 Safari/537' });
    const { isRunningUnderElectron } = await loadFresh();
    expect(isRunningUnderElectron()).toBe(false);
  });
});
