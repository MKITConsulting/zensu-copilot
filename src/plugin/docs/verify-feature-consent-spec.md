# Native browser consent contract

Navigation remains governed by the origin floor, the explicit parent-environment
`ZENSU_VERIFY_NAVIGATION_POLICY_V1`, and human approval in Copilot's permission UI.
No setting from another coding host is read or inferred.

The pre-tool policy parses the actual native Bash command. Unsafe command shapes,
credentials, query/fragment navigation, forbidden private addresses and undeclared
network-only targets fail closed. Local mode permits loopback; remote mode requires
HTTPS and public DNS results. The runtime helper pins validated DNS destinations.
The browser run config restricts HTTP(S) origins; server redirects still require
checking the final page URL, and WebSocket traffic is not fenced by that config.

A declared-safe target in the parent policy is already authorized within its
scope. Otherwise the native hook returns `permissionDecision: "ask"`. Only Copilot
and the user can resolve the prompt. An unavailable prompt leaves the action
unapproved. No plugin action selects a permissive host mode.

Persisting consent requires a unique matching native `permission.requested`
event of kind `hook` for the exact Bash arguments and tool-call ID, followed by a
`permission.completed` event with `decisionSource: "human_response"` and an approved
result kind. Missing, conflicting or automated receipts cannot create an approval
record. Command success alone is never consent evidence. Rejection is never retried
under a different URL spelling or tool to evade the decision.

Consent records are session-bound. Loopback approvals may be reused during that
session; opening a remote browser asks again. Missing trusted receipt data may
therefore cause another prompt, which must remain a real user decision.

These controls assume the host executes the registered hooks. Same-user malicious
processes, disabled host hooks and separately launched browsers are outside that
boundary. Native permission settings are controlled by the user, not by the plugin.
