# Review Chain

The agents that review your code, how a repo extends them, and the artifact
skeletons they anchor on.

### Agents (6)

| Agent | Role | How It Works |
|-------|------|--------------|
| **zensu-plm** | view-only planning analyst | Explains and decomposes Zensu lifecycle work. It receives neutral context but exposes only `view`, `grep`, and `glob`; the matching skill performs mutations in the interactive main thread. |
| **code-reviewer** | Quality Review | Consolidates the review. Standalone: walks 5 specialist perspectives (conventions, bugs, architecture, tests, security) in a single READ-ONLY agent. In the `/zensu-tdd` chain: runs in **fan-out consume mode**, emitting the report the main thread merged from the parallel `review-aspect` panel — three perspectives by default, five with `hooks.reviewPanel: full` (no re-read, no build/test). |
| **review-aspect** | Single-Perspective Review | READ-ONLY reviewer scoped to ONE perspective. The `/zensu-tdd` chain spawns one per perspective of the panel in a single parallel batch — `correctness`, `design` and `security` by default (`hooks.reviewPanel: lean`, whose fix-round re-reviews spawn `correctness` alone), or `conventions`, `bugs`, `architecture`, `tests` and `security` with `hooks.reviewPanel: full` — then merges their findings in the main thread. Runs zero build/test commands — the suite already ran in the Phase 6 audit. |
| **review-judge** | Independent Second Pass | READ-ONLY judge spawned AFTER the aspect merge (gated by `hooks.reviewJudge`, default on; on the lean panel for the first review only, and on any review the agentStop hook resumes). Re-reads the changed files fresh and covers the panel's structural blind spots: cross-cutting integration, requirement drift against the plan's stable AC-###/FR-### IDs, missed edge cases, and panel quality — a false-positive panel finding gets a `Panel-FP:` meta-verdict that the main thread neutralizes before fix routing. It also traces every guarantee a query or call inherits from session or connection state (row-level security, a tenant setting, the connecting role) through each connection mode the code still supports, and reports a defect such a mode reaches with its condition, even when committed configuration disables the mode, which may lower the severity by one level but never below IMPORTANT. On the first review it runs twice, independently and side by side (`hooks.reviewJudgeSecondRun`, default on): the second run reads what the changed files depend on before the files themselves and only adds `JUDGE-B<n>` findings, which the main thread merges as a union. Emits `JUDGE-*` deltas; never repeats panel findings, never runs build/test. |
| **plan-review-worker** | Confined plan validator | Dedicated `/zensu-plan-review` worker with only `view`, `grep`, and `glob`. It reads a private, immutable evidence lease and returns one raw `kind:"plan-review"` JSON object as its final message; only the main thread validates and materializes that result. |
| **pr-review-worker** | Confined PR persona | Dedicated `/zensu-pr-team-review` worker with only `view`, `grep`, and `glob`. It reviews a leased role/area evidence shard and returns one raw `kind:"pr-review"` JSON object; it cannot write files, mutate tasks, message agents, spawn agents, run commands, or publish. |

The built-in reviewer boundary uses each agent's exact `view`, `grep`, and
`glob` tool allowlist. The first all-tool `preToolUse` policy handler revalidates
the immutable Session Control binding on every call. It recognizes the five
plugin-scoped review identities above, the exact bare names of the three built-in
reviewers, and `zensu:zensu-plm`; all receive the same three-tool boundary.
Reports are final assistant responses, not a report tool. The two leased workers'
raw JSON is captured from the native `subagentStop.response` field (see
[Session Control](session-control.md)).

Other `host-profile-v1` children receive only the native capability allowlist in
[Configuration](configuration.md#native-child-capabilities). A neutral child may
run `bash` only when the native event identifies its `agentType`, it is neither a
read-only Zensu agent nor a `zensu-review-*` persona, and `hooks.subagentShell` is
not `false`. Every allowed shell call passes an accident guard; this guard is not
an OS sandbox. Unknown tools or unproven MCP provenance do not acquire a grant.

The two review-worker identities add a private evidence lease on top of that
three-tool profile. The interactive main thread creates one immutable generation
containing exact files and narrow search roots, records each host worker id, and
never exposes the lease id or plugin-data path to the worker. Each tool call
revalidates canonical paths, symlink/path identity, and the creation snapshot so
TOCTOU replacement fails closed. PR leases also bind the exact
`core.quotePath=false` name-status manifest; ambiguous quoted/backslash paths and
findings outside that changed-path set fail closed. `subagentStop` captures the
worker's one raw JSON result; collection requires the exact worker id, result
kind, and role.
Only then may the main thread write a debug JSON file, and it closes the lease on
success and failure. Repository instructions, diffs, source text, overlays, and
refinement context remain untrusted data and cannot widen this contract.

Implementation runs in the **main thread** through `/zensu-tdd`, in vanilla mode
by default or strict RED→GREEN mode when selected. Reviewers inspect the result;
they never implement fixes. `hooks.incrementalReviewRounds` narrows later aspect
reviews to the recorded fix-round delta, while the judge keeps the full cumulative
diff. `hooks.aspectActivation` selects relevant perspectives. An unavailable scope
calculation keeps the full review scope. See [Configuration](configuration.md)
for the precise bounds, switches, and residual limitations.

`hooks.reviewConvergence` records each merged finding in the findings ledger and
routes eligible findings to the main-thread fix loop. Deferred and parked findings
remain visible to `/zensu-self-review` and the final `## Open` table. The terminal
self-review refreshes acceptance verification through `/zensu-verify-feature --chain`
when review fixes have made earlier records stale. All three reviewer agents use
[the shared severity scale](review-severity.md).

#### Native review orchestration

1. Follow `/zensu-tdd`'s review phase to construct `REVIEW PACKET v1` from the
   current change set and the completed evidence audits. Spawn the selected
   `zensu:review-aspect` agents through Copilot's exposed native `task` tool, with
   a unique `name`, `description`, `prompt`, and the exact `agent_type` selector.
2. Collect each actual completion. A dispatch, a task id, or an accepted background
   call is not a completed review. Retain failed or missing perspectives as explicit
   coverage gaps and apply the skill's recovery procedure; never invent a report.
3. Merge the aspect findings in the main thread and run the configured
   `zensu:review-judge` pass. When enabled for the first review,
   `hooks.reviewJudgeSecondRun` adds a second independent judge. Preserve each
   finding's provenance and any unavailable reviewer result.
4. Apply the Finding Verification Gate against the actual source. Then obtain the
   chain's review ticket and dispatch the consume-mode `zensu:code-reviewer` with
   the validated merged report. Its native task completion drives the counted
   review round. The plugin does not treat an arbitrary final message as a ticket.
5. Follow the configured fix loop and `/zensu-self-review` handoff. Completion still
   requires the full-suite and acceptance gates. The `agentStop` backstop can
   resume unfinished work; it never proves that a failed reviewer succeeded.

The Copilot package runs this panel directly. It ships no dynamic external-workflow
launcher, review-import template, or `--external-review` helper. The retained
`hooks.externalReviewImport` configuration key has no effect on this host. A review
produced elsewhere may be useful context, but it does not replace native review
tickets, verified findings, or the chain's evidence receipts.

#### Custom review personas (repo-local)

Projects extend the review panel without forking the plugin: drop agent definitions at `.github/agents/zensu-review-*.agent.md` (standard agent frontmatter + body prompt; GitHub Copilot CLI registers them at session start — a file added mid-session is not yet spawnable and gets logged as `PERSONA SKIPPED — <name> (not registered)`). The frontmatter `name:` must equal the filename stem and match `zensu-review-[A-Za-z0-9_-]+` — anything else is skipped as malformed. An optional `activation:` field holds comma-separated glob patterns (items may be quoted) matched against the changed-file paths — `**` crosses directory separators on segment boundaries (`"**/domain/**"` matches `src/domain/x.ts` but not `src/subdomain/x.ts`), `*`/`?` stay within one segment, and a pattern without `/` also matches the basename. Project-agnostic examples: `"**/domain/**"` (DDD rules), `"**/*.tf"` (infrastructure), `"**/*.component.ts"` (frontend components). A persona with no `activation:` field always joins; one whose globs match nothing is skipped AND named in the run log (`PERSONA SKIPPED — <name> (no activation match)`) — never silently omitted; malformed files (bad frontmatter, name/stem mismatch, symlinks) are skipped with a log line and never abort the chain. Extra personas are capped at five per run — glob-matched personas take slots before always-join ones (relevance wins), each group lexicographic; overflow is logged as dropped. **Output contract:** a persona reports exactly like a built-in aspect — `## Aspect: <persona-name>` header with `- [SEVERITY] file:line — finding` bullets — except every finding is prefixed with the persona's uppercased `<NAME>-<n>` ID for provenance. **Trust boundary:** a persona file is a repo-controlled prompt at the same trust level as any `.github/agents` definition or a checked-in `AGENTS.md` — the read-only/no-build contract is carried by the spawn prompt and the persona's own `tools:` frontmatter, not by promotion to the built-in reviewer principal. Custom personas stay neutral `host-profile-v1`: the all-tool gate prevents Session Control/workflow-root access and `main-v1` impersonation, but their ordinary host tools remain governed by their own frontmatter. Audit `zensu-review-*.agent.md` files in third-party repos before running `/zensu-tdd` or `/zensu-plan-review` (both spawn personas from the local working checkout; `/zensu-pr-team-review` is base-scoped). Matching is decided deterministically by `hooks/lib/persona-activation.js` (changed files on stdin, personas dir as argv; verdict lines `spawn`/`skip`/`drop`).

Here, “ordinary host tools” means the capability gate's allowlist only: neutral
personas are denied every shell/command alias and every MCP tool outside the named
read-only list, regardless of their frontmatter.
**Three consumers, one file.** The same `.github/agents/zensu-review-*.agent.md` persona feeds three review flows: `/zensu-tdd`'s Phase 6 fan-out, `/zensu-pr-team-review`'s cast, and `/zensu-plan-review`'s cast. A persona file declares only the *concern* (its body) plus its *activation globs* (frontmatter) and stays **output-format-agnostic**; each flow injects its own output contract at spawn — `/zensu-tdd` wants the `## Aspect: <persona-name>` markdown above, while the two team-review skills want structured JSON (`$WORKDIR/<name>.json` per their shared schema). A body that hardcodes one format still runs under the others (the injected contract wins), but keeping the body format-neutral lets one file serve all three. **Trust boundary for PR review:** `/zensu-pr-team-review` reviews an untrusted PR head, so it discovers personas from the reviewed repo's **base checkout** (`$REPO/.github/agents`), never the PR-head worktree — a PR cannot introduce its own reviewer. `/zensu-plan-review` and `/zensu-tdd` run against the trusted local working checkout and discover from its git toplevel.
**Inline anchors.** When `/zensu-pr-team-review` publishes, every inline comment anchor is pre-validated against the diff by `hooks/lib/valid-diff-lines.js`, with nearest-line remap, so a finding whose line is not commentable is relocated rather than lost.

#### Skill overlays (additive-only)

Three skills carry an overlay anchor (`<!-- zensu:overlay <name> -->`): `tdd`, `cover`, and `pr-team-review`. A repo drops team guidance at `.zensu/overlays/<name>.md` (resolved at the git toplevel of the working checkout, worktree-aware, same anchor as templates and personas) and the skill injects it at that point. The contract is **additive-only**: an overlay may ADD conventions, extra checks, and stack particularities; it can NEVER disable, replace, weaken, or reorder the skill's mandatory phases (discipline gates, evidence audits, review chain, chain terminus) — on any conflict the skill text wins and the run surfaces one line naming the ignored overlay directive. Missing or empty file = no-op. **Trust boundary:** overlays are repo-controlled prompts at the same trust level as `.github/agents` personas or a checked-in `AGENTS.md` — the additive-only rule is carried by the skill instruction, not enforced by code; audit `.zensu/overlays/` in third-party repos before running. Example overlay (`.zensu/overlays/tdd.md`):

```markdown
- Team convention: every new module gets an ADR reference in its header.
- Extra check: flag any new dependency added without a lockfile update.
```

#### Templates (repo-overridable)

Four artifact skeletons ship as plugin defaults under `templates/` and resolve with the repo winning: a consumer uses `.zensu/templates/<name>.md` at the git toplevel of the working checkout (`git rev-parse --show-toplevel` — worktree-aware, same anchor as persona discovery) when it exists, else `<absolute-plugin-root>/templates/<name>.md`. The top-level Skill obtains that concrete root from Copilot's native `${COPILOT_PLUGIN_ROOT}` substitution; a supporting file loaded with `view` must receive the already-resolved value from its parent instead of expecting another substitution pass. An override REPLACES the default wholesale — it MUST keep the mandatory sections, because the Phase 5/6 audits and `/zensu-converge` anchor on them (repository checks cover the shipped defaults; preserving these sections in an override is the project's responsibility):

| Template | Consumer | Mandatory sections |
|----------|----------|--------------------|
| `tdd-plan.md` | `/zensu-tdd` Phase 2 | `## Requirements` (ID/Covers), `## Preconditions`, `## Cross-Layer Value Flow Pairings`, Status Legend, Steps table with Status+Covers, `## Final Verification` |
| `autopilot-spec.md` | `/zensu-autopilot` Phase 0.C | numbered stable `AC-###` criteria, out-of-scope section, resolved recipe |
| `autopilot-pr-body.md` | `/zensu-autopilot` step 3 | per-AC checklist table (deprecated rows kept) whose `Status` cells carry the 🟢/🟡/🔴/⚪ marker prefix, `Gates bypassed during build:` audit line |
| `pr-body.md` | `/zensu-pilot` "Commit + open PR" (shared default for any PR opener) | `## Acceptance criteria` table filled from the feature's `## Requirements` rows, with a stub-row fallback, whose `Status` cells carry the 🟢/🟡/🔴/⚪ marker prefix |

#### Code Reviewer — 5 Sequential Specialist Perspectives

The code-reviewer agent is a single READ-ONLY agent (only `view`, `grep`, and `glob` tools) that walks five perspectives in order:

> In the `/zensu-tdd` review chain the review is fanned out to parallel `review-aspect` subagents and merged in the main thread — by default the lean panel of `correctness`, `design` and `security`, or these five perspectives with `hooks.reviewPanel: full`; the sequential walk described here is what a direct standalone `code-reviewer` invocation does.

| Reviewer | Scope |
|----------|-------|
| conventions-checker | AGENTS.md compliance, naming, formatting |
| bug-hunter | Logic errors, off-by-one, null checks, race conditions |
| architecture-reviewer | Layer separation, dependency direction, patterns |
| test-analyzer | Coverage gaps, assertion quality, missing scenarios |
| security-reviewer | Secrets, injection, auth checks, input validation |

Anti-hallucination rules: every finding requires file:line reference, confidence >= 80, must read the file before reporting. Those rules are directives the reviewer is asked to follow; the **Finding Verification Gate** (`hooks.findingVerification`, default on) is what mechanically checks them afterwards — the main thread grades every merged finding against the real source via the model-free `hooks/lib/finding-verify-v1.js` plus its own read, and marks whatever does not hold up `[Unverified — do not fix]` instead of routing it to a fix or publishing it.
