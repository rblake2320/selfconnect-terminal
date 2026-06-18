import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendOutboxRecord,
  applyRepairPlan,
  buildOutboxRecord,
  classifyTool,
  extractJsonObject,
  validateRepairPlan,
} from '../src/daemon/local-model-worker';

const NONCE = 'SC_LOCAL_REPAIR_TEST';

function validRawPlan(message = `fixed ${NONCE}`) {
  return {
    steps: [
      {
        tool: 'replace_text',
        args: {
          file: 'buggy_math.py',
          old: 'return a - b',
          new: 'return a + b',
        },
      },
      {
        tool: 'notify_codex',
        args: { message },
      },
    ],
  };
}

function constraints() {
  return {
    nonce: NONCE,
    allowedFile: 'buggy_math.py',
    expectedOld: 'return a - b',
    expectedNew: 'return a + b',
  };
}

describe('local model worker wrapper', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-local-worker-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('extracts fenced JSON from a weak local model response', () => {
    const raw = '```json\n{"steps":[]}\n```';
    expect(extractJsonObject(raw)).toEqual({ steps: [] });
  });

  it('validates the constrained two-step repair plan', () => {
    const plan = validateRepairPlan(validRawPlan(), constraints());
    expect(plan.steps[0].tool).toBe('replace_text');
    expect(plan.steps[1].tool).toBe('notify_codex');
  });

  it('rejects notify messages that omit the nonce', () => {
    expect(() => validateRepairPlan(validRawPlan('fixed without nonce'), constraints())).toThrow(
      /missing nonce/,
    );
  });

  it('rejects wrong repair text even when the JSON shape is valid', () => {
    const raw = validRawPlan();
    raw.steps[0].args.new = 'return 5';
    expect(() => validateRepairPlan(raw, constraints())).toThrow(/new text mismatch/);
  });

  it('applies a sandbox repair only when the old text appears exactly once', () => {
    writeFileSync(join(dir, 'buggy_math.py'), 'def add(a, b):\n    return a - b\n', 'utf8');
    const plan = validateRepairPlan(validRawPlan(), constraints());
    const applied = applyRepairPlan(dir, plan);
    expect(applied.before).toContain('return a - b');
    expect(readFileSync(join(dir, 'buggy_math.py'), 'utf8')).toContain('return a + b');
  });

  it('blocks sandbox path traversal', () => {
    const raw = validRawPlan();
    raw.steps[0].args.file = '../outside.py';
    const plan = validateRepairPlan(raw, { ...constraints(), allowedFile: '../outside.py' });
    expect(() => applyRepairPlan(dir, plan)).toThrow(/escapes sandbox/);
  });

  it('rejects ambiguous text replacement', () => {
    writeFileSync(
      join(dir, 'buggy_math.py'),
      'def add(a, b):\n    return a - b\n\ndef sub(a, b):\n    return a - b\n',
      'utf8',
    );
    const plan = validateRepairPlan(validRawPlan(), constraints());
    expect(() => applyRepairPlan(dir, plan)).toThrow(/exactly once/);
  });

  it('writes durable JSONL outbox records for ACK-based coordination', () => {
    const outbox = join(dir, 'outbox.jsonl');
    const record = buildOutboxRecord({
      nonce: NONCE,
      message: `repair PASS ${NONCE}`,
      initialFailed: true,
      finalPassed: true,
    });
    appendOutboxRecord(outbox, record);
    const lines = readFileSync(outbox, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      from: 'LOCAL-OLLAMA-1',
      to: 'codex-1',
      ackRequired: true,
      finalPassed: true,
    });
  });

  it('keeps MCP airgap claims honest', () => {
    expect(classifyTool('mcp_call').airgapSafe).toBe(false);
    expect(classifyTool('mcp_call', { mcpServerLocalOnly: true }).airgapSafe).toBe(true);
    expect(classifyTool('replace_text').airgapSafe).toBe(true);
  });
});
