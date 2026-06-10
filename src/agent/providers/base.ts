import type { ProviderKind, ProviderTier } from '../../shared/contracts';
import type { PricePair } from '../cost-kernel';

export interface CompletionRequest {
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Provider contract. Each provider declares its trust tier (local vs cloud vs
 * premium) and its pricing. `complete` performs the actual model call; the
 * daemon guarantees redaction + policy + approval have already run before this
 * is invoked for any cloud provider.
 */
export interface ModelProvider {
  readonly kind: ProviderKind;
  readonly tier: ProviderTier;
  /** Default model id for this provider. */
  readonly model: string;
  /** Cloud pricing per 1M tokens (local providers report zeros). */
  price(): PricePair;
  /** Whether the provider is configured/reachable enough to attempt a call. */
  isConfigured(): boolean;
  /** Liveness probe; must never throw. */
  ping(): Promise<{ alive: boolean; detail: string }>;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Shared token estimate for providers that don't return usage. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
