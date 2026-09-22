# Windows daily-terminal and SelfConnect verification — 2026-09-22

This update turns previously misleading shell/tool behavior into observable
execution and records a bounded Windows installed-app verification. BPC and TSK
remain independent projects. It does not claim every ecosystem repository is
integrated, nor automatic failover.

## Delivered

- On-demand TypeSafe/Jev advice from an explicitly previewed, redacted excerpt;
  typed schema, bounded input/output, timeout, expiry, local-only/integrity gates,
  and Windows user-bound DPAPI credentials. No autonomous execution.
- Real shell passthrough for URLs and CLI-agent slash commands; separate app
  commands; actual governed subprocess execution and real error propagation.
- Persistent settings and periodic/on-exit snapshots; read-only saved history;
  continuous signed replay, ledger integrity gates, and truthful event counts.
- MCP initialization lifecycle, bounded responses, transport error/timeout
  handling, and a shared governed call path. Default config resolves under
  app userData. Servers are used on demand.
- Electron 44.4.3, sandboxed preload bridge, working native clipboard paste,
  accessibility readback, side-by-side unsigned local installation.
- Live SelfConnect Core registry discovery and explicit Join mesh. Internal app
  roles and app-only accounting are clearly distinguished from hosted CLI agents.
- Serialized guarded native messaging and real three-agent peer collaboration.

## Observed outcomes

[Sanitized machine-result export](results.json) retains check names, outcomes and
SHA-256 hashes of the exact raw source receipts. Different suites are distinct
scenarios, not a statistical reliability estimate.

| Scenario | Result |
| --- | --- |
| Final source checks | Typecheck clean; 308 tests / 43 files passed |
| Installed daily terminal | 14/14 Worked |
| Installed MCP, including separate Python Core server | 15/15 Worked |
| Native guarded shell send/readback and stale PID denial | 3/3 Worked |
| Native mesh UI and malformed IPC denial | 6/6 Worked |
| Real live Jev wiring: success/error/local-only/ledger | 15/15 Worked |
| Existing GitHub login through installed PTY | 4/4 connector checks Worked |
| Four-agent cooperation and one forced process-tree crash | 9/9 Worked |
| Three-agent direct native exchange | 5/5 exact messages verified in recipient transcripts |

The initial connector receipt also retains a Blocked skill check: at that point
no agent had been migrated into SCT. Later, the real hosted Claude session
activated the gh-cli skill and executed its documented GitHub commands. That
later peer receipt is retained in the archive; the initial result was not rewritten.

Two new real CLI sessions joined the existing lead/reviewer for the four-agent
exercise. The lead killed only the dedicated recovery terminal's process tree,
while a real 45-second tool call was in progress. Another terminal stayed alive;
its agent continued the shared task. Periodic saved output survived reopening.
The lead explicitly relaunched and resumed the interrupted CLI session, which
consumed the survivor's receipt and finished. CLI-generated session IDs matched
before/after; the dead HWND failed identity checks and vanished from live peers.
**This was explicit recovery, not automatic failover or lossless crash recovery.**

Next, the three SCT-hosted agents worked independently after one initial brief:
A proposed, B reviewed, C challenged, A revised, B/C acknowledged. They sent five
messages directly using the guarded helper; the lead did not relay or prompt the
next step. A shell-command/readback error was handled by the agents themselves.
The exercise used a deliberately serialized ring, not concurrent uncontrolled
foreground injection. The final checklist distinguished partial snapshot
survival from manually resuming an agent.

## Failures found and corrected

The original audit found typed URLs intercepted as app commands; missing-file
reads returned success; bash/task paths reported work they had not performed;
corrupt-ledger and plan-mode paths allowed mutation; selected-provider calls
could bypass local-only; filtered replay broke global-chain continuity. Real bash
execution, explicit unavailable-task errors, shared gates, shell passthrough and
continuous replay address those observations. Regression tests cover these paths.

Installed testing then exposed slash MCP calls bypassing plan permissions, native
Enter not submitting Electron input, and insufficient terminal accessibility.
The installed retests exercise the corrected governed route and real native
input/readback. Two simultaneous foreground senders caused garbled input: the
published helper serializes participating senders; the peer exercise uses one
sender at a time. Arbitrary external keystroke sources remain outside that lock.

One mesh-test failure was a harness error comparing the launcher PID to the
Electron main PID. Its failed receipt is preserved alongside the corrected test.

## Reproduce and evidence handling

Use `npm ci`, `npm run typecheck`, `npm test`, and `npm run dist:local` on Windows.
The local artifact is unsigned. `scripts/install-local.ps1` installs side by side.
Set `SCT_TEST_EXE` to that installed executable before running
`scripts/daily-terminal-acceptance.cjs`, `scripts/ecosystem-partner-mcp.cjs`, or
`scripts/ecosystem-mesh-ui.cjs`. Native/agent harnesses require installed SelfConnect
Core, existing authenticated CLI agents and run-specific identities; some dated
orchestration scripts also consume the local run receipts. Do not reuse a stale
HWND, PID, session ID or result directory. Live Jev checks make real API calls.

Raw terminal output, screenshots, repository inventory and private session
transcripts are excluded from this public repository and retained in a local ZIP.
[Raw-file manifest](raw-manifest.json) records filenames, sizes and hashes; the
public export contains no credentials or raw peer conversations. Model-authored
times in raw prose are not clock evidence; use machine-generated receipt times.
No GitHub Actions workflow existed for this repository at publication; these
results are local and installed-artifact checks, not a claim of hosted CI.

## Publication checks and local-only configuration

Before publication, typechecking and all 308 tests passed again. Gitleaks scanned
245 staged-source files with zero findings; an in-memory exact comparison against
the configured Jev credential found zero matches. Generated preview bundles are
no longer tracked and remain reproducible from source. No keys or DPAPI blobs
are published.

The owner's global Unreal Eagle MCP autoload was disabled earlier and verified
through fresh configuration reads. That is a local user-configuration change,
not a repository feature or a globally disabled MCP integration for other users.
Its receipt remains in the private evidence set. BPC/TSK identity corrections,
local setup choices and the later computer-use proposal are preserved in the
appropriate guides; [computer use remains a proposal](../../COMPUTER_USE_PLAN.md).
