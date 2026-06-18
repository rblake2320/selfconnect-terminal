#!/usr/bin/env node
/**
 * Real local-model action baseline for SelfConnect Terminal.
 *
 * This is intentionally executable without a TypeScript build. It calls Ollama,
 * gives the model real sandbox repair tasks, validates strict JSON tool plans,
 * applies only allowed sandbox edits, reruns tests, writes durable outbox
 * records, and saves a redacted baseline artifact.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const model = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : process.env.OLLAMA_MODEL || 'hermes3:3b';
const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const nonce = `SC_TERM_BASELINE_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const workRoot = path.join(os.tmpdir(), 'selfconnect-terminal-local-baseline', `${runId}-${nonce.slice(-8)}`);
const outboxPath = path.join(workRoot, 'outbox.jsonl');
const resultsDir = path.join(repoRoot, 'docs', 'results');
const artifactPath = path.join(resultsDir, `local-model-baseline-${model.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${nonce.slice(-8)}.json`);

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function write(file, content) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, content, 'utf8');
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function run(command, cwd) {
  return childProcess.spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 30000,
  });
}

async function ollamaGenerate(prompt, numPredict = 256) {
  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        num_ctx: 2048,
        num_predict: numPredict,
        temperature: 0,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`ollama generate failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  return String(body.response || '').trim();
}

function extractJsonObject(text) {
  let stripped = text.trim();
  if (stripped.startsWith('```')) {
    stripped = stripped.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('model did not return a JSON object');
  }
  return JSON.parse(stripped.slice(start, end + 1));
}

function normalizeToolFile(file, task) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new Error(`file must be ${task.file}`);
  }
  const trimmed = file.trim().replaceAll('\\', '/');
  if (trimmed.includes('..') || path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
    throw new Error('file path is not sandbox-safe');
  }
  const normalized = trimmed.replace(/^\.\//, '');
  if (normalized === task.file || path.posix.basename(normalized) === task.file) {
    return task.file;
  }
  throw new Error(`file must be ${task.file}`);
}

function validatePlan(raw, task) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps) || raw.steps.length !== 2) {
    throw new Error('plan must contain exactly two steps');
  }
  const [repair, notify] = raw.steps;
  if (repair.tool !== 'replace_text') throw new Error('first tool must be replace_text');
  if (notify.tool !== 'write_outbox') throw new Error('second tool must be write_outbox');
  const args = repair.args || {};
  const notifyArgs = notify.args || {};
  const reasons = [];
  let normalizedFile = '';
  try {
    normalizedFile = normalizeToolFile(args.file, task);
  } catch (err) {
    reasons.push(err instanceof Error ? err.message : String(err));
  }
  if (args.old !== task.oldText) reasons.push('old text mismatch');
  if (args.new !== task.newText) reasons.push('new text mismatch');
  if (typeof notifyArgs.message !== 'string' || !notifyArgs.message.includes(task.nonce)) {
    reasons.push('outbox message must include nonce');
  }
  if (reasons.length) throw new Error(reasons.join('; '));
  return {
    ...raw,
    steps: [
      { ...repair, args: { ...args, file: normalizedFile } },
      notify,
    ],
  };
}

function applyPlan(sandbox, plan, task) {
  const target = path.resolve(sandbox, plan.steps[0].args.file);
  const rel = path.relative(sandbox, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('repair path escapes sandbox');
  const before = read(target);
  const count = before.split(task.oldText).length - 1;
  if (count !== 1) throw new Error(`old text must appear exactly once; found ${count}`);
  const after = before.replace(task.oldText, task.newText);
  write(target, after);
  return { beforeHash: sha256(before), afterHash: sha256(after) };
}

function appendOutbox(record) {
  mkdirp(path.dirname(outboxPath));
  fs.appendFileSync(outboxPath, JSON.stringify(record) + '\n', 'utf8');
}

function makeTask(name, spec) {
  const sandbox = path.join(workRoot, name);
  mkdirp(sandbox);
  write(path.join(sandbox, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
  for (const [file, content] of Object.entries(spec.files)) {
    write(path.join(sandbox, file), content);
  }
  return {
    name,
    sandbox,
    nonce: `${nonce}_${name.toUpperCase()}`,
    ...spec,
  };
}

function promptFor(task, lastError = '') {
  const failureText = `${task.initial.stdout || ''}\n${task.initial.stderr || ''}`.slice(0, 900);
  const retry = lastError
    ? `\nYour previous output failed validation: ${lastError}\nReturn corrected JSON only.`
    : '';
  return [
    'You are LOCAL-OLLAMA-1 inside SelfConnect Terminal.',
    'You must return only valid compact JSON. No markdown. No explanation.',
    'Use exactly this schema:',
    '{"steps":[{"tool":"replace_text","args":{"file":"<file>","old":"<exact old text>","new":"<exact new text>"}},{"tool":"write_outbox","args":{"message":"<one line including NONCE>"}}]}',
    `NONCE=${task.nonce}`,
    `Target file=${task.file}`,
    `Allowed old text=${JSON.stringify(task.oldText)}`,
    `Allowed new text=${JSON.stringify(task.newText)}`,
    'Broken file content:',
    read(path.join(task.sandbox, task.file)),
    'Failing test output:',
    failureText,
    retry,
  ].join('\n');
}

async function runTask(task) {
  task.initial = run(task.testCommand, task.sandbox);
  const attempts = [];
  let lastError = '';
  let plan = null;
  for (let i = 1; i <= 3; i += 1) {
    const raw = await ollamaGenerate(promptFor(task, lastError), 320);
    const attempt = { attempt: i, rawHash: sha256(raw), valid: false, error: '' };
    try {
      const parsed = extractJsonObject(raw);
      plan = validatePlan(parsed, task);
      attempt.valid = true;
      attempts.push(attempt);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      attempt.error = lastError;
      attempts.push(attempt);
    }
  }
  if (!plan) {
    return {
      task: task.name,
      verdict: 'FAIL',
      reason: 'no valid plan after retries',
      attempts,
      initialReturnCode: task.initial.status,
      finalReturnCode: null,
    };
  }
  const patch = applyPlan(task.sandbox, plan, task);
  const final = run(task.testCommand, task.sandbox);
  const outboxMessage = plan.steps[1].args.message;
  const record = {
    from: 'LOCAL-OLLAMA-1',
    to: 'codex-1',
    nonce: task.nonce,
    type: 'local_model_baseline',
    task: task.name,
    message: outboxMessage,
    initialFailed: task.initial.status !== 0,
    finalPassed: final.status === 0,
    timestamp: Date.now(),
    ackRequired: true,
  };
  appendOutbox(record);
  return {
    task: task.name,
    verdict: final.status === 0 ? 'PASS' : 'FAIL',
    attempts,
    initialReturnCode: task.initial.status,
    finalReturnCode: final.status,
    outboxWritten: true,
    patch,
    initialOutputHash: sha256(`${task.initial.stdout || ''}${task.initial.stderr || ''}`),
    finalOutputHash: sha256(`${final.stdout || ''}${final.stderr || ''}`),
  };
}

async function main() {
  mkdirp(workRoot);
  mkdirp(resultsDir);
  const tasks = [
    makeTask('add', {
      file: 'buggy_math.js',
      files: {
        'buggy_math.js': 'exports.add = (a, b) => a - b;\n',
        'buggy_math.test.js': [
          "const assert = require('node:assert/strict');",
          "const { add } = require('./buggy_math');",
          'assert.equal(add(2, 3), 5);',
          "console.log('ok add');",
          '',
        ].join('\n'),
      },
      testCommand: [process.execPath, 'buggy_math.test.js'],
      oldText: 'a - b',
      newText: 'a + b',
    }),
    makeTask('greeting', {
      file: 'greeting.js',
      files: {
        'greeting.js': "exports.greet = (name) => `Hello ${name}`;\n",
        'greeting.test.js': [
          "const assert = require('node:assert/strict');",
          "const { greet } = require('./greeting');",
          "assert.equal(greet('Ron'), 'Hello, Ron!');",
          "console.log('ok greeting');",
          '',
        ].join('\n'),
      },
      testCommand: [process.execPath, 'greeting.test.js'],
      oldText: 'Hello ${name}',
      newText: 'Hello, ${name}!',
    }),
  ];

  console.log(`[baseline] model=${model}`);
  console.log(`[baseline] workRoot=${workRoot}`);
  const startedAt = Date.now();
  const results = [];
  for (const task of tasks) {
    console.log(`[task:${task.name}] running real action baseline`);
    const result = await runTask(task);
    results.push(result);
    console.log(`[task:${task.name}] ${result.verdict}`);
  }
  const passCount = results.filter((r) => r.verdict === 'PASS').length;
  const artifact = {
    verdict: passCount === tasks.length ? 'PASS' : passCount > 0 ? 'PARTIAL' : 'FAIL',
    model,
    ollamaUrl,
    nonce,
    redacted: true,
    startedAt,
    elapsedMs: Date.now() - startedAt,
    workRootHint: path.join('%TEMP%', 'selfconnect-terminal-local-baseline', path.basename(workRoot)),
    outboxFile: 'outbox.jsonl',
    tasks: results,
    baseline: {
      tasksRun: tasks.length,
      passed: passCount,
      failed: tasks.length - passCount,
      retriesAllowed: 3,
      realActions: [
        'ollama_generate',
        'strict_json_validate',
        'sandbox_replace_text',
        'node_test_before_after',
        'durable_outbox_write',
      ],
    },
  };
  write(artifactPath, JSON.stringify(artifact, null, 2));
  console.log(`[baseline] artifact=${artifactPath}`);
  console.log(`[baseline] verdict=${artifact.verdict} passed=${passCount}/${tasks.length}`);
  process.exitCode = artifact.verdict === 'FAIL' ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
