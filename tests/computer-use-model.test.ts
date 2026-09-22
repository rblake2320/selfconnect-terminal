/**
 * Anthropic computer-use adapter: substituted fetch only. ZERO live requests.
 */
import { describe, it, expect } from 'vitest';
import {
  AnthropicComputerUseAdapter,
  ANTHROPIC_MESSAGES_ENDPOINT,
  ANTHROPIC_COMPUTER_TOOLSET,
  ANTHROPIC_COMPUTER_USE_MODELS,
  IMAGE_TOKENS_CAP,
  OVERHEAD_MARGIN_TOKENS,
  ManualComputerUseAdapter,
  imageVisualTokens,
  mapAnthropicKey,
  pngDimensions,
  type ComputerUseProposeInput,
} from '../src/daemon/computer-use-model';
import { ComputerActionSchema, validateComputerAction, type ComputerPaidConsent } from '../src/shared/computer-use';

const consent: ComputerPaidConsent = { provider: 'anthropic', model: 'claude-sonnet-5', sessionCapUsd: 2, taskCapUsd: 0.5, projectCapUsd: 25, priceInputPerMillion: 2, priceOutputPerMillion: 10, acknowledgeSeparateBilling: true };
/** Minimal PNG header (signature + IHDR) with real dimensions; enough for header validation. */
function pngHeader(width: number, height: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
}
const png = pngHeader(800, 600);
const input = (over: Partial<ComputerUseProposeInput> = {}): ComputerUseProposeInput => ({
  objective: 'Type the sentence "hello from selfconnect" into Notepad.',
  observation: { screenshotBase64: png, width: 800, height: 600 },
  history: [],
  allowedActions: ['observe', 'focus', 'click', 'type', 'keypress', 'scroll', 'wait', 'finish'],
  remainingActions: 10,
  remainingSpendUsd: 2,
  session: { sessionId: 'cu-1', nextSequence: 2, observationId: 'obs-1' },
  ...over,
});
const response = (status: number, body: unknown): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const good = {
  model: 'claude-sonnet-5',
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'I will click the editor then type.' },
    { type: 'tool_use', id: 'toolu_1', name: 'left_click', toolset_name: 'computer', input: { coordinate: [200, 150] } },
    { type: 'tool_use', id: 'toolu_2', name: 'type', toolset_name: 'computer', input: { text: 'hello from selfconnect' } },
    { type: 'tool_use', id: 'toolu_3', name: 'key', toolset_name: 'computer', input: { text: 'Return' } },
  ],
  usage: { input_tokens: 6100, output_tokens: 120 },
};
type Opts = ConstructorParameters<typeof AnthropicComputerUseAdapter>[0];
function adapter(request: typeof fetch, over: Partial<Opts> = {}) {
  return new AnthropicComputerUseAdapter({ enabled: true, apiKey: ['test', 'placeholder', 'key'].join('-'), model: 'claude-sonnet-5', consent, localOnly: () => false, request, ...over });
}
const counting = () => { const c = { calls: 0 }; const req: typeof fetch = async () => { c.calls++; return response(200, good); }; return { c, req }; };

describe('constructor validation (fail closed on bad options)', () => {
  const noop: typeof fetch = async () => response(200, good);
  it('refuses a model not documented for computer use', () => {
    expect(() => adapter(noop, { model: 'claude-haiku-4-5' })).toThrow(/not a documented computer-use model/);
  });
  it('refuses non-finite or non-positive numeric options', () => {
    expect(() => adapter(noop, { timeoutMs: Number.NaN })).toThrow(/timeoutMs/);
    expect(() => adapter(noop, { timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => adapter(noop, { maxResponseBytes: Number.POSITIVE_INFINITY })).toThrow(/maxResponseBytes/);
    expect(() => adapter(noop, { maxOutputTokens: 0 })).toThrow(/maxOutputTokens/);
    expect(() => adapter(noop, { maxOutputTokens: 100000 })).toThrow(/maxOutputTokens/);
  });
  it('refuses malformed consent (NaN prices, unordered caps, wrong ack)', () => {
    expect(() => adapter(noop, { consent: { ...consent, priceInputPerMillion: Number.NaN } })).toThrow(/consent is malformed/);
    expect(() => adapter(noop, { consent: { ...consent, sessionCapUsd: -1 } })).toThrow(/consent is malformed/);
    expect(() => adapter(noop, { consent: { ...consent, taskCapUsd: 3 } })).toThrow(/consent is malformed/);
    expect(() => adapter(noop, { consent: { ...consent, acknowledgeSeparateBilling: false as unknown as true } })).toThrow(/consent is malformed/);
  });
});

describe('refusals before any network activity (zero fetch)', () => {
  it('disabled by default', async () => {
    const { c, req } = counting();
    await expect(adapter(req, { enabled: false }).proposeActions(input())).rejects.toThrow(/disabled/);
    expect(c.calls).toBe(0);
  });
  it('no consent, consent for another model, missing key, local-only', async () => {
    const { c, req } = counting();
    await expect(adapter(req, { consent: null }).proposeActions(input())).rejects.toThrow(/consent/);
    await expect(adapter(req, { consent: { ...consent, model: 'claude-opus-5-5' } }).proposeActions(input())).rejects.toThrow(/consent does not name/);
    await expect(adapter(req, { apiKey: '' }).proposeActions(input())).rejects.toThrow(/API key/);
    await expect(adapter(req, { localOnly: () => true }).proposeActions(input())).rejects.toThrow(/local-only/);
    expect(c.calls).toBe(0);
  });
  it('budget and caps: remaining budget, task cap, NaN or infinite remaining, fractional actions', async () => {
    const { c, req } = counting();
    await expect(adapter(req).proposeActions(input({ remainingSpendUsd: 0.005 }))).rejects.toThrow(/exceeds remaining budget/);
    await expect(adapter(req, { consent: { ...consent, taskCapUsd: 0.01 } }).proposeActions(input())).rejects.toThrow(/task cap/);
    await expect(adapter(req).proposeActions(input({ remainingSpendUsd: Number.NaN }))).rejects.toThrow(/not a finite number/);
    await expect(adapter(req).proposeActions(input({ remainingSpendUsd: Number.POSITIVE_INFINITY }))).rejects.toThrow(/not a finite number/);
    await expect(adapter(req).proposeActions(input({ remainingActions: 2.5 }))).rejects.toThrow(/no actions remaining/);
    expect(c.calls).toBe(0);
  });
  it('observation problems: empty, bad dims, too large, not base64; empty objective; no actions', async () => {
    const { c, req } = counting();
    await expect(adapter(req).proposeActions(input({ observation: { screenshotBase64: '', width: 800, height: 600 } }))).rejects.toThrow(/observation is empty/);
    await expect(adapter(req).proposeActions(input({ observation: { screenshotBase64: png, width: 0, height: 600 } }))).rejects.toThrow(/dimensions/);
    await expect(adapter(req).proposeActions(input({ observation: { screenshotBase64: pngHeader(3000, 600), width: 3000, height: 600 } }))).rejects.toThrow(/long edge/);
    await expect(adapter(req).proposeActions(input({ observation: { screenshotBase64: 'not base64!!', width: 800, height: 600 } }))).rejects.toThrow(/not base64/);
    await expect(adapter(req).proposeActions(input({ observation: { screenshotBase64: Buffer.from('not a png at all, just text').toString('base64'), width: 800, height: 600 } }))).rejects.toThrow(/not a PNG/);
    await expect(adapter(req).proposeActions(input({ observation: { screenshotBase64: pngHeader(1024, 768), width: 800, height: 600 } }))).rejects.toThrow(/PNG is 1024x768 but 800x600 was claimed/);
    await expect(adapter(req).proposeActions(input({ objective: '   ' }))).rejects.toThrow(/objective is empty/);
    await expect(adapter(req).proposeActions(input({ remainingActions: 0 }))).rejects.toThrow(/no actions remaining/);
    expect(c.calls).toBe(0);
  });
});

describe('conservative reservation estimate', () => {
  it('uses documented visual tokens with the 4784 cap', () => {
    expect(imageVisualTokens(200, 200)).toBe(64);
    expect(imageVisualTokens(1000, 1000)).toBe(1296);
    expect(imageVisualTokens(2576, 1449)).toBe(IMAGE_TOKENS_CAP);
    expect(imageVisualTokens(8000, 8000)).toBe(IMAGE_TOKENS_CAP);
  });
  it('reads real PNG dimensions and rejects non-PNG data', () => {
    expect(pngDimensions(pngHeader(1456, 819))).toEqual({ width: 1456, height: 819 });
    expect(pngDimensions(Buffer.from('hello').toString('base64'))).toBeNull();
    expect(pngDimensions('')).toBeNull();
  });
  it('is computed from the exact request body bytes, documented overhead + margin, and full max output', () => {
    const a = adapter(async () => response(200, good));
    const inp = input();
    const body = a.buildRequestBody(inp);
    const textBytes = Buffer.byteLength(String(body.system), 'utf8') + Buffer.byteLength(JSON.stringify(body.tools), 'utf8') +
      Buffer.byteLength(JSON.stringify((body.messages as { content: unknown[] }[])[0].content[1]), 'utf8');
    const doc = ANTHROPIC_COMPUTER_USE_MODELS['claude-sonnet-5'];
    const expected = ((doc.toolsetOverheadTokens + OVERHEAD_MARGIN_TOKENS + imageVisualTokens(800, 600) + textBytes) * 2 + 600 * 10) / 1e6;
    expect(a.reservationEstimateUsd(inp)).toBeCloseTo(expected, 10);
    expect(a.reservationEstimateUsd(input({ objective: 'x'.repeat(900) }))).toBeGreaterThan(expected);
    const cheap = adapter(async () => response(200, good), { consent: { ...consent, priceInputPerMillion: 0.001, priceOutputPerMillion: 0.001 } });
    expect(cheap.reservationEstimateUsd(inp)).toBeCloseTo(expected, 10);
  });
});

describe('request and response handling (substituted fetch)', () => {
  it('posts one bounded request to the fixed endpoint with the GA toolset, image first', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const a = adapter(async (url, init) => { seenUrl = String(url); seenInit = init; return response(200, good); });
    const out = await a.proposeActions(input());
    expect(seenUrl).toBe(ANTHROPIC_MESSAGES_ENDPOINT);
    const body = JSON.parse(String(seenInit?.body));
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(600);
    expect(body.tools[0].type).toBe(ANTHROPIC_COMPUTER_TOOLSET);
    expect(body.messages[0].content[0].source.data).toBe(png);
    expect((seenInit?.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    expect(seenInit?.redirect).toBe('error');
    expect(out.usage.inputTokens).toBe(6100);
    expect(out.usage.estimatedCostUsd).toBeCloseTo((6100 * 2 + 120 * 10) / 1e6, 8);
    expect(a.spent()).toBeCloseTo(out.usage.estimatedCostUsd, 8);
    expect(a.ambiguousCharges()).toBe(0);
  });

  it('normalizes provider actions into complete, schema-valid, session-bound actions', async () => {
    const out = await adapter(async () => response(200, good)).proposeActions(input());
    expect(out.actions).toHaveLength(3);
    const ctx = { sessionId: 'cu-1', expectedSequence: 2, latestObservationId: 'obs-1', width: 800, height: 600, maxActions: 10 };
    const first = validateComputerAction(out.actions[0], ctx);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.action).toMatchObject({ type: 'click', point: { x: 200, y: 150 }, button: 'left', sequence: 2 });
    expect(ComputerActionSchema.parse(out.actions[1])).toMatchObject({ type: 'type', text: 'hello from selfconnect', sequence: 3 });
    expect(ComputerActionSchema.parse(out.actions[2])).toMatchObject({ type: 'keypress', keys: ['enter'], sequence: 4 });
  });

  it('drops the WHOLE batch on an unsupported, malformed, or non-allowlisted provider action', async () => {
    const drag = { ...good, content: [good.content[1], { type: 'tool_use', id: 't', name: 'left_click_drag', input: { start_coordinate: [1, 1], coordinate: [5, 5] } }, good.content[2]] };
    const out = await adapter(async () => response(200, drag)).proposeActions(input());
    expect(out.actions).toHaveLength(0);
    expect(out.stopReason).toMatch(/unsupported_action:left_click_drag/);
    const extraField = { ...good, content: [{ type: 'tool_use', id: 't', name: 'left_click', input: { coordinate: [1, 1], text: 'shift' } }] };
    const out2 = await adapter(async () => response(200, extraField)).proposeActions(input());
    expect(out2.actions).toHaveLength(0);
    expect(out2.stopReason).toBe('unsupported_action:left_click:invalid_input');
    const badKey = { ...good, content: [good.content[1], { type: 'tool_use', id: 't', name: 'key', input: { text: 'ctrl+Return' } }] };
    const out3 = await adapter(async () => response(200, badKey)).proposeActions(input());
    expect(out3.actions).toHaveLength(0);
    expect(out3.stopReason).toMatch(/not_allowlisted/);
  });

  it('respects the session allowedActions list (whole batch dropped)', async () => {
    const out = await adapter(async () => response(200, good)).proposeActions(input({ allowedActions: ['observe', 'click'] }));
    expect(out.actions).toHaveLength(0);
    expect(out.stopReason).toBe('disallowed_action:type');
  });

  it('never returns more actions than remainingActions', async () => {
    const out = await adapter(async () => response(200, good)).proposeActions(input({ remainingActions: 2 }));
    expect(out.actions).toHaveLength(2);
    expect(out.stopReason).toBe('action_limit');
  });

  it('rejects a response from a different model than consented, and charges the bound', async () => {
    const a = adapter(async () => response(200, { ...good, model: 'claude-opus-5-5' }));
    await expect(a.proposeActions(input())).rejects.toThrow(/not the consented/);
    expect(a.ambiguousCharges()).toBeGreaterThan(0);
    expect(a.spent()).toBeCloseTo(a.ambiguousCharges(), 12);
  });

  it('accepts a dated snapshot of the consented model', async () => {
    const out = await adapter(async () => response(200, { ...good, model: 'claude-sonnet-5-20260515' })).proposeActions(input());
    expect(out.actions).toHaveLength(3);
  });

  it('401, 529, invalid JSON, and missing usage charge the worst-case bound and accept nothing', async () => {
    const cases: Array<[() => Response, RegExp]> = [
      [() => response(401, { error: 'bad' }), /authentication failed/],
      [() => response(529, {}), /HTTP 529/],
      [() => response(200, '{nope'), /invalid JSON/],
      [() => response(200, { model: 'claude-sonnet-5', content: [] }), /valid usage/],
    ];
    for (const [mk, re] of cases) {
      const a = adapter(async () => mk());
      const bound = a.reservationEstimateUsd(input());
      await expect(a.proposeActions(input())).rejects.toThrow(re);
      expect(a.spent()).toBeCloseTo(bound, 12);
      expect(a.ambiguousCharges()).toBeCloseTo(bound, 12);
    }
  });

  it('bounded streaming: an endless body is cut off at the cap, rejected, and charged', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({ pull(ctrl) { ctrl.enqueue(chunk); } });
    const a = adapter(async () => new Response(stream, { status: 200 }), { maxResponseBytes: 200 * 1024 });
    await expect(a.proposeActions(input())).rejects.toThrow(/oversized/);
    expect(a.ambiguousCharges()).toBeGreaterThan(0);
  });

  it('content-length above the cap is refused before reading', async () => {
    const a = adapter(async () => new Response('{}', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } }));
    await expect(a.proposeActions(input())).rejects.toThrow(/oversized/);
  });

  it('timeout charges the bound and reports no action taken', async () => {
    const a = adapter((_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))), { timeoutMs: 50 });
    await expect(a.proposeActions(input())).rejects.toThrow(/timed out/);
    expect(a.ambiguousCharges()).toBeGreaterThan(0);
  });

  it('measured usage above the reservation locks billing for the rest of the instance', async () => {
    const huge = { ...good, usage: { input_tokens: 200_000, output_tokens: 10 } }; // $0.40 >> reservation, < task cap
    const a = adapter(async () => response(200, huge));
    await a.proposeActions(input());
    expect(a.billingLocked()).toBe(true);
    await expect(a.proposeActions(input())).rejects.toThrow(/billing locked/);
  });

  it('cumulative spend enforces the session cap across calls', async () => {
    const big = { ...good, usage: { input_tokens: 990_000, output_tokens: 1_000 } }; // ~$1.99 at list price
    const a = adapter(async () => response(200, big));
    await a.proposeActions(input());
    expect(a.spent()).toBeGreaterThan(1.98);
    // an overrun of this size also trips the billing lock; either refusal is acceptable, neither calls out
    await expect(a.proposeActions(input())).rejects.toThrow(/session cap|billing locked/);
  });
});

describe('key mapping and manual adapter', () => {
  it('maps documented Anthropic key names onto the allowlist, never downgrades, rejects the rest', () => {
    expect(mapAnthropicKey('Return')).toBe('enter');
    expect(mapAnthropicKey('ctrl+Return')).toBeNull();
    expect(mapAnthropicKey('ctrl+s')).toBeNull();
    expect(mapAnthropicKey('ctrl+Home')).toBe('ctrl+home');
    expect(mapAnthropicKey('Page_Down')).toBe('pagedown');
    expect(mapAnthropicKey('BackSpace')).toBe('backspace');
    expect(mapAnthropicKey('super+r')).toBeNull();
    expect(mapAnthropicKey('cmd+a')).toBeNull();
    expect(mapAnthropicKey('ctrl+alt+Delete')).toBeNull();
    expect(mapAnthropicKey('F5')).toBeNull();
  });

  it('manual adapter never proposes and never costs', async () => {
    const out = await new ManualComputerUseAdapter().proposeActions();
    expect(out.actions).toEqual([]);
    expect(out.usage.estimatedCostUsd).toBe(0);
    expect(out.stopReason).toBe('manual_mode');
  });
});
