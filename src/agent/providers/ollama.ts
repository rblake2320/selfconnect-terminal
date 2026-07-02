import type { ProviderKind, ProviderTier } from '../../shared/contracts';
import type { PricePair } from '../cost-kernel';
import { approxTokens, type CompletionRequest, type CompletionResult, type ModelProvider } from './base';

/**
 * Ollama provider (local tier). Talks to a local Ollama daemon over HTTP. Local
 * calls are free and never gated by cloud policy.
 */
export class OllamaProvider implements ModelProvider {
  readonly kind: ProviderKind = 'ollama';
  readonly tier: ProviderTier = 'local';

  constructor(
    private readonly url: string,
    readonly model: string,
  ) {}

  price(): PricePair {
    return { inputPerMillion: 0, outputPerMillion: 0 };
  }

  isConfigured(): boolean {
    return this.url.trim().length > 0;
  }

  async ping(): Promise<{ alive: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.url}/api/tags`, { method: 'GET' });
      if (!res.ok) return { alive: false, detail: `HTTP ${res.status}` };
      return { alive: true, detail: 'ollama reachable' };
    } catch (err) {
      return { alive: false, detail: `offline: ${(err as Error).message}` };
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await fetch(`${this.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model || this.model,
        system: req.system,
        prompt: req.prompt,
        stream: false,
        // Ollama defaults num_ctx to 4096, which silently truncates large review
        // snapshots regardless of the model's real ceiling (gemma3: 131072). Raise
        // the window so session-scale review actually sees its input; low temp for
        // deterministic, review-grade output.
        options: {
          num_ctx: 32768,
          temperature: 0.2,
        },
      }),
    });
    if (!res.ok) {
      // Surface the response body — a bare "HTTP 404" hides Ollama's actual
      // message (e.g. "model 'X' not found"), which is what you need to debug.
      const body = await res.text().catch(() => '');
      throw new Error(
        `Ollama ${res.status} ${res.statusText} on /api/generate ` +
          `(model=${req.model || this.model}): ${body.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as {
      response?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const text = data.response ?? '';
    return {
      text,
      inputTokens: data.prompt_eval_count ?? approxTokens(req.system + req.prompt),
      outputTokens: data.eval_count ?? approxTokens(text),
    };
  }
}
