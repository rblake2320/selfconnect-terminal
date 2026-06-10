import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Builds the review snapshot: cwd, shell, the last N terminal lines, git status,
 * git diff (excluding lockfiles / huge files), package.json, and README/plan
 * docs. The raw snapshot is later redacted before any cloud routing.
 */

const LOCKFILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
  'Gemfile.lock',
];

const MAX_DIFF_BYTES = 60_000;
const MAX_TERMINAL_LINES = 300;

export interface SnapshotInput {
  cwd: string;
  shell: string;
  terminalLines: string[];
}

export interface ContextSnapshotData {
  cwd: string;
  shell: string;
  terminalTail: string;
  gitStatus: string;
  gitDiff: string;
  packageJson: string;
  docs: string;
}

function safeGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function readIfExists(path: string, maxBytes = 20_000): string {
  try {
    if (!existsSync(path)) return '';
    const content = readFileSync(path, 'utf8');
    return content.length > maxBytes ? content.slice(0, maxBytes) + '\n...[truncated]' : content;
  } catch {
    return '';
  }
}

export function buildSnapshot(input: SnapshotInput): ContextSnapshotData {
  const terminalTail = input.terminalLines.slice(-MAX_TERMINAL_LINES).join('\n');

  const gitStatus = safeGit(['status', '--porcelain=v1', '--branch'], input.cwd);

  // Build a pathspec that excludes lockfiles, then guard against huge diffs.
  const excludes = LOCKFILES.map((f) => `:(exclude)${f}`);
  let gitDiff = safeGit(['diff', '--', '.', ...excludes], input.cwd);
  if (gitDiff.length > MAX_DIFF_BYTES) {
    gitDiff = gitDiff.slice(0, MAX_DIFF_BYTES) + '\n...[diff truncated: exceeds size cap]';
  }

  const packageJson = readIfExists(join(input.cwd, 'package.json'));

  const docs = ['README.md', 'README', 'PLAN.md', 'plan.md', 'ARCHITECTURE.md']
    .map((name) => {
      const body = readIfExists(join(input.cwd, name), 8_000);
      return body ? `### ${name}\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  return {
    cwd: input.cwd,
    shell: input.shell,
    terminalTail,
    gitStatus,
    gitDiff,
    packageJson,
    docs,
  };
}

/** Flatten a snapshot into a single text blob suitable for redaction + routing. */
export function snapshotToText(s: ContextSnapshotData): string {
  return [
    `# Working directory\n${s.cwd}`,
    `# Shell\n${s.shell}`,
    `# Terminal (last ${MAX_TERMINAL_LINES} lines)\n${s.terminalTail}`,
    `# git status\n${s.gitStatus}`,
    `# git diff (lockfiles excluded)\n${s.gitDiff}`,
    `# package.json\n${s.packageJson}`,
    `# docs\n${s.docs}`,
  ].join('\n\n');
}
