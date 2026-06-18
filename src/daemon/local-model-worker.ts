import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * Local-model worker helpers.
 *
 * Small local models are useful when they are treated as constrained planners,
 * not as free-form autonomous agents. This module is the hard wrapper:
 *
 *   model text -> JSON extraction -> strict schema -> path/text allowlist
 *   -> sandbox edit -> verifier/test -> durable outbox
 *
 * Visual terminal sends are deliberately not modeled as ACKs here. They are a
 * human-observable status surface only; the durable truth is the outbox record.
 */

export const LocalModelToolSchema = z.enum([
  'read_file',
  'search_repo',
  'replace_text',
  'run_tests',
  'write_outbox',
  'send_visible_status',
  'mcp_call',
]);
export type LocalModelTool = z.infer<typeof LocalModelToolSchema>;

export const ReplaceTextActionSchema = z.object({
  tool: z.literal('replace_text'),
  args: z.object({
    file: z.string().min(1),
    old: z.string().min(1),
    new: z.string(),
  }),
});
export type ReplaceTextAction = z.infer<typeof ReplaceTextActionSchema>;

export const NotifyCodexActionSchema = z.object({
  tool: z.literal('notify_codex'),
  args: z.object({
    message: z.string().min(1),
  }),
});
export type NotifyCodexAction = z.infer<typeof NotifyCodexActionSchema>;

export const LocalRepairPlanSchema = z.object({
  steps: z.tuple([ReplaceTextActionSchema, NotifyCodexActionSchema]),
});
export type LocalRepairPlan = z.infer<typeof LocalRepairPlanSchema>;

export const LocalModelOutboxRecordSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  nonce: z.string().min(1),
  type: z.string().min(1),
  message: z.string().min(1),
  initialFailed: z.boolean().default(false),
  finalPassed: z.boolean().default(false),
  timestamp: z.number().nonnegative(),
  ackRequired: z.boolean().default(true),
});
export type LocalModelOutboxRecord = z.infer<typeof LocalModelOutboxRecordSchema>;

export interface RepairPlanConstraints {
  nonce: string;
  allowedFile: string;
  expectedOld: string;
  expectedNew: string;
}

export interface AppliedRepair {
  file: string;
  before: string;
  after: string;
}

export interface ToolClassification {
  tool: LocalModelTool;
  airgapSafe: boolean;
  reason: string;
}

export function extractJsonObject(text: string): unknown {
  let stripped = text.trim();
  if (stripped.startsWith('```')) {
    stripped = stripped.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('local model did not return a JSON object');
  }
  return JSON.parse(stripped.slice(start, end + 1));
}

export function validateRepairPlan(raw: unknown, constraints: RepairPlanConstraints): LocalRepairPlan {
  const plan = LocalRepairPlanSchema.parse(raw);
  const [repair, notify] = plan.steps;
  const reasons: string[] = [];
  if (repair.args.file !== constraints.allowedFile) {
    reasons.push(`file must be ${constraints.allowedFile}`);
  }
  if (repair.args.old !== constraints.expectedOld) {
    reasons.push('old text mismatch');
  }
  if (repair.args.new !== constraints.expectedNew) {
    reasons.push('new text mismatch');
  }
  if (!notify.args.message.includes(constraints.nonce)) {
    reasons.push('notify message missing nonce');
  }
  if (reasons.length > 0) {
    throw new Error(`invalid local repair plan: ${reasons.join('; ')}`);
  }
  return plan;
}

function assertInside(rootDir: string, requestedFile: string): string {
  if (isAbsolute(requestedFile)) {
    throw new Error('absolute paths are not allowed for local model repairs');
  }
  const root = resolve(rootDir);
  const target = resolve(root, requestedFile);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('repair path escapes sandbox');
  }
  return target;
}

export function applyRepairPlan(rootDir: string, plan: LocalRepairPlan): AppliedRepair {
  const [repair] = plan.steps;
  const file = assertInside(rootDir, repair.args.file);
  const before = readFileSync(file, 'utf8');
  const matches = before.split(repair.args.old).length - 1;
  if (matches !== 1) {
    throw new Error(`old text must appear exactly once; found ${matches}`);
  }
  const after = before.replace(repair.args.old, repair.args.new);
  writeFileSync(file, after, 'utf8');
  return { file, before, after };
}

export function buildOutboxRecord(input: {
  from?: string;
  to?: string;
  nonce: string;
  message: string;
  type?: string;
  initialFailed?: boolean;
  finalPassed?: boolean;
  timestamp?: number;
  ackRequired?: boolean;
}): LocalModelOutboxRecord {
  return LocalModelOutboxRecordSchema.parse({
    from: input.from ?? 'LOCAL-OLLAMA-1',
    to: input.to ?? 'codex-1',
    nonce: input.nonce,
    type: input.type ?? 'local_model_status',
    message: input.message,
    initialFailed: input.initialFailed ?? false,
    finalPassed: input.finalPassed ?? false,
    timestamp: input.timestamp ?? Date.now(),
    ackRequired: input.ackRequired ?? true,
  });
}

export function appendOutboxRecord(path: string, record: LocalModelOutboxRecord): void {
  const parsed = LocalModelOutboxRecordSchema.parse(record);
  appendFileSync(path, JSON.stringify(parsed) + '\n', 'utf8');
}

export function classifyTool(
  tool: LocalModelTool,
  options: { mcpServerLocalOnly?: boolean } = {},
): ToolClassification {
  switch (tool) {
    case 'read_file':
    case 'search_repo':
    case 'replace_text':
    case 'run_tests':
    case 'write_outbox':
      return { tool, airgapSafe: true, reason: 'local filesystem or process action' };
    case 'send_visible_status':
      return { tool, airgapSafe: true, reason: 'local Win32 terminal status surface' };
    case 'mcp_call':
      return options.mcpServerLocalOnly
        ? { tool, airgapSafe: true, reason: 'MCP server declared local-only' }
        : { tool, airgapSafe: false, reason: 'MCP may call network or external services' };
    default: {
      const neverTool: never = tool;
      return neverTool;
    }
  }
}
