# Governed desktop assist — 2026-09-22

Implemented and installed as an optional executor. Local observation and actions
run through the actual registry, approval UI and Python MCP driver. Paid model
suggestions remain off by default, with no automatic fallback from subscriptions.
This is a manually approved, single-window desktop-assist MVP.

## Observed results

[Machine-readable results and exact receipt hashes](computer-use.json).

| Scenario | Observed result |
| --- | --- |
| TypeScript / source suite | Clean; 368 tests in 48 files passed |
| Partner installed desktop acceptance | 39/39 Worked |
| Exact native input and real UI start/stop | 14/14 Worked |
| Installed billing persistence and refusal checks | 7/7 Worked |
| Actual billing disclosure UI and Deny button | 6/6 Worked |
| Installed driver after controlling-process death | Worked; subsequent operation refused |
| Deterministic native focus regression | 4/4 passed; native returns substituted |
| Live paid model inference | Blocked from this acceptance: no charged session approved; zero paid calls |

The installed editor fixtures independently recorded exact text, insertion cursor
and viewport position. Tests verified a single newline, Ctrl+A replacement,
space, Ctrl+Home/End, PageUp/Down, clicking to move the cursor, and actual scrolling
in both directions. Plan mode, denied approval, stale observation, wrong sequence,
wrong foreground, stop and lost target refused execution. Wrong-foreground checks
retained both target and collateral-window readback. The ledger still verified.

The latest packaging change only corrects the paid approval header and adds a
pre-send Jev billing notice. Its driver bytes match the full desktop acceptance
build; the final installed UI was tested separately. The machine export records
both payload hashes. Local installation is unsigned; no hosted CI run is claimed.

## Failures found and repaired

Earlier receipts are retained, including withdrawn claims:
- Core rejected focus based on an intermediate native return even though the
  observed foreground was already the target. The driver now verifies the
  resulting foreground, with bounded polling and unchanged identity checks.
- The original key helper silently ignored several allowed shortcuts. Enter
  produced LF+CR, and multiline typing lost newlines. Checked key chords and
  explicit newline/tab dispatch passed exact readback after repair.
- Screenshot-hash differences were incorrectly used as scrolling evidence.
  Caret blink can change a hash. Those claims were withdrawn and replaced with
  cursor and viewport readback; the earlier nine exact-input failures remain.
- A paid request preview displayed its cap but the approval header displayed
  zero. The header now carries the cap, with a separate-API warning before approval.
- Test-harness setup and partial JSON read failures were repaired and retained;
  they were not counted as product passes.

## Billing and scope

No cloud computer-use inference was purchased for this work. Adapter response,
refusal, timeout, oversized-response, pricing, image and action validation tests
use substituted transport. Actual provider acceptance/billing remains untested.

Paid runtime needs explicit configuration, a separate API key, cloud permission,
per-session rate/cap consent and per-request approval. Reservations persist
across app profiles and restarts; ambiguous sends remain reserved, and overruns
lock further requests. Estimates are not provider invoice guarantees. Leave paid
mode disabled for zero computer-use API charges. Jev is a separate API with its
own pre-send billing notice; its charges are not included in app call accounting.

The subscription path is local/manual desktop execution; this update does not
claim an automatic subscription-model adapter, unattended agent loop, credential
broker, universal application compatibility or automatic recovery of desktop
actions. The user approves each action. Core terminal injection, MCP, A2A and
computer use remain distinct pathways.

See [operating guide and research sources](../../COMPUTER_USE_PLAN.md). Raw
screenshots, profiles and machine identifiers stay in the private local evidence
archive; public receipts contain outcome names and hashes.
