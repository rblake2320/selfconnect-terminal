import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface Checkpoint {
  id: string;
  ts: number;
  filePath: string;
  existedBefore: boolean;
  blobPath: string;
}

/**
 * Automatic file checkpoints. Before any write_file/edit_file/apply_patch
 * mutates a path, the prior contents are snapshotted under
 * <root>/<sessionId>/. /rewind restores the most recent checkpoint for a path.
 */
export class CheckpointStore {
  private index: Checkpoint[] = [];

  constructor(private readonly root: string, private readonly sessionId: string) {
    this.dir(); // ensure
  }

  private dir(): string {
    const safe = this.sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const d = join(this.root, safe);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }

  /** Snapshot a file's current contents (or mark non-existent) before a write. */
  capture(filePath: string): Checkpoint {
    const id = `ckpt_${randomUUID().slice(0, 8)}`;
    const blobPath = join(this.dir(), `${id}.blob`);
    const existedBefore = existsSync(filePath);
    writeFileSync(blobPath, existedBefore ? readFileSync(filePath, 'utf8') : '', 'utf8');
    const ckpt: Checkpoint = { id, ts: Date.now(), filePath, existedBefore, blobPath };
    this.index.push(ckpt);
    return ckpt;
  }

  list(): Checkpoint[] {
    return this.index.slice();
  }

  /**
   * Restore the most recent checkpoint (optionally for a specific path).
   * Returns the restored checkpoint, or null if none found.
   */
  rewind(filePath?: string): Checkpoint | null {
    for (let i = this.index.length - 1; i >= 0; i--) {
      const c = this.index[i];
      if (filePath && c.filePath !== filePath) continue;
      const blob = existsSync(c.blobPath) ? readFileSync(c.blobPath, 'utf8') : '';
      writeFileSync(c.filePath, blob, 'utf8');
      return c;
    }
    return null;
  }

  /** Count checkpoint blobs on disk (diagnostics). */
  countOnDisk(): number {
    const d = this.dir();
    if (!existsSync(d)) return 0;
    return readdirSync(d).filter((f) => f.endsWith('.blob')).length;
  }
}
