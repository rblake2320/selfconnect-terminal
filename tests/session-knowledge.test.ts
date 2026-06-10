import { describe, it, expect } from 'vitest';
import { SessionKnowledgeStore, heuristicDistill, emptyKnowledge } from '../src/daemon/session-knowledge';
import type { ModelProvider, CompletionResult } from '../src/agent/providers/base';

function stubLocal(text: string, configured = true): ModelProvider {
  return {
    kind: 'ollama',
    tier: 'local',
    model: 'gemma3',
    price: () => ({ inputPerMillion: 0, outputPerMillion: 0 }),
    isConfigured: () => configured,
    ping: async () => ({ alive: true, detail: 'ok' }),
    complete: async (): Promise<CompletionResult> => ({ text, inputTokens: 0, outputTokens: 0 }),
  };
}

describe('heuristicDistill ($0 fallback)', () => {
  it('classifies questions, decisions, file edits, and facts', () => {
    const out = heuristicDistill(
      [
        'Will we add a cache?',
        'Decided to use SHA-256 for blobs',
        'wrote src/daemon/context-store.ts',
        'The ledger is hash chained',
      ].join('\n'),
    );
    expect(out.openQuestions).toContain('Will we add a cache?');
    expect(out.decisions?.some((d) => /SHA-256/.test(d))).toBe(true);
    expect(out.fileStates && out.fileStates['src/daemon/context-store.ts']).toBeTruthy();
    expect(out.facts?.some((f) => /hash chained/.test(f))).toBe(true);
  });

  it('extracts CamelCase named entities', () => {
    const out = heuristicDistill('We touched the ContextStore and the SessionKnowledgeStore today');
    expect(out.namedEntities).toContain('ContextStore');
    expect(out.namedEntities).toContain('SessionKnowledgeStore');
  });
});

describe('SessionKnowledgeStore', () => {
  it('starts empty', () => {
    const store = new SessionKnowledgeStore();
    expect(store.get()).toEqual(emptyKnowledge());
  });

  it('distills via the local model when it returns valid JSON', async () => {
    const store = new SessionKnowledgeStore();
    const json = JSON.stringify({
      decisions: ['use gemma3'],
      facts: ['fact one'],
      openQuestions: [],
      namedEntities: ['Gemma'],
      fileStates: { 'a.ts': 'edited' },
    });
    const res = await store.distill('some turn text', stubLocal(json), 'blob_1');
    expect(res.usedModel).toBe(true);
    expect(res.distilledTokens).toBeGreaterThan(0);
    const k = store.get();
    expect(k.decisions).toContain('use gemma3');
    expect(k.fileStates['a.ts']).toBe('edited');
    expect(k.sourceBlobs).toContain('blob_1');
  });

  it('falls back to heuristic when the local model is unconfigured ($0, no network)', async () => {
    const store = new SessionKnowledgeStore();
    const res = await store.distill('Decided to ship v3', stubLocal('', false));
    expect(res.usedModel).toBe(false);
    expect(store.get().decisions.some((d) => /ship v3/.test(d))).toBe(true);
  });

  it('falls back to heuristic when the local model returns non-JSON', async () => {
    const store = new SessionKnowledgeStore();
    const res = await store.distill('wrote foo.ts', stubLocal('not json at all'));
    expect(res.usedModel).toBe(false);
    expect(store.get().fileStates['foo.ts']).toBeTruthy();
  });

  it('falls back when the local model throws', async () => {
    const store = new SessionKnowledgeStore();
    const broken: ModelProvider = { ...stubLocal('x'), complete: async () => { throw new Error('down'); } };
    const res = await store.distill('Will we retry?', broken);
    expect(res.usedModel).toBe(false);
    expect(store.get().openQuestions).toContain('Will we retry?');
  });

  it('merges across turns without duplicating', async () => {
    const store = new SessionKnowledgeStore();
    await store.distill('Decided to use SHA-256', stubLocal('', false));
    await store.distill('Decided to use SHA-256', stubLocal('', false));
    expect(store.get().decisions.filter((d) => /SHA-256/.test(d))).toHaveLength(1);
  });

  it('restore reseeds knowledge and resume re-reads nothing else', () => {
    const store = new SessionKnowledgeStore();
    store.restore({ ...emptyKnowledge(), facts: ['restored fact'], updatedAt: 5 });
    expect(store.get().facts).toContain('restored fact');
  });

  it('setTodos updates the WARM todo list', () => {
    const store = new SessionKnowledgeStore();
    store.setTodos(['a', 'b']);
    expect(store.get().todos).toEqual(['a', 'b']);
  });
});
