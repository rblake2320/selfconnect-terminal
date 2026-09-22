# Model launch and reply acceptance

The earlier terminal acceptance missed a CLI compatibility defect. A PATH-first
Codex 0.144.6 installation shadowed the npm user installation at 0.155.1. The old
client's requests were rejected before any answer could be generated.

The shadowing copy was updated, then its three launcher shims were reversibly
disabled so future user-prefix npm updates cannot leave that copy ahead of them.
Uninstalling the duplicate package hit a Windows EPERM error; no active agent
process was killed to remove locked files. `where codex` now resolves only the
user npm prefix, and `codex --version` returns 0.155.1.

A separate installed interactive test exposed inherited `TERM=dumb`, which
paused Codex at a confirmation. SCT now supplies `TERM=xterm-256color` and
`COLORTERM=truecolor` for its xterm PTY. The rebuilt, installed app launched
ordinary interactive Codex from the home folder with existing configuration and
hooks, asked an arithmetic question, and received the exact computed answer.

## Observed results

- Eight account-listed Codex selections: Worked.
- Claude Sonnet, Opus and Haiku aliases: Worked.
- Fourteen authenticated Antigravity selections: Worked.
- Ordinary interactive Codex launch through the corrected installed SCT: Worked.
- Source suite: 368 tests in 48 files passed; TypeScript checks passed.
- Legacy Gemini CLI: Failed with `UNSUPPORTED_CLIENT`; replaced for personal
  account use by the already installed and authenticated Antigravity CLI (`agy`).

The model matrix ran real CLI subprocesses inside the installed app's PTY,
using existing subscription logins and removing API-key fallback from the test
environment. Each pass required exit zero and an exact model-produced reply,
not an echoed prompt. The matrix used isolated tool/config options; the separate
interactive Codex test exercised normal user configuration. These are current
account-specific launch/reply checks, not a promise about every provider model
or future availability. Antigravity model/effort selections count separately.

See [machine-readable model results](model-launch.json). Private evidence retains
the initial command-quoting harness failure, the old TERM prompt, provider
refusal, native output, and corrected receipts. Existing agent sessions must be
restarted to load an updated CLI; the desktop shortcut points to the new SCT.

## Repeatable checks

Run `node scripts/cli-doctor.cjs` to detect conflicting PATH installations.
Set `SCT_TEST_EXE` to the installed exe and run
`node scripts/model-installed-acceptance.cjs` for the Codex/Claude/legacy Gemini
matrix. Its legacy Gemini row deliberately reports the refusal rather than a
false pass. Set `SCT_PROBE_AGY_ONLY=1` for the current Antigravity catalog instead.
Run `node scripts/model-interactive-acceptance.cjs` for normal interactive Codex.
These reply tests consume subscription allowances; the inventory check is local.

Google documents the personal-account transition in its
[official migration announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
and [CLI installation guide](https://antigravity.google/docs/getting-started?tab=cli).
The local `agy` launcher was made available in the existing npm PATH directory,
so terminals with an older PATH snapshot can find it without changing accounts.
