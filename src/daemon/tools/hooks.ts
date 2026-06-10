import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { z } from 'zod';

/**
 * Configurable pre/post tool-use hooks. hooks.json:
 *   { "hooks": [ { "event": "pre|post", "match": "<regex on tool name>",
 *                  "run": "<shell cmd>"?, "block": true? } ] }
 * A matching `block: true` pre-hook denies the tool. A `run` command executes
 * (best-effort, short timeout) and its exit status is reported. All firings are
 * audited by the caller (hook.fired events).
 */

const HookSchema = z.object({
  event: z.enum(['pre', 'post']),
  match: z.string(),
  run: z.string().optional(),
  block: z.boolean().optional(),
});
const HooksFileSchema = z.object({ hooks: z.array(HookSchema) });
export type Hook = z.infer<typeof HookSchema>;

export interface HookOutcome {
  fired: boolean;
  blocked: boolean;
  reason?: string;
  ran: string[];
}

export class HookEngine {
  private hooks: Hook[] = [];

  constructor(configPath?: string) {
    if (configPath && existsSync(configPath)) {
      try {
        this.hooks = HooksFileSchema.parse(JSON.parse(readFileSync(configPath, 'utf8'))).hooks;
      } catch {
        this.hooks = [];
      }
    }
  }

  /** For tests: load hooks directly. */
  load(hooks: Hook[]): void {
    this.hooks = hooks;
  }

  private matching(event: 'pre' | 'post', tool: string): Hook[] {
    return this.hooks.filter((h) => {
      if (h.event !== event) return false;
      try {
        return new RegExp(h.match).test(tool);
      } catch {
        return false;
      }
    });
  }

  run(event: 'pre' | 'post', tool: string): HookOutcome {
    const matches = this.matching(event, tool);
    const outcome: HookOutcome = { fired: matches.length > 0, blocked: false, ran: [] };
    for (const h of matches) {
      if (h.block) {
        outcome.blocked = true;
        outcome.reason = `blocked by ${event}-hook matching /${h.match}/`;
      }
      if (h.run) {
        try {
          execSync(h.run, { timeout: 5000, stdio: 'ignore' });
          outcome.ran.push(h.run);
        } catch {
          outcome.ran.push(`${h.run} (failed)`);
        }
      }
    }
    return outcome;
  }
}
