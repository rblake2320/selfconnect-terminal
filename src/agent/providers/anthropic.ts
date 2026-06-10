import type { ProviderKind, ProviderTier } from '../../shared/contracts';
import type { PricePair } from '../cost-kernel';
import { approxTokens, type CompletionRequest, type CompletionResult, type ModelProvider } from './base';

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  price: PricePair;
  /** Treated as premium tier when true (e.g. Opus-class models). */
  premium?: boolean;
}

/**
 * Anthropic provider (cloud / premium tier). Uses the Messages API. Gated by
 * policy + approval + redaction upstream in the daemon.
 */
export class AnthropicProvider implements ModelProvider {
  readonly kind: ProviderKind = 'anthropic';
  readonly tier: ProviderTier;

  constructor(private readonly cfg: AnthropicConfig) {
    this.tier = cfg.premium ? 'premium' : 'cloud';
  }

  get model(): string {
    return this.cfg.model;
  }

  price(): PricePair {
    return this.cfg.price;
  }

  isConfigured(): boolean {
    return this.cfg.apiKey.trim().length > 0;
  }

  async ping(): Promise<{ alive: boolean; detail: string }> {
    if (!this.isConfigured()) return { alive: false, detail: 'no API key' };
    // We avoid spending tokens on a probe; configured == available.
    return { alive: true, detail: 'API key present' };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model || this.cfg.model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic error HTTP ${res.status}`);
    const data = (await res.json()) as {
      content?: { text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = data.content?.map((c) => c.text ?? '').join('') ?? '';
    return {
      text,
      inputTokens: data.usage?.input_tokens ?? approxTokens(req.system + req.prompt),
      outputTokens: data.usage?.output_tokens ?? approxTokens(text),
    };
  }
}
