import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  SessionSnapshotSchema,
  type SessionSnapshot,
  type SessionSummary,
} from '../shared/contracts';

/**
 * Session persistence store. Writes per-session daemon snapshots atomically to
 * <dir>/<sessionId>.json and lists past sessions for the SessionsPanel / resume
 * flow. Snapshots are Zod-validated on read so a corrupt file cannot poison the
 * resume path.
 */
export class SessionStore {
  constructor(private readonly dir: string) {
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(sessionId: string): string {
    // sessionIds are minted from randomUUID; still strip any path separators.
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  /** Atomically persist a snapshot (write temp + rename). */
  save(snapshot: SessionSnapshot): void {
    this.ensureDir();
    const target = this.pathFor(snapshot.sessionId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    renameSync(tmp, target);
  }

  /** Load and validate a single snapshot, or null if missing/corrupt. */
  load(sessionId: string): SessionSnapshot | null {
    const target = this.pathFor(sessionId);
    if (!existsSync(target)) return null;
    try {
      return SessionSnapshotSchema.parse(JSON.parse(readFileSync(target, 'utf8')));
    } catch {
      return null;
    }
  }

  /** List session summaries derived from persisted snapshots, newest first. */
  list(): SessionSummary[] {
    this.ensureDir();
    const out: SessionSummary[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const snap = SessionSnapshotSchema.parse(
          JSON.parse(readFileSync(join(this.dir, file), 'utf8')),
        );
        out.push({
          sessionId: snap.sessionId,
          startedAt: snap.startedAt,
          lastActiveAt: snap.lastActiveAt,
          eventCount: snap.scrollback.length,
          sessionSpendUsd: snap.cost.sessionSpendUsd,
          chainOk: true,
        });
      } catch {
        // skip corrupt files
      }
    }
    return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
}
