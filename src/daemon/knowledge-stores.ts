import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PlaybookSchema,
  FailureRecordSchema,
  type Playbook,
  type FailureRecord,
} from '../shared/contracts';

/**
 * Cumulative cross-session memory (E1 + E2). Both stores are content-addressed
 * and persisted as append-only JSONL so the system gets permanently better with
 * use — no retraining, readable in 20 years.
 *
 *  - Playbooks (E1): when a run solves something nontrivial, the working
 *    procedure is crystallized into a versioned, reusable playbook. Future
 *    sessions load matching playbooks on demand by situation signature.
 *  - Failure memory (E2): when an approach fails, an anti-pattern record is
 *    written {situation-signature -> what not to do -> what worked instead} and
 *    surfaced as a one-line warning when a similar situation recurs.
 */

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Lowercase token set used for cheap situation matching. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.min(ta.size, tb.size);
}

abstract class JsonlStore<T extends { hash: string }> {
  protected items: T[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  private ensureDir(): void {
    const dir = join(this.file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  protected abstract parse(line: string): T | null;

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const item = this.parse(trimmed);
        if (item) this.items.push(item);
      }
    } catch {
      // ignore corrupt store
    }
  }

  protected append(item: T): void {
    this.ensureDir();
    writeFileSync(this.file, JSON.stringify(item) + '\n', { encoding: 'utf8', flag: 'a' });
  }

  all(): T[] {
    return this.items.slice();
  }
}

export class PlaybookStore extends JsonlStore<Playbook> {
  protected parse(line: string): Playbook | null {
    const r = PlaybookSchema.safeParse(JSON.parse(line));
    return r.success ? r.data : null;
  }

  /** Crystallize a procedure into a versioned playbook (idempotent by content). */
  crystallize(input: {
    situation: string;
    title: string;
    steps: string[];
    pitfalls?: string[];
    provenance?: string[];
  }): Playbook {
    const body = `${input.situation}\n${input.title}\n${input.steps.join('\n')}`;
    const hash = sha256(body);
    const existing = this.items.find((p) => p.hash === hash);
    if (existing) return existing;
    const priorVersions = this.items.filter((p) => p.title === input.title).length;
    const pb: Playbook = {
      hash,
      situation: input.situation,
      title: input.title,
      steps: input.steps,
      pitfalls: input.pitfalls ?? [],
      provenance: input.provenance ?? [],
      version: priorVersions + 1,
      createdAt: Date.now(),
    };
    this.items.push(pb);
    this.append(pb);
    return pb;
  }

  /** Find playbooks matching a situation, best first. */
  match(situation: string, threshold = 0.3): Playbook[] {
    return this.items
      .map((p) => ({ p, score: similarity(situation, `${p.situation} ${p.title}`) }))
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);
  }
}

export class FailureStore extends JsonlStore<FailureRecord> {
  protected parse(line: string): FailureRecord | null {
    const r = FailureRecordSchema.safeParse(JSON.parse(line));
    return r.success ? r.data : null;
  }

  record(input: {
    signature: string;
    whatNotToDo: string;
    whatWorkedInstead: string;
    provenance?: string[];
  }): FailureRecord {
    const hash = sha256(`${input.signature}\n${input.whatNotToDo}`);
    const existing = this.items.find((f) => f.hash === hash);
    if (existing) return existing;
    const rec: FailureRecord = {
      hash,
      signature: input.signature,
      whatNotToDo: input.whatNotToDo,
      whatWorkedInstead: input.whatWorkedInstead,
      provenance: input.provenance ?? [],
      createdAt: Date.now(),
    };
    this.items.push(rec);
    this.append(rec);
    return rec;
  }

  /** One-line warning if a similar situation has failed before, else null. */
  warn(situation: string, threshold = 0.3): string | null {
    const best = this.items
      .map((f) => ({ f, score: similarity(situation, f.signature) }))
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score)[0];
    if (!best) return null;
    return `⚠ seen before: ${best.f.whatNotToDo} — instead: ${best.f.whatWorkedInstead}`;
  }

  match(situation: string, threshold = 0.3): FailureRecord[] {
    return this.items
      .map((f) => ({ f, score: similarity(situation, f.signature) }))
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.f);
  }
}
