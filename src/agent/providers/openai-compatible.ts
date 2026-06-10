import type { ProviderKind, ProviderTier } from '../../shared/contracts';
import type { PricePair } from '../cost-kernel';
import { approxTokens, type CompletionRequest, type CompletionResult, type ModelProvider } from './base';

export interface OpenAiCompatConfig {
  url: string;
  apiKey: string;
  model: string;
  price: PricePair;
}

/**
 * OpenAI-compatible provider (cloud tier). Covers OpenAI itself plus any
 * /v1/chat/completions-compatible gateway. Calls are gated by policy + approval
 * + redaction upstream in the daemon.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly kind: ProviderKind = 'openai-compatible';
  readonly tier: ProviderTier = 'cloud';

  constructor(private readonly cfg: OpenAiCompatConfig) {}

  get model(): string {
    return this.cfg.model;
  }

  price(): PricePair {
    return this.cfg.price;
  }

  isConfigured(): boolean {
    return this.cfg.url.trim().length > 0 && this.cfg.model.trim().length > 0;
  }

  async ping(): Promise<{ alive: boolean; detail: string }> {
    if (!this.isConfigured()) return { alive: false, detail: 'not configured' };
    try {
      const res = await fetch(`${this.cfg.url}/models`, {
        method: 'GET',
        headers: this.headers(),
      });
      return { alive: res.ok, detail: res.ok ? 'reachable' : `HTTP ${res.status}` };
    } catch (err) {
      return { alive: false, detail: `offline: ${(err as Error).message}` };
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await fetch(`${this.cfg.url}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model || this.cfg.model,
        max_tokens: req.maxTokens ?? 1024,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI-compatible error HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text,
      inputTokens: data.usage?.prompt_tokens ?? approxTokens(req.system + req.prompt),
      outputTokens: data.usage?.completion_tokens ?? approxTokens(text),
    };
  }
}
