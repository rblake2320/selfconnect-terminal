import { existsSync, readFileSync } from 'node:fs';
import type { SimulationPreview } from '../../shared/contracts';
import { assessCommand } from '../command-risk';
import { estimateTokens, priceFor } from '../../agent/cost-kernel';

/**
 * E5 dry-run planners. Each mutating tool can be simulated: we compute the
 * PREDICTED effects without touching disk, the network, or the model. The result
 * is a {@link SimulationPreview} the human can approve as evidence rather than a
 * promise. Read-only tools return a trivial non-mutating preview.
 *
 * These functions never execute anything — `write_file` reads the *current* file
 * only to compute a diff preview, and `bash` classifies risk without running the
 * command. Everything stays on the trusted side; only the derived preview leaves.
 */

const DIFF_MAX = 4000;

/** Truncate a long diff body for display, keeping it bounded for the renderer. */
function clip(text: string): string {
  return text.length > DIFF_MAX ? text.slice(0, DIFF_MAX) + '\n… (truncated)' : text;
}

/** Tiny line-level diff preview (added/removed markers), good enough for review. */
function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) {
      out.push(`- ${a[i]}`);
      changed++;
    }
    if (b[i] !== undefined) {
      out.push(`+ ${b[i]}`);
      changed++;
    }
    if (changed > 400) {
      out.push('… (diff truncated)');
      break;
    }
  }
  return out.join('\n');
}

function readCurrent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Tools that have a meaningful, non-trivial simulation planner. */
export const SIMULATABLE = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'bash',
  'web_fetch',
  'web_search',
  'mcp_call',
  'a2a_send',
]);

/**
 * Produce a dry-run preview for a tool + validated input. `mutating` is the
 * tool's declared mutating flag. Pure: no side effects.
 */
export function simulateTool(
  name: string,
  input: unknown,
  mutating: boolean,
  baselineCloudPriceUsdPerM: { inputPerMillion: number; outputPerMillion: number },
): SimulationPreview {
  const base: SimulationPreview = {
    tool: name,
    mutating,
    summary: `no predicted effect for '${name}'`,
    filesTouched: [],
    estimatedCostUsd: 0,
  };

  switch (name) {
    case 'write_file': {
      const i = input as { path: string; content: string };
      const before = readCurrent(i.path);
      const exists = before !== null;
      const diff = lineDiff(before ?? '', i.content);
      return {
        ...base,
        summary: `${exists ? 'overwrite' : 'create'} ${i.path} (${i.content.length} bytes)`,
        filesTouched: [i.path],
        diff: clip(diff || `+ ${i.content.slice(0, 200)}`),
      };
    }

    case 'edit_file': {
      const i = input as { path: string; edits: { oldString: string; newString: string; replaceAll?: boolean }[] };
      const before = readCurrent(i.path);
      if (before === null) {
        return { ...base, summary: `error: no such file: ${i.path}`, filesTouched: [i.path] };
      }
      let after = before;
      let applied = 0;
      let missing = false;
      for (const e of i.edits) {
        if (!after.includes(e.oldString)) {
          missing = true;
          break;
        }
        if (e.replaceAll) {
          const count = after.split(e.oldString).length - 1;
          after = after.split(e.oldString).join(e.newString);
          applied += count;
        } else {
          after = after.replace(e.oldString, e.newString);
          applied += 1;
        }
      }
      if (missing) {
        return { ...base, summary: `error: an oldString was not found in ${i.path}`, filesTouched: [i.path] };
      }
      return {
        ...base,
        summary: `apply ${applied} edit(s) to ${i.path}`,
        filesTouched: [i.path],
        diff: clip(lineDiff(before, after)),
      };
    }

    case 'apply_patch': {
      const i = input as { files: { path: string; content: string }[] };
      const paths = i.files.map((f) => f.path);
      const diffs = i.files
        .map((f) => `### ${f.path}\n${lineDiff(readCurrent(f.path) ?? '', f.content)}`)
        .join('\n');
      return {
        ...base,
        summary: `patch ${i.files.length} file(s): ${paths.join(', ')}`,
        filesTouched: paths,
        diff: clip(diffs),
      };
    }

    case 'bash': {
      const i = input as { command: string };
      const finding = assessCommand(i.command);
      return {
        ...base,
        summary: `would run: ${i.command}`,
        risk: finding ? finding.severity : 'high',
        riskReason: finding ? finding.reason : 'shell command (baseline high risk)',
      };
    }

    case 'web_fetch':
    case 'web_search': {
      const i = input as { url?: string; query?: string };
      const target = i.url ?? i.query ?? '';
      // Estimate a small inbound cost at baseline cloud input pricing (~1k tokens).
      const est = priceFor(estimateTokens(target) + 1000, 0, baselineCloudPriceUsdPerM);
      return {
        ...base,
        summary: `${name} → ${target.slice(0, 80)} (outbound text redacted)`,
        risk: name === 'web_search' ? 'high' : 'medium',
        riskReason: 'network egress',
        estimatedCostUsd: est,
      };
    }

    case 'mcp_call': {
      const i = input as { server: string; tool: string };
      return { ...base, summary: `mcp call ${i.server}/${i.tool} (policy-gated, redacted)`, risk: 'medium' };
    }

    case 'a2a_send': {
      const i = input as { peer: string; message: string };
      return {
        ...base,
        summary: `A2A send to ${i.peer} (${i.message.length} bytes, redacted)`,
        risk: 'medium',
        riskReason: 'cross-agent egress',
      };
    }

    default:
      return base;
  }
}
