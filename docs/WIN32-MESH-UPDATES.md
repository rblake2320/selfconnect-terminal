# Win32 Mesh Updates To Bake Into Terminal

Last updated: 2026-06-18

SelfConnect Terminal already contains a governed PTY, A2A transport, MCP, context economy, trust layer, audit ledger, and proof layer. The newer Win32/Core work adds a separate practical lesson: agents must communicate through the mesh, not by narrating in their own panes.

## Latest Runtime Rule

Agent-to-agent replies travel over SelfConnect transport into the receiving agent's registered terminal. A sender's local pane should show only `SENT`, `ACK`, or a one-line blocker.

This is now exposed by:

```bash
selfconnect slash "/mesh-protocol"
```

## Newer Core Capabilities To Integrate

| Capability | Current terminal status | Next integration |
| --- | --- | --- |
| Target guard | Not first-class in this Electron app. | Add Win32 target verification for any OS-window send. |
| `birth_id` mesh identity | Terminal has agent IDs/run IDs, but not SelfConnect mesh birth IDs. | Add birth ID to mesh peer records and migration handoffs. |
| Echo-filtered readback | Not first-class. | Add readback classification so local echo is not mistaken for peer output. |
| Channel router | Terminal has A2A and PTY, not the Win32 surface router. | Add route selection for terminal WM_CHAR, browser UIA, pipe/file registry. |
| Compact handoff | Context economy exists, but not the mesh-standard handoff packet. | Add `/compact-handoff` as the normal-mode migration primitive. |
| Enterprise/government controls | Terminal is governed by default. | Keep normal SelfConnect fast; profile-gate stricter enterprise/government controls. |

## Product Split

Normal SelfConnect should stay fast for personal bidirectional, tridirectional, and N-agent testing. Enterprise and government controls are still valuable, but they should be explicit profiles instead of slowing every normal experiment.
