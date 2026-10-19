# Remaining audit recovery UX

The original observation below comes from the completed invoice run, whose frozen plugin remained unchanged. The model recovered autonomously with the explicit bound session and current predicates, then closed the chain successfully. The follow-up is now implemented for 0.2.1; that original run does not establish live coverage of the later UX change.

The self-review audit calls in `hooks/1792442056023-55447-postToolUse.json` and `hooks/1792442067429-56836-postToolUse.json` supplied `--dirty-before` and `--predicates` but omitted `--session`. The native hook provided the bound session environment. Nevertheless, the helper initializes `SESSION_ID=""` (source `src/plugin/hooks/lib/zensu-edit-landing.sh:60`) and only selects the canonical receipt when the explicit session is nonempty (lines 252–266). The documented standalone audit contract intentionally permits success without a receipt (lines 1018–1028).

Consequences observed: the first standalone audit could not inherit the prior certifications and unnecessarily required proofs for unchanged quote-api files. The second printed a clean 11/11 audit but did not update the canonical native 7-claim receipt. The terminal helper correctly refused closure in `hooks/1792442098887-61348-postToolUse.json` because that canonical receipt predated the new SR1 claims; it also reported stale acceptance evidence. No gate bypass or unclean successful closure was observed at this point.

Implemented follow-up:

1. Preserve standalone inspection outside an active bound native workflow. For a receipt-producing audit inside an active authoritative native workflow, reject an omitted `--session` before grading and print the exact safe session argument, or explicitly label output `STANDALONE AUDIT — no receipt written; not usable for workflow completion`. Prefer refusal in the active native case so the caller cannot mistake success for persisted workflow evidence. Do not infer authority from an unclassified subagent or arbitrary ambient session variables.
2. Keep `--inventory` as a clearly read-only operation. Existing explicit standalone semantics should remain available outside the active workflow.
3. Make terminal refusal include a concrete audit recovery command with its authoritative log, root and session and a placeholder for current literal/hash proof. Preserve previously supplied dirty context. After the audit, refresh stale acceptance records before retrying closure.
4. Focused tests should cover active native omission failing before a misleading clean result, ordinary standalone audit behavior, and a terminal diagnostic containing the bound session. Deterministic coverage includes the real packaged dispatcher and shell; native follow-up evidence is recorded separately.

Concrete recovery for this run (do not execute from the observer):

```sh
bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-edit-landing.sh" \
  --log "/private/tmp/zensu-copilot-workflow-retest-3yzjfc7w/project/.zensu/logs/2026-10-19-2202_tdd-invoice-quote.log" \
  --project "/private/tmp/zensu-copilot-workflow-retest-3yzjfc7w/project" \
  --session "0d27dc52-0d1a-4e86-8fb7-c40dd02b69d1" \
  --dirty-before "/Users/marcelkarras/.copilot/session-state/0d27dc52-0d1a-4e86-8fb7-c40dd02b69d1/files/sr-dirty-before.txt" \
  --predicates "/Users/marcelkarras/.copilot/session-state/0d27dc52-0d1a-4e86-8fb7-c40dd02b69d1/files/sr-predicates.json"
```

The existing canonical receipt already persists the baseline and epoch; omitting those on the correctly bound rerun inherits them. The native model must discover and perform recovery unaided during this live test.

## Follow-up validation

The final 0.2.1 payload passed the packaged native workflow integration and all 488 Node tests, six marketplace tests, twenty-nine analyzer fixtures and one controller fixture. A fresh Copilot CLI 1.0.98 session executed the prescribed native probe and passed all seven checks; the exact packaged build digest matches the release candidate. Two earlier probe errors (unsupported mode flag and a raw-ID/key assertion mismatch) remain recorded separately. See [release validation](release-0.2.1-validation.json). This focused native probe does not replace or reclassify the earlier complete invoice workflow.
