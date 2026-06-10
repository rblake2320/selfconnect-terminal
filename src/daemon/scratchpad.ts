import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * External working memory (E4). A keyed store whose contents do NOT ride in the
 * prompt: the agent writes intermediate reasoning/artifacts out and retrieves
 * them selectively by key or query, so plan complexity stops being bounded by
 * the context window. Persisted to a single JSON file so it survives shutdown.
 */
interface Entry {
  key: string;
  value: string;
  updatedAt: number;
}

export class Scratchpad {
  private entries = new Map<string, Entry>();

  constructor(private readonly file: string) {
    this.load();
  }

  private ensureDir(): void {
    const dir = join(this.file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Entry[];
      for (const e of parsed) if (e && typeof e.key === 'string') this.entries.set(e.key, e);
    } catch {
      // ignore corrupt scratchpad
    }
  }

  private persist(): void {
    this.ensureDir();
    writeFileSync(this.file, JSON.stringify([...this.entries.values()]), 'utf8');
  }

  write(key: string, value: string): number {
    this.entries.set(key, { key, value, updatedAt: Date.now() });
    this.persist();
    return value.length;
  }

  read(key: string): string | null {
    return this.entries.get(key)?.value ?? null;
  }

  delete(key: string): boolean {
    const had = this.entries.delete(key);
    if (had) this.persist();
    return had;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Substring search across keys + values; returns matching keys. */
  query(needle: string): string[] {
    const n = needle.toLowerCase();
    return [...this.entries.values()]
      .filter((e) => e.key.toLowerCase().includes(n) || e.value.toLowerCase().includes(n))
      .map((e) => e.key);
  }
}
