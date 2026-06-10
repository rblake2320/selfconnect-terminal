import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentKeystore, verifySignature, publicKeyFromHex } from '../src/daemon/agent-keys';

describe('AgentKeystore (B2.1 Ed25519 identity keys)', () => {
  let dir: string;
  let ks: AgentKeystore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-keys-'));
    ks = new AgentKeystore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('mints a keypair on first reference and persists the private key to disk', () => {
    const created = ks.ensure('agent_a');
    expect(created.created).toBe(true);
    expect(created.pub.publicKeyHex).toHaveLength(64); // 32 bytes hex
    expect(existsSync(join(dir, 'agent_a.pem'))).toBe(true);
    // second reference does not re-mint
    expect(ks.ensure('agent_a').created).toBe(false);
  });

  it('signs a message and verifies it with the embedded public key', () => {
    const sig = ks.sign('agent_a', 'hello world');
    expect(sig.alg).toBe('ed25519');
    expect(sig.signer).toBe('agent_a');
    expect(verifySignature('hello world', sig)).toBe(true);
  });

  it('rejects a signature over a different message', () => {
    const sig = ks.sign('agent_a', 'hello world');
    expect(verifySignature('tampered', sig)).toBe(false);
  });

  it('rejects a signature with a swapped public key (impersonation)', () => {
    ks.ensure('agent_b');
    const sig = ks.sign('agent_a', 'msg');
    const bPub = ks.toPublicKey('agent_b').publicKeyHex;
    expect(verifySignature('msg', { ...sig, publicKeyHex: bPub })).toBe(false);
  });

  it('reloads persisted keys across keystore instances (stable public key)', () => {
    const pub1 = ks.publicKeyHex('agent_a');
    const ks2 = new AgentKeystore(dir);
    expect(ks2.publicKeyHex('agent_a')).toBe(pub1);
    // a signature from the reloaded keystore still verifies
    expect(verifySignature('x', ks2.sign('agent_a', 'x'))).toBe(true);
  });

  it('rebuilds a public key from hex round-trip', () => {
    const hex = ks.publicKeyHex('agent_a');
    expect(() => publicKeyFromHex(hex)).not.toThrow();
    expect(() => publicKeyFromHex('00')).toThrow();
  });

  it('never exposes private key material in the public record', () => {
    const pub = ks.toPublicKey('agent_a');
    expect(JSON.stringify(pub)).not.toMatch(/PRIVATE/i);
    expect(Object.keys(pub)).toEqual(['agentId', 'publicKeyHex', 'createdAt']);
  });
});
