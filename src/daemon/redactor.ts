/**
 * Secret redactor. HARD SECURITY RULE 6: redaction runs over every byte of
 * context BEFORE any cloud model call. This module is pure and synchronous so
 * it can be unit tested without any I/O.
 *
 * Each rule has a name (for per-category counts) and a regex. Order matters:
 * more specific provider key patterns run before generic high-entropy ones so a
 * single secret is attributed to the most precise category.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Replacement keeps a hint of what was removed without leaking the value. */
  label: string;
}

export interface RedactionReport {
  redacted: string;
  total: number;
  counts: Record<string, number>;
}

const RULES: RedactionRule[] = [
  {
    name: 'anthropic_key',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    label: '[REDACTED:anthropic_key]',
  },
  {
    name: 'openai_key',
    pattern: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g,
    label: '[REDACTED:openai_key]',
  },
  {
    name: 'aws_access_key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    label: '[REDACTED:aws_access_key]',
  },
  {
    name: 'github_token',
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    label: '[REDACTED:github_token]',
  },
  {
    name: 'slack_token',
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    label: '[REDACTED:slack_token]',
  },
  {
    name: 'private_key_block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    label: '[REDACTED:private_key]',
  },
  {
    name: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    label: '[REDACTED:jwt]',
  },
  {
    name: 'bearer_token',
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._-]{16,}/g,
    label: '[REDACTED:bearer]',
  },
  {
    name: 'env_assignment',
    // KEY/SECRET/TOKEN/PASSWORD style env assignments: capture the name, redact the value.
    pattern: /\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL)S?)\s*[=:]\s*("?)([^\s"']{6,})\2/g,
    label: '',
  },
  {
    name: 'url_credentials',
    // protocol://user:pass@host -> redact the password segment.
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/g,
    label: '',
  },
];

export function redact(input: string): RedactionReport {
  const counts: Record<string, number> = {};
  let out = input;

  for (const rule of RULES) {
    let n = 0;
    if (rule.name === 'env_assignment') {
      out = out.replace(rule.pattern, (_m, name: string) => {
        n++;
        return `${name}=[REDACTED:secret]`;
      });
    } else if (rule.name === 'url_credentials') {
      out = out.replace(rule.pattern, (_m, prefix: string, _pass: string, at: string) => {
        n++;
        return `${prefix}[REDACTED:credential]${at}`;
      });
    } else {
      out = out.replace(rule.pattern, () => {
        n++;
        return rule.label;
      });
    }
    if (n > 0) counts[rule.name] = n;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { redacted: out, total, counts };
}

/** Convenience: returns true if the input contains any detectable secret. */
export function containsSecret(input: string): boolean {
  return redact(input).total > 0;
}
