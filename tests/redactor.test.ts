import { describe, it, expect } from 'vitest';
import { redact, containsSecret } from '../src/daemon/redactor';

describe('redactor', () => {
  it('removes an Anthropic key and reports a count', () => {
    const input = 'export ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX';
    const { redacted, total, counts } = redact(input);
    expect(redacted).not.toContain('sk-ant-api03');
    expect(total).toBeGreaterThan(0);
    // either the precise anthropic rule or the env-assignment rule catches it
    expect(counts.anthropic_key ?? counts.env_assignment).toBeGreaterThan(0);
  });

  it('removes AWS access keys and GitHub tokens', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE and ghp_' + 'a'.repeat(36);
    const { redacted, counts } = redact(input);
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).not.toMatch(/ghp_a{36}/);
    expect(counts.aws_access_key).toBe(1);
    expect(counts.github_token).toBe(1);
  });

  it('redacts URL embedded credentials and bearer tokens', () => {
    const input =
      'db = postgres://admin:Sup3rSecretPass@db.internal:5432/app\n' +
      'Authorization: Bearer abcdef0123456789ABCDEF';
    const { redacted, total } = redact(input);
    expect(redacted).not.toContain('Sup3rSecretPass');
    expect(redacted).not.toContain('abcdef0123456789ABCDEF');
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it('redacts private key blocks', () => {
    const input =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const { redacted, counts } = redact(input);
    expect(redacted).toContain('[REDACTED:private_key]');
    expect(redacted).not.toContain('MIIEowIBAAKCAQEA');
    expect(counts.private_key_block).toBe(1);
  });

  it('reports zero on clean text and containsSecret is false', () => {
    const input = 'just a normal sentence with no secrets in it';
    const { total } = redact(input);
    expect(total).toBe(0);
    expect(containsSecret(input)).toBe(false);
  });

  it('counts multiple secrets across categories', () => {
    const input =
      'AKIAIOSFODNN7EXAMPLE\nPASSWORD=hunter2hunter2\nAKIAABCDEFGHIJKLMNOP';
    const { total } = redact(input);
    expect(total).toBeGreaterThanOrEqual(3);
  });
});
