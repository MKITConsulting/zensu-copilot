# Native Copilot validation gate

Run `npm run verify` on the owned source tree. The build copies files without
rewriting their semantics and works without the historical source snapshot.
Checks enforce the complete skill/agent/event catalog, file hashes, native schema
boundaries and runtime syntax. Unit/integration tests cover real state/evidence
operations with synthetic native events; those tests are not live model runs.

For live validation install the resulting `dist/zensu`, start a fresh isolated
Copilot session and run `/zensu-doctor`. Record the exact build manifest digest,
CLI version, native session ID and terminal result. Exercise reads, bound Bash,
file changes, native tasks and the full review/self-review chain against a
throwaway repository. Inspect real evidence and final state, not only model prose.

A completed local example does not prove external backend, forge, browser, human
approval, finding/fix, cancellation or long-session recovery paths. Record those
acceptance results separately. See [the runtime validation record](copilot-runtime.md).
