#!/usr/bin/env node
/**
 * Visible two-way local model chat harness for SelfConnect.
 *
 * This intentionally stays interactive. It asks a local Ollama model for a
 * compact message, sends that message to a guarded Codex terminal through
 * SelfConnect, then reads replies typed or injected into this terminal and
 * sends local-model responses back through the same guarded path.
 */

const readline = require('node:readline');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');

const args = process.argv.slice(2);

function arg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  return fallback;
}

const model = arg('--model', process.env.OLLAMA_MODEL || 'hermes3:3b');
const ollamaUrl = arg('--ollama-url', process.env.OLLAMA_URL || 'http://127.0.0.1:11434');
const codexHwnd = arg('--codex-hwnd', '');
const codexTitle = arg('--codex-title', 'codex 1');
const codexClass = arg('--codex-class', 'CASCADIA_HOSTING_WINDOW_CLASS');
const nonce = arg('--nonce', `SC_LOCAL_CHAT_${crypto.randomBytes(4).toString('hex').toUpperCase()}`);
const title = `LOCAL-OLLAMA-CHAT-${nonce.slice(-8)}`;

process.stdout.write(`\x1b]0;${title}\x07`);

function now() {
  return new Date().toISOString();
}

function print(line = '') {
  process.stdout.write(`${line}\n`);
}

function extractJson(text) {
  let stripped = String(text || '').trim();
  if (stripped.startsWith('```')) {
    stripped = stripped.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model did not return a JSON object');
  return JSON.parse(stripped.slice(start, end + 1));
}

async function ollama(prompt) {
  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: { temperature: 0.1, num_predict: 180 },
      prompt,
    }),
  });
  if (!response.ok) throw new Error(`ollama generate failed: ${response.status} ${response.statusText}`);
  const body = await response.json();
  return String(body.response || '').trim();
}

function validateMessage(raw, requireNonce) {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed.message !== 'string') throw new Error('JSON must contain string message');
  const message = parsed.message.replace(/\s+/g, ' ').trim();
  if (!message) throw new Error('message is empty');
  if (message.length > 420) throw new Error('message is too long');
  if (requireNonce && !message.includes(nonce)) {
    print(`[${now()}] nonce_missing_appended=true`);
    return `${message} NONCE=${nonce}`;
  }
  return message;
}

async function askLocalModel(kind, input = '') {
  const prompt = [
    'You are LOCAL-OLLAMA-1 inside a visible SelfConnect terminal test.',
    'Return only one compact JSON object. No markdown. No newline characters inside string values.',
    'Schema: {"message":"<one short line>"}',
    `NONCE=${nonce}`,
    kind === 'initial'
      ? 'Task: send Codex-1 one short greeting and ask for a tiny arithmetic repair challenge. Include the NONCE.'
      : `Codex replied: ${JSON.stringify(input)}. Respond with one short useful line. Include the NONCE.`,
  ].join('\n');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const raw = await ollama(prompt + `\nAttempt=${attempt}`);
    print(`[${now()}] raw_model_hash=${crypto.createHash('sha256').update(raw).digest('hex')}`);
    try {
      const message = validateMessage(raw, true);
      print(`[${now()}] model_message=${message}`);
      return message;
    } catch (err) {
      print(`[${now()}] validation_reject attempt=${attempt} reason=${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error('local model did not produce a valid chat message after retries');
}

function sendToCodex(message) {
  if (!codexHwnd) throw new Error('missing --codex-hwnd');
  const full = `[LOCAL-OLLAMA-1 -> CODEX-1] ${message}`;
  const result = childProcess.spawnSync(
    'python',
    [
      '-m',
      'sc_cli',
      'send',
      '--hwnd',
      codexHwnd,
      '--text',
      full,
      '--submit',
      '--allow-input',
      '--expect-class',
      codexClass,
      '--expect-title',
      codexTitle,
      '--char-delay',
      '0.002',
    ],
    {
      cwd: 'C:\\Users\\techai\\PKA testing\\selfconnect',
      encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1' },
    },
  );
  print(`[${now()}] send_exit=${result.status}`);
  if (result.stdout.trim()) print(`[${now()}] send_stdout=${result.stdout.trim()}`);
  if (result.stderr.trim()) print(`[${now()}] send_stderr=${result.stderr.trim()}`);
  if (result.status !== 0) throw new Error('SelfConnect send failed');
}

async function main() {
  print('==============================================================================');
  print('[LOCAL-OLLAMA-1] VISIBLE TWO-WAY SELFCONNECT CHAT');
  print(`title: ${title}`);
  print(`model: ${model}`);
  print(`nonce: ${nonce}`);
  print(`target: hwnd=${codexHwnd} title_contains=${codexTitle}`);
  print('This window stays open. Send a reply into this terminal to continue the chat.');
  print('==============================================================================');

  const initial = await askLocalModel('initial');
  sendToCodex(initial);
  print(`[${now()}] WAITING_FOR_CODEX_REPLY`);
  print('Type or SelfConnect-send one line here. Example: "Codex says: give me a one-line plan."');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.setPrompt('codex-reply> ');
  rl.prompt();
  rl.on('line', async (line) => {
    const reply = line.trim();
    if (!reply) {
      rl.prompt();
      return;
    }
    if (/^(exit|quit)$/i.test(reply)) {
      print(`[${now()}] closing`);
      rl.close();
      return;
    }
    try {
      print(`[${now()}] codex_reply_received=${reply}`);
      const response = await askLocalModel('reply', reply);
      sendToCodex(response);
      print(`[${now()}] WAITING_FOR_CODEX_REPLY`);
    } catch (err) {
      print(`[${now()}] ERROR=${err instanceof Error ? err.message : String(err)}`);
    }
    rl.prompt();
  });
}

main().catch((err) => {
  print(`[${now()}] FATAL=${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
