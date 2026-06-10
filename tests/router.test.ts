import { describe, it, expect } from 'vitest';
import { ModelRouter } from '../src/agent/model-router';
import { PolicyEngine } from '../src/daemon/policy-engine';
import { ProviderRegistry } from '../src/agent/provider-registry';
import { loadConfig } from '../src/daemon/config';

function makeRegistry(overrides: Record<string, string> = {}) {
  const cfg = loadConfig({
    SELFCONNECT_LOCAL_ONLY: 'false',
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'gemma3',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    OPENAI_COMPAT_URL: 'https://api.example.com/v1',
    OPENAI_COMPAT_API_KEY: 'sk-test',
    OPENAI_COMPAT_MODEL: 'gpt-test',
    ...overrides,
  } as NodeJS.ProcessEnv);
  return { cfg, registry: new ProviderRegistry(cfg) };
}

describe('model router', () => {
  it('local-only mode routes to local and never to cloud', () => {
    const { registry } = makeRegistry();
    const policy = new PolicyEngine({ localOnly: true, maxSpendPerCallUsd: 1 });
    const router = new ModelRouter(registry, policy);

    const decision = router.route({ prefer: 'anthropic', estimatedCostUsd: 0 });
    expect(decision.tier).toBe('local');
    expect(decision.provider).toBe('ollama');
    expect(decision.blocked).toBe(false);
    expect(decision.requiresApproval).toBe(false);
  });

  it('local-only blocks an explicit cloud preference (hard block)', () => {
    const { registry } = makeRegistry();
    const policy = new PolicyEngine({ localOnly: true, maxSpendPerCallUsd: 1 });
    const router = new ModelRouter(registry, policy);

    // Even when caller prefers cloud, local-only forces local routing.
    const decision = router.route({ prefer: 'openai-compatible', estimatedCostUsd: 0 });
    expect(decision.provider).toBe('ollama');
    expect(decision.tier).toBe('local');
  });

  it('cloud preference requires approval when not local-only', () => {
    const { registry } = makeRegistry();
    const policy = new PolicyEngine({ localOnly: false, maxSpendPerCallUsd: 1 });
    const router = new ModelRouter(registry, policy);

    const decision = router.route({ prefer: 'openai-compatible', estimatedCostUsd: 0.01 });
    expect(decision.provider).toBe('openai-compatible');
    expect(decision.tier).toBe('cloud');
    expect(decision.requiresApproval).toBe(true);
    expect(decision.blocked).toBe(false);
  });

  it('falls back to local when preferred cloud provider is not configured', () => {
    const { registry } = makeRegistry({ OPENAI_COMPAT_URL: '', OPENAI_COMPAT_MODEL: '' });
    const policy = new PolicyEngine({ localOnly: false, maxSpendPerCallUsd: 1 });
    const router = new ModelRouter(registry, policy);

    const decision = router.route({ prefer: 'openai-compatible', estimatedCostUsd: 0 });
    expect(decision.provider).toBe('ollama');
    expect(decision.reason).toMatch(/not configured/);
  });

  it('blocks cloud calls over the per-call spend cap', () => {
    const { registry } = makeRegistry();
    const policy = new PolicyEngine({ localOnly: false, maxSpendPerCallUsd: 0.001 });
    const router = new ModelRouter(registry, policy);

    const decision = router.route({ prefer: 'anthropic', estimatedCostUsd: 5 });
    expect(decision.blocked).toBe(true);
    expect(decision.blockReason).toMatch(/cap/);
  });
});
