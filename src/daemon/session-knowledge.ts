import {
  type SessionKnowledge,
} from '../shared/contracts';
import type { ModelProvider } from '../agent/providers/base';

/**
 * Tiered session memory (A2). The daemon keeps a HOT verbatim window of recent
 * turns and distills older turns into a structured WARM SessionKnowledge object
 * (decisions, facts, file states, open questions, todos, named entities).
 *
 * Distillation runs on the LOCAL model (Ollama) so it costs $0 and never leaves
 * the machine. If the local model is unreachable we fall back to a deterministic
 * heuristic extractor so the system still degrades to working, free behaviour.
 *
 * "Differential context" = stable system prefix + this SessionKnowledge delta +
 * the hot window + the task — never the whole transcript.
 */

export function emptyKnowledge(): SessionKnowledge {
  return {
    decisions: [],
    facts: [],
    fileStates: {},
    openQuestions: [],
    todos: [],
    namedEntities: [],
    sourceBlobs: [],
    updatedAt: 0,
  };
}

const DISTILL_SYSTEM = [
  'You distill an agent session turn into structured memory.',
  'Return ONLY JSON: {decisions:[],facts:[],fileStates:{},openQuestions:[],namedEntities:[]}.',
  'Be terse. No prose outside the JSON.',
].join(' ');

function pushUnique(arr: string[], items: string[], cap = 50): void {
  for (const it of items) {
    const v = it.trim();
    if (v && !arr.includes(v)) arr.push(v);
  }
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/** Deterministic, $0 fallback extractor used when the local model is offline. */
export function heuristicDistill(turn: string): Partial<SessionKnowledge> {
  const out: Partial<SessionKnowledge> = {
    decisions: [],
    facts: [],
    fileStates: {},
    openQuestions: [],
    namedEntities: [],
  };
  const lines = turn.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/\?\s*$/.test(line)) out.openQuestions!.push(line);
    else if (/^(decided|decision|will|going to|chose|use|adopt)\b/i.test(line)) out.decisions!.push(line);
    else if (/\b(wrote|edited|created|deleted|modified|patched)\b/i.test(line)) {
      const m = line.match(/([\w./-]+\.\w+)/);
      if (m) out.fileStates![m[1]] = line.slice(0, 120);
      else out.facts!.push(line);
    } else out.facts!.push(line);
    for (const ent of line.match(/\b[A-Z][a-zA-Z0-9]{2,}(?:[A-Z][a-zA-Z0-9]+)+\b/g) ?? []) {
      out.namedEntities!.push(ent);
    }
  }
  return out;
}

export class SessionKnowledgeStore {
  private knowledge: SessionKnowledge = emptyKnowledge();

  get(): SessionKnowledge {
    return this.knowledge;
  }

  restore(k: SessionKnowledge | undefined): void {
    this.knowledge = k ? { ...emptyKnowledge(), ...k } : emptyKnowledge();
  }

  setTodos(todos: string[]): void {
    this.knowledge.todos = todos.slice(0, 50);
    this.knowledge.updatedAt = Date.now();
  }

  private merge(part: Partial<SessionKnowledge>, sourceBlob?: string): void {
    pushUnique(this.knowledge.decisions, part.decisions ?? []);
    pushUnique(this.knowledge.facts, part.facts ?? []);
    pushUnique(this.knowledge.openQuestions, part.openQuestions ?? []);
    pushUnique(this.knowledge.namedEntities, part.namedEntities ?? [], 100);
    for (const [k, v] of Object.entries(part.fileStates ?? {})) this.knowledge.fileStates[k] = v;
    if (sourceBlob && !this.knowledge.sourceBlobs.includes(sourceBlob)) {
      this.knowledge.sourceBlobs.push(sourceBlob);
    }
    this.knowledge.updatedAt = Date.now();
  }

  /**
   * Distill one turn into the WARM knowledge object. Uses the LOCAL provider if
   * configured/reachable; otherwise falls back to the heuristic extractor. Both
   * paths cost $0. Returns the input tokens distilled (for savings accounting).
   */
  async distill(
    turn: string,
    local: ModelProvider | null,
    sourceBlob?: string,
  ): Promise<{ distilledTokens: number; usedModel: boolean }> {
    const distilledTokens = Math.ceil(turn.length / 4);
    if (local && local.isConfigured()) {
      try {
        const res = await local.complete({
          model: local.model,
          system: DISTILL_SYSTEM,
          prompt: turn.slice(0, 8000),
          maxTokens: 400,
        });
        const parsed = safeParseKnowledge(res.text);
        if (parsed) {
          this.merge(parsed, sourceBlob);
          return { distilledTokens, usedModel: true };
        }
      } catch {
        // fall through to heuristic
      }
    }
    this.merge(heuristicDistill(turn), sourceBlob);
    return { distilledTokens, usedModel: false };
  }
}

function safeParseKnowledge(text: string): Partial<SessionKnowledge> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return {
      decisions: asStrArr(obj.decisions),
      facts: asStrArr(obj.facts),
      openQuestions: asStrArr(obj.openQuestions),
      namedEntities: asStrArr(obj.namedEntities),
      fileStates: asStrRecord(obj.fileStates),
    };
  } catch {
    return null;
  }
}

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asStrRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
  }
  return out;
}
