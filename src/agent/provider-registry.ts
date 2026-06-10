import type { ProviderKind, ProviderLiveness } from '../shared/contracts';
import type { DaemonConfig } from '../daemon/config';
import type { ModelProvider } from './providers/base';
import { OllamaProvider } from './providers/ollama';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';
import { AnthropicProvider } from './providers/anthropic';

/**
 * Builds and holds the set of model providers from daemon config. The registry
 * is the only place that wires provider keys into provider instances — keys
 * never leave the daemon (HARD RULE 1).
 */
export class ProviderRegistry {
  private providers = new Map<ProviderKind, ModelProvider>();

  constructor(cfg: DaemonConfig) {
    this.providers.set('ollama', new OllamaProvider(cfg.ollamaUrl, cfg.ollamaModel));
    this.providers.set(
      'openai-compatible',
      new OpenAiCompatibleProvider({
        url: cfg.openaiCompatUrl,
        apiKey: cfg.openaiCompatApiKey,
        model: cfg.openaiCompatModel,
        price: { inputPerMillion: cfg.baselineInputPrice, outputPerMillion: cfg.baselineOutputPrice },
      }),
    );
    this.providers.set(
      'anthropic',
      new AnthropicProvider({
        apiKey: cfg.anthropicApiKey,
        model: cfg.anthropicModel,
        price: {
          inputPerMillion: cfg.anthropicInputPrice,
          outputPerMillion: cfg.anthropicOutputPrice,
        },
        premium: /opus/i.test(cfg.anthropicModel),
      }),
    );
  }

  get(kind: ProviderKind): ModelProvider {
    const p = this.providers.get(kind);
    if (!p) throw new Error(`Unknown provider: ${kind}`);
    return p;
  }

  all(): ModelProvider[] {
    return [...this.providers.values()];
  }

  local(): ModelProvider {
    return this.get('ollama');
  }

  /** Probe every provider for liveness. Never throws. */
  async liveness(): Promise<ProviderLiveness[]> {
    const out: ProviderLiveness[] = [];
    for (const p of this.providers.values()) {
      const r = await p.ping();
      out.push({ kind: p.kind, alive: r.alive, detail: r.detail });
    }
    return out;
  }
}
