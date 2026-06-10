import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Project memory: SELFCONNECT.md (analogous to CLAUDE.md). Auto-loaded into the
 * review/context-builder snapshot so the review agent sees durable project
 * instructions. Editable via the /memory command and the memory tool.
 */
export class ProjectMemory {
  readonly path: string;

  constructor(cwd: string, filename = 'SELFCONNECT.md') {
    this.path = join(cwd, filename);
  }

  read(): string {
    if (!existsSync(this.path)) return '';
    try {
      return readFileSync(this.path, 'utf8');
    } catch {
      return '';
    }
  }

  write(content: string): void {
    writeFileSync(this.path, content, 'utf8');
  }

  exists(): boolean {
    return existsSync(this.path);
  }
}
