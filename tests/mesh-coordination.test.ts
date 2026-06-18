import { describe, expect, it } from 'vitest';
import {
  MESH_PACKET_MAX_LINES,
  formatMeshPacket,
  meshProtocolText,
  validateMeshPacket,
} from '../src/daemon/mesh-coordination';
import { SelfConnectClient } from '../src/sdk/index';

describe('mesh coordination protocol', () => {
  it('formats a compact transport packet', () => {
    const packet = formatMeshPacket({
      from: 'CLAUDE-1',
      to: 'CODEX-1',
      targetBirthId: 'codex-1-abc',
      purpose: 'ACK',
      repo: 'selfconnect-terminal',
      branch: 'main',
      commit: 'abc123',
      state: 'clean',
      task: 'waiting',
      ask: 'none',
    });
    const validation = validateMeshPacket(packet);
    expect(validation.ok).toBe(true);
    expect(validation.lineCount).toBeLessThanOrEqual(MESH_PACKET_MAX_LINES);
    expect(packet).toContain('[CLAUDE-1 -> CODEX-1 birth_id=codex-1-abc]');
  });

  it('rejects local narration without a mesh header', () => {
    const validation = validateMeshPacket('Here is a long answer in my own pane.');
    expect(validation.ok).toBe(false);
    expect(validation.reasons).toContain('missing mesh header');
  });

  it('rejects oversized sync packets', () => {
    const lines = ['[A -> B] sync'];
    for (let i = 0; i < MESH_PACKET_MAX_LINES; i += 1) lines.push(`line ${i}`);
    const validation = validateMeshPacket(lines.join('\n'));
    expect(validation.ok).toBe(false);
    expect(validation.reasons[0]).toMatch(/too many lines/);
  });

  it('keeps the slash help text compact', () => {
    const text = meshProtocolText();
    expect(validateMeshPacket('[SYSTEM -> AGENT] protocol\n' + text).ok).toBe(true);
    expect(text).toContain('SelfConnect transport');
  });

  it('/mesh-protocol exposes the protocol through the daemon slash surface', async () => {
    const client = new SelfConnectClient();
    const result = await client.slash('/mesh-protocol');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('replies travel over SelfConnect transport');
  });
});
