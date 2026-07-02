import type { ReviewMode, ReviewResult } from '../shared/contracts';
import type { ModelProvider } from './providers/base';
import { CostKernel } from './cost-kernel';
import { redact } from '../daemon/redactor';

/**
 * Review Agent. HARD SECURITY RULE 11: this agent is strictly read-only — it
 * never executes commands or writes files. It only takes a (already-redacted)
 * context snapshot, asks a model to review it, and returns text.
 *
 * Redaction is applied here as a defense-in-depth second pass (HARD RULE 6):
 * even if a caller forgets to redact, no raw secret reaches the provider.
 */

const MODE_PROMPTS: Record<ReviewMode, string> = {
  optimize: 'Identify concrete performance and clarity optimizations. Be specific and actionable.',
  bugs: 'Find likely bugs, race conditions, and incorrect edge-case handling.',
  architecture: 'Critique the architecture: coupling, boundaries, and structural risks.',
  security: 'Perform a security review: secrets handling, injection, unsafe operations, trust boundaries.',
  'next-steps': 'Propose a prioritized list of next steps to move this work forward.',
  full: 'Give a comprehensive review covering bugs, security, architecture, optimization, and next steps.',
};

const SYSTEM_PROMPT =
  'You are SelfConnect Review, a read-only senior engineering reviewer. ' +
  'You never run commands or modify files. You analyze the provided redacted ' +
  'snapshot and return focused, actionable findings. ' +
  'Do NOT summarize or restate the snapshot. Output ONLY the requested review as a ' +
  'numbered list of specific findings, each tied to a concrete location and a ' +
  'recommended action. If nothing qualifies for the requested mode, say so in one line.';

export class ReviewAgent {
  /** Read-only marker surfaced to the Agent Mesh widget. */
  readonly readOnly = true;

  constructor(private readonly cost: CostKernel) {}

  buildPrompt(mode: ReviewMode, redactedContext: string): { system: string; prompt: string } {
    return {
      system: SYSTEM_PROMPT,
      prompt: `Review mode: ${mode}\nInstructions: ${MODE_PROMPTS[mode]}\n\n--- BEGIN SNAPSHOT ---\n${redactedContext}\n--- END SNAPSHOT ---`,
    };
  }

  /**
   * Run a review against the given provider. `rawContext` is redacted here
   * regardless of upstream redaction. Returns text + token-verified cost.
   */
  async run(
    mode: ReviewMode,
    rawContext: string,
    provider: ModelProvider,
  ): Promise<ReviewResult> {
    const { redacted, total } = redact(rawContext);
    const { system, prompt } = this.buildPrompt(mode, redacted);

    const result = await provider.complete({
      model: provider.model,
      system,
      prompt,
    });

    const cost = this.cost.record(
      provider.tier,
      result.inputTokens,
      result.outputTokens,
      provider.price(),
    );

    return {
      mode,
      provider: provider.kind,
      model: provider.model,
      content: result.text,
      redactionCount: total,
      cost,
    };
  }
}
