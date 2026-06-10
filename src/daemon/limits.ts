import { existsSync, readFileSync } from 'node:fs';
import { LimitsManifestSchema, type LimitsManifest } from '../shared/contracts';

/**
 * Honest limits manifest (E10). A machine-readable statement of what this
 * harness/model pair CANNOT do, loaded at session start. Surfacing it up front
 * eliminates whole classes of wasted attempts and hallucinated capability.
 *
 * A user-supplied limits.json (if present) is merged over the built-in default.
 */
export const DEFAULT_LIMITS: LimitsManifest = {
  cannot: [
    'render or screenshot a GUI — this is a headless/terminal harness',
    'use a GPU or run local training',
    'make cloud model calls while LOCAL_ONLY is active (ask the human or use ollama/gemma3)',
    'execute shell commands without approval (bash is always approval-gated)',
    'see provider API keys — they live only in the daemon .env',
    'persist anything outside the configured data dir + ledger',
  ],
  blockedDomains: [],
  notes: [
    'Distillation runs on the local model at $0; cloud distillation needs approval.',
    'Errors return what happened + why + the single best next action, never raw stacks.',
  ],
};

export function loadLimits(path: string): LimitsManifest {
  if (!existsSync(path)) return DEFAULT_LIMITS;
  try {
    const parsed = LimitsManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    return {
      cannot: [...DEFAULT_LIMITS.cannot, ...parsed.cannot],
      blockedDomains: [...DEFAULT_LIMITS.blockedDomains, ...parsed.blockedDomains],
      notes: [...DEFAULT_LIMITS.notes, ...parsed.notes],
    };
  } catch {
    return DEFAULT_LIMITS;
  }
}
