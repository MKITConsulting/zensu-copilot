#!/usr/bin/env python3
"""Deterministic analyzer fixtures; never native host/workflow validation."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("analyzer", Path(__file__).with_name("analyze-native-workflow.py"))
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)


class EvidenceFixtures(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zensu-analyzer-fixture-")
        self.root = Path(self.temp.name).resolve()
        self.session = "fixture-own-session"
        self.digest = hashlib.sha256(b"zensu.session-control/v1/session-id\0" + self.session.encode()).hexdigest()
        self.state_name = "project/.zensu/state/tdd-phase-scv1_" + self.digest + ".json"
        self.write("harness.json", {"sessionId": self.session, "runDirectory": str(self.root)})
        self.write("process.json", {"sessionId": self.session})
        self.write("command.json", ["copilot", "--session-id", self.session])
        self.write(self.state_name, {"session_id_hash": "sha256:" + self.digest})

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, value):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value if isinstance(value, str) else json.dumps(value))
        return target

    def analyze(self):
        return analyzer.analyze(self.root, self.session)

    def scoped_receipt(self, pending_history=False):
        self.write("project/.gitignore", ".zensu/\n")
        self.write("project/src/index.js", "export const invoice = true;\n")
        for args in (["init", "-q"], ["add", ".gitignore", "src/index.js"]):
            subprocess.run(["git", *args], cwd=self.root / "project", check=True, capture_output=True)
        tree = subprocess.run(["git", "write-tree"], cwd=self.root / "project", check=True, capture_output=True, text=True).stdout.strip()
        state = {"session_id_hash": "sha256:" + self.digest, "reviewGeneration": "fixture-generation",
            "workflowArtifacts": {"log": ".zensu/logs/test.log"}}
        self.write(self.state_name, state)
        log = "[fixture] IMPL completed — files: src/index.js\n"
        if pending_history:
            log += "PENDING PREDICATE — invoice: src/index.js was already dirty before this claim; union membership is not evidence\n"
        self.write("project/.zensu/logs/test.log", log)
        value = (self.root / "project/src/index.js").read_bytes()
        receipt = {"schema": "edit-landing-v2", "session": "scv1_" + self.digest,
            "log": ".zensu/logs/test.log", "clean": True, "claims": 1, "landed": 1,
            "notLanded": 0, "unverified": 0, "pending": 0,
            "auditScope": {"schema": "edit-landing-scope-v1", "root": str(self.root / "project"),
                "claimRoot": str(self.root / "project"),
                "log": str(self.root / "project/.zensu/logs/test.log"), "sessionKey": "scv1_" + self.digest,
                "generation": "fixture-generation", "baseline": "", "epoch": "", "dirty": ["src/index.js"],
                "logPrefix": {"bytes": len(log.encode()), "sha256": analyzer.sha(log.encode())},
                "claims": [{"step": "invoice", "raw": " src/index.js", "path": "src/index.js", "certified": True}],
                "snapshots": {"src/index.js": {"path": "src/index.js", "exists": True, "bytes": len(value), "sha256": analyzer.sha(value)}},
                "tree": {"kind": "git", "tree": tree}}}
        self.write("project/.zensu/state/edit-landing-scv1_" + self.digest + ".json", receipt)
        return receipt, state

    def test_domain_separated_session_identity_is_required(self):
        self.assertEqual(self.analyze()["status"], "incomplete")
        self.write(self.state_name, {"session_id_hash": "sha256:" + hashlib.sha256(self.session.encode()).hexdigest()})
        with self.assertRaises(ValueError):
            self.analyze()

    def test_explicit_foreign_session_is_refused(self):
        with self.assertRaises(ValueError):
            analyzer.analyze(self.root, "another-session")

    def test_exit_zero_cannot_prove_workflow_closure(self):
        self.write("exit.json", {"exitCode": 0})
        result = self.analyze()
        self.assertEqual(result["checks"]["processExit"]["status"], "pass")
        self.assertEqual(result["checks"]["workflowClosure"]["status"], "fail")
        self.assertEqual(result["status"], "failed")

    def test_symlink_and_parent_traversal_evidence_are_refused(self):
        self.write("real.json", {})
        (self.root / "link.json").symlink_to(self.root / "real.json")
        reader = analyzer.RunReader(self.root)
        for name in ["link.json", "../real.json"]:
            with self.assertRaises(ValueError):
                reader.obj(name)

    def test_packet_bytes_and_hash_are_independently_checked(self):
        payload = {"changed_files": ["src/index.js"], "policy": "reviewer-readonly-v1"}
        digest = analyzer.sha(analyzer.canonical(payload).encode())
        filename = self.write("project/packet.json", {"schema": "zensu-review-packet-v1", "payload": payload, "sha256": digest})
        prompt = f"REVIEW-PACKET: {filename} sha256:{digest}"
        injected = prompt + analyzer.PACKET_START + json.dumps(payload) + analyzer.PACKET_END
        self.assertTrue(analyzer.packet(analyzer.RunReader(self.root), {"prompt": injected})["valid"])
        self.assertFalse(analyzer.packet(analyzer.RunReader(self.root), {"prompt": injected.replace("src/index.js", "src/other.js")})["valid"])

    def test_canonical_encoding_matches_javascript_integer_key_order(self):
        self.assertEqual(analyzer.canonical({"10": "ten", "2": "two", "z": 1, "a": 2}), '{"2":"two","10":"ten","a":2,"z":1}')

    def test_managed_progress_cannot_hide_unchecked_original_rows(self):
        self.write(self.state_name, {"session_id_hash": "sha256:" + self.digest,
            "implComplete": True, "codeReviewDone": True, "chainDone": True,
            "reviewTicketConsumed": True, "reviewTicket": "fixture-ticket",
            "workflowArtifacts": {"progress": ".zensu/progress/test.md"}})
        self.write("project/.zensu/progress/test.md", "\n".join([
            "- [x] Implementation audit accepted", "- [x] Code review converged",
            "- [x] Workflow chain closed", "- [ ] Phase 6 full suite/build/coverage/audits/acceptance",
            "- [ ] Chain close and final report"]))
        check = self.analyze()["checks"]["progress"]
        self.assertEqual(check["status"], "fail")
        self.assertEqual(len(check["evidence"]), 2)

    def test_second_judge_does_not_count_as_primary(self):
        self.assertFalse(analyzer.substantive("primary", "## Aspect: judge (second run)\n- (no findings)"))
        self.assertTrue(analyzer.substantive("secondary", "## Aspect: judge (second run)\n- (no findings)"))

    def test_hook_child_identity_requires_native_parent_event(self):
        self.write("hooks/child.json", {"event": "preToolUse", "payload": {"sessionId": "child"}})
        self.assertNotEqual(self.analyze()["checks"]["sessionIsolation"]["status"], "pass")
        self.write("output.jsonl", json.dumps({"type": "tool.execution_start", "id": "event-0", "data": {"toolCallId": "own-call", "toolName": "task"}}) + "\n" + json.dumps({"type": "subagent.started", "agentId": "child", "id": "event-1", "data": {"toolCallId": "own-call"}}) + "\n")
        self.assertEqual(self.analyze()["checks"]["sessionIsolation"]["status"], "pass")

    def test_injected_execution_prefix_is_not_a_model_copy(self):
        self.write("output.jsonl", json.dumps({"type": "tool.execution_start", "id": "event-1", "data": {
            "toolCallId": "own-call", "toolName": "bash", "arguments": {"command": "# zensu-copilot-context-v1\ntrue"}}}) + "\n")
        self.assertEqual(self.analyze()["originalFindings"]["WF-001"]["status"], "pass")

    def test_custom_persona_participates_in_packet_analysis(self):
        self.assertEqual(analyzer.task_role({"agent_type": "zensu-review-domain", "prompt": ""}), "persona")
        self.assertNotEqual(analyzer.task_role({"agent_type": "zensu-review-domain", "prompt": ""}), "primary")

    def test_prior_implementation_comparison_does_not_replace_acceptance(self):
        entry = self.root / "independent-consumer/consumer/node_modules/zensu-live-invoice/dist/index.js"
        hashes = {}
        for name in ["index.js", "cli.js"]:
            self.write("project/src/" + name, "fixture")
            self.write(str(entry.parent.relative_to(self.root) / name), "fixture")
            hashes[name] = {"source": analyzer.sha(b"fixture"), "installed": analyzer.sha(b"fixture"), "equal": True}
        tarball = self.write("independent-consumer/packages/fixture.tgz", "fixture-tarball")
        report = {"entry": str(entry), "testedHashes": hashes,
            "packageTarball": str(tarball), "packageTarballSha256": analyzer.sha(b"fixture-tarball"),
            "packagedInstallCommands": [{"exitCode": 0}, {"exitCode": 0}],
            "priorImplementationComparison": "different",
            "checks": [{"name": name, "scope": "original-invoice-acceptance", "status": "pass"} for name in sorted(analyzer.ORIGINAL_CHECKS)] +
                      [{"name": "one MiB comparison", "scope": "prior-implementation-regression", "status": "fail"}]}
        self.write("independent-check.json", report)
        self.assertEqual(self.analyze()["checks"]["independentConsumer"]["status"], "pass")
        report["checks"][0]["status"] = "fail"
        self.write("independent-check.json", report)
        self.assertEqual(self.analyze()["checks"]["independentConsumer"]["status"], "fail")
        report["checks"][0]["status"] = "pass"
        self.write("independent-check.json", report)
        self.write(str(entry.relative_to(self.root)), "tampered")
        self.assertEqual(self.analyze()["checks"]["independentConsumer"]["status"], "fail")

    def test_verified_current_tree_can_supersede_temporary_file_edit_timestamps(self):
        status = {"successful": True, "completedAt": "2026-10-19T20:40:00Z",
                  "text": "ACCEPTANCE STATUS — 4/4 active criteria pass"}
        later = "2026-10-19T20:42:00Z"
        self.assertFalse(analyzer.acceptance_is_current(status, later, {"status": "pending"}))
        self.assertFalse(analyzer.acceptance_is_current(status, later, {"status": "fail"}))
        self.assertTrue(analyzer.acceptance_is_current(status, later, {"status": "pass"}))
        self.assertFalse(analyzer.acceptance_is_current(dict(status, successful=False), later, {"status": "pass"}))
        stale = dict(status, text=status["text"] + "\nACCEPTANCE STATUS — 0/4 active criteria pass | 4 stale")
        self.assertFalse(analyzer.acceptance_is_current(stale, later, {"status": "pass"}))

    def test_compound_shell_exit_does_not_turn_stale_acceptance_green(self):
        self.assertFalse(analyzer.acceptance_status_pass("ACCEPTANCE STATUS — 4/4 active criteria pass\nACCEPTANCE STATUS — 0/4 active criteria pass | 4 stale"))
        events = [
            {"id": "s", "type": "tool.execution_start", "timestamp": "01", "data": {"toolCallId": "acceptance", "toolName": "bash", "arguments": {"command": "bash plugin/hooks/lib/zensu-log.sh --acceptance-status; true"}}},
            {"id": "e", "type": "tool.execution_complete", "timestamp": "02", "data": {"toolCallId": "acceptance", "success": True, "shellExecution": {"exitCode": 0}, "result": {"content": "ACCEPTANCE STATUS — 0/4 active criteria pass; 4 stale"}}},
        ]
        self.write("output.jsonl", "\n".join(map(json.dumps, events)) + "\n")
        result = self.analyze()
        self.assertFalse(result["milestones"][0]["successful"])
        self.assertNotEqual(result["checks"]["acceptance"]["status"], "pass")

    def test_native_view_can_load_terminal_self_review(self):
        self.write(self.state_name, {"session_id_hash": "sha256:" + self.digest,
            "implComplete": True, "codeReviewDone": True, "chainDone": True,
            "reviewTicketConsumed": True, "reviewTicket": "fixture-ticket"})
        events = []
        operations = [
            ("bash", {"command": "bash plugin/hooks/lib/zensu-log.sh --code-review-done --claimed-review-ticket fixture-ticket"}),
            ("view", {"path": str(self.root / "plugin/zensu/skills/zensu-self-review/SKILL.md")}),
            ("bash", {"command": "bash plugin/hooks/lib/zensu-log.sh --chain-done --claimed-review-ticket fixture-ticket"}),
        ]
        for i, (tool, arguments) in enumerate(operations):
            events.append({"id": f"s{i}", "type": "tool.execution_start", "timestamp": str(i*2), "data": {"toolCallId": str(i), "toolName": tool, "arguments": arguments}})
            events.append({"id": f"e{i}", "type": "tool.execution_complete", "timestamp": str(i*2+1), "data": {"toolCallId": str(i), "success": True, "shellExecution": {"exitCode": 0}, "result": {"content": "fixture"}}})
        self.write("output.jsonl", "\n".join(map(json.dumps, events)) + "\n")
        result = self.analyze()
        self.assertEqual(result["checks"]["terminalSelfReview"]["status"], "pass")
        self.assertNotEqual(result["status"], "passed")

    def test_closure_cannot_hide_an_unclean_latest_landing_receipt(self):
        state = {"session_id_hash": "sha256:" + self.digest,
            "implComplete": True, "codeReviewDone": True, "chainDone": True,
            "reviewTicketConsumed": True, "reviewTicket": "fixture-ticket",
            "workflowArtifacts": {"log": ".zensu/logs/test.log"}}
        self.write(self.state_name, state)
        self.write("project/.zensu/logs/test.log", "PENDING PREDICATE — src/index.js\n")
        receipt_name = "project/.zensu/state/edit-landing-scv1_" + self.digest + ".json"
        receipt = {"schema": "edit-landing-v2", "session": "scv1_" + self.digest,
            "log": ".zensu/logs/test.log", "clean": False, "notLanded": 0, "unverified": 0, "pending": 1}
        self.write(receipt_name, receipt)
        self.assertEqual(self.analyze()["checks"]["editLanding"]["status"], "fail")
        receipt.update(clean=True, pending=0)
        self.write(receipt_name, receipt)
        result = self.analyze()["checks"]["editLanding"]
        self.assertEqual(result["status"], "pass")
        self.assertEqual(len(result["evidence"][0]["historicalNonCleanMarkers"]), 1)

    def test_pending_audit_cannot_be_cleared_by_omitting_dirty_context(self):
        events = []
        for i, (extra, pending, code) in enumerate([(" --dirty-before paths.txt", 12, 1), ("", 0, 0)]):
            events.append({"id": f"s{i}", "type": "tool.execution_start", "timestamp": str(i*2), "data": {
                "toolCallId": str(i), "toolName": "bash", "arguments": {"command": "bash plugin/hooks/lib/zensu-edit-landing.sh --log test.log" + extra}}})
            events.append({"id": f"e{i}", "type": "tool.execution_complete", "timestamp": str(i*2+1), "data": {
                "toolCallId": str(i), "success": True, "shellExecution": {"exitCode": code},
                "result": {"content": f"EDIT LANDING AUDIT — claims=13 landed=1 not_landed=0 unverified=0 pending={pending} exempt_ignored=0 exempt_verified=0"}}})
        self.write("output.jsonl", "\n".join(map(json.dumps, events)) + "\n")
        result = self.analyze()["checks"]["editLandingContext"]
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["evidence"][0]["contextDowngradeCalls"], ["1"])

    def test_repeated_explicit_terminal_skill_is_a_failure(self):
        events = []
        for i in range(2):
            events.append({"id": f"s{i}", "type": "tool.execution_start", "timestamp": str(i*2), "data": {
                "toolCallId": str(i), "toolName": "skill", "arguments": {"skill": "zensu-self-review"}}})
            events.append({"id": f"e{i}", "type": "tool.execution_complete", "timestamp": str(i*2+1), "data": {
                "toolCallId": str(i), "success": True, "result": {"content": "fixture"}}})
        self.write("output.jsonl", "\n".join(map(json.dumps, events)) + "\n")
        result = self.analyze()["checks"]["terminalSelfReview"]
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["evidence"][0]["explicitSkillInvocations"], 2)

    def test_controller_supersession_is_not_a_completed_workflow(self):
        self.write("exit.json", {"exitCode": -2})
        self.write("controller-interruption.json", {"sessionId": self.session, "reason": "superseded fixture", "signal": "SIGINT"})
        result = self.analyze()
        self.assertEqual(result["status"], "interrupted")
        self.assertEqual(result["checks"]["workflowClosure"]["status"], "fail")

    def test_neutral_progress_pointers_and_exact_bound_managed_status_pass(self):
        self.write(self.state_name, {"session_id_hash": "sha256:" + self.digest,
            "implComplete": True, "codeReviewDone": True, "chainDone": True,
            "reviewTicketConsumed": True, "reviewTicket": "fixture-ticket", "reviewGeneration": "fixture-generation", "revision": 9,
            "workflowArtifacts": {"progress": ".zensu/progress/test.md"}})
        text = "\n".join(["- Phase 6 audit — see Native workflow status below.",
            "- Chain close and final report — see Native workflow status below.",
            "<!-- zensu:workflow-status -->", "- [x] Implementation audit accepted",
            "- [x] Code review converged", "- [x] Workflow chain closed",
            "Workflow generation: fixture-generation. Observed revision: 9.", "<!-- /zensu:workflow-status -->"])
        self.write("project/.zensu/progress/test.md", text)
        self.assertEqual(self.analyze()["checks"]["progress"]["status"], "pass")
        self.write("project/.zensu/progress/test.md", text.replace("Observed revision: 9.", "Observed revision: 8."))
        self.assertNotEqual(self.analyze()["checks"]["progress"]["status"], "pass")

    def test_scoped_receipt_checks_current_files_log_identity_and_tree(self):
        receipt, state = self.scoped_receipt()
        read = analyzer.RunReader(self.root)
        validate = lambda: analyzer.landing_scope(read, receipt, state, "scv1_" + self.digest)
        self.assertEqual(validate()["status"], "pass")
        receipt["auditScope"]["generation"] = "other"
        self.assertEqual(validate()["status"], "fail")
        receipt["auditScope"]["generation"] = "fixture-generation"
        receipt["auditScope"]["claims"][0]["certified"] = False
        self.assertEqual(validate()["status"], "fail")
        receipt["auditScope"]["claims"][0]["certified"] = True
        self.write("project/src/index.js", "changed")
        self.assertEqual(validate()["status"], "fail")

    def test_audit_log_prefix_allows_verdicts_but_refuses_new_claims_or_rewrite(self):
        receipt, state = self.scoped_receipt()
        read = analyzer.RunReader(self.root)
        log = self.root / "project/.zensu/logs/test.log"
        original = log.read_text()
        validate = lambda: analyzer.landing_scope(read, receipt, state, "scv1_" + self.digest)
        log.write_text(original + "[fixture] EDIT LANDING AUDIT — claims=1\n")
        self.assertEqual(validate()["status"], "pass")
        log.write_text(original + "[fixture] IMPL completed — files: src/extra.js\n")
        self.assertEqual(validate()["status"], "fail")
        log.write_text(original.replace("fixture", "changed"))
        self.assertEqual(validate()["status"], "fail")

    def test_read_only_tree_detects_untracked_files_and_mode_changes(self):
        receipt, _ = self.scoped_receipt()
        tree = receipt["auditScope"]["tree"]["tree"]
        read = analyzer.RunReader(self.root)
        self.assertEqual(analyzer.current_tree(read, tree)["status"], "pass")
        added = self.write("project/untracked.js", "extra")
        self.assertEqual(analyzer.current_tree(read, tree)["status"], "fail")
        added.unlink()
        os.chmod(self.root / "project/src/index.js", 0o755)
        self.assertEqual(analyzer.current_tree(read, tree)["status"], "fail")

    def test_git_attributes_or_external_includes_are_not_false_passes(self):
        receipt, _ = self.scoped_receipt()
        read = analyzer.RunReader(self.root)
        tree = receipt["auditScope"]["tree"]["tree"]
        attributes = self.write("project/.gitattributes", "*.js text\n")
        self.assertEqual(analyzer.current_tree(read, tree)["status"], "unassessed")
        attributes.unlink()
        config = self.root / "project/.git/config"
        config.write_text(config.read_text() + "\n[include]\n path = /not-read-by-analyzer\n")
        self.assertEqual(analyzer.current_tree(read, tree)["status"], "unassessed")

    def test_inherited_dirty_context_with_current_certified_scope_is_valid(self):
        self.scoped_receipt(pending_history=True)
        events = []
        for i, (extra, pending, code) in enumerate([(" --dirty-before paths.txt", 1, 1), (" --predicates proof.json", 0, 0)]):
            events.append({"id": f"s{i}", "type": "tool.execution_start", "timestamp": str(i*2), "data": {
                "toolCallId": str(i), "toolName": "bash", "arguments": {"command": "bash plugin/hooks/lib/zensu-edit-landing.sh --log test.log" + extra}}})
            events.append({"id": f"e{i}", "type": "tool.execution_complete", "timestamp": str(i*2+1), "data": {
                "toolCallId": str(i), "success": True, "shellExecution": {"exitCode": code},
                "result": {"content": f"EDIT LANDING AUDIT — claims=1 landed={1-pending} not_landed=0 unverified=0 pending={pending}"}}})
        self.write("output.jsonl", "\n".join(map(json.dumps, events)) + "\n")
        result = self.analyze()["checks"]
        self.assertEqual(result["editLandingScope"]["status"], "pass")
        self.assertEqual(result["editLandingContext"]["status"], "pass")
        self.assertEqual(result["editLandingContext"]["evidence"][0]["contextInheritedCalls"], ["1"])

    def test_explicit_gate_bypass_or_relaxed_config_cannot_pass(self):
        self.assertEqual(analyzer.gate_assignments('echo "ZENSU_ACCEPTANCE_GATE=off"'), [])
        self.assertTrue(analyzer.gate_assignments('export ZENSU_ACCEPTANCE_GATE=off; bash helper'))
        self.write("project/.zensu/config.json", {"hooks": {"reviewPanel": "full"}, "evidence": {
            "fullSuiteGate": "required", "acceptanceGate": "required", "fullSuiteRunner": "local"}})
        state = {"session_id_hash": "sha256:" + self.digest, "bypasses": []}
        self.write(self.state_name, state)
        self.assertEqual(self.analyze()["checks"]["requiredGates"]["status"], "pass")
        state["bypasses"] = ["ZENSU_EDIT_LANDING_GATE"]
        self.write(self.state_name, state)
        self.assertEqual(self.analyze()["checks"]["requiredGates"]["status"], "fail")
        state["bypasses"] = []
        self.write(self.state_name, state)
        self.write("project/.zensu/config.json", {"evidence": {"acceptanceGate": "advisory"}})
        self.assertEqual(self.analyze()["checks"]["requiredGates"]["status"], "fail")

    def test_captured_native_records_require_exact_references_hashes_and_current_tree(self):
        receipt, state = self.scoped_receipt()
        tree = receipt["auditScope"]["tree"]["tree"]
        key = "scv1_" + self.digest
        full = "er1_1000000000000_aaaaaaaaaaaa"
        acceptance = "er1_1000000000001_bbbbbbbbbbbb"
        references = {"fixture-call": set()}
        rows = []
        def add(identifier, store, kind, value):
            data = (json.dumps(value) + "\n").encode() if kind == "record" else value
            target = f"evidence-capture/{store}/{identifier}." + ("json" if kind == "record" else "log")
            self.write(target, data.decode())
            references["fixture-call"].add(identifier)
            rows.append({"id": identifier, "kind": kind, "capture": target, "bytes": len(data),
                "sha256": analyzer.sha(data), "callIds": ["fixture-call"]})
        for identifier, scope in [(full, "full"), (acceptance, "acceptance")]:
            add(identifier, "evidence-run", "record", {"schema": "evidence-run-v1", "id": identifier,
                "session_key": key, "project_root": str(self.root / "project"), "scope": scope,
                "state": "completed", "exit_code": 0, "signal": None, "tree_start": tree, "tree_end": tree,
                "log_bytes": 5, "log_truncated": False, "started_at": "fixture"})
            add(identifier, "evidence-run", "log", b"pass\n")
        for i in range(1, 5):
            identifier = f"av1_100000000000{i}_ccccccccccc{i}"
            add(identifier, "acceptance-verify", "record", {"schema": "acceptance-verify-v1", "id": identifier,
                "session_key": key, "project_root": str(self.root / "project"), "ac": f"AC-00{i}",
                "verdict": "pass", "tree": tree, "stem": "test", "plan": ".zensu/plans/test.md",
                "evidence_run": acceptance, "recorded_at": "fixture"})
        manifest = {"sessionId": self.session, "sessionKey": key, "runDirectory": str(self.root), "files": rows}
        self.write("evidence-capture/manifest.json", manifest)
        validate = lambda: analyzer.native_evidence(analyzer.RunReader(self.root), self.session, key, state, receipt, references, "fail")
        self.assertEqual(validate()["status"], "pass")
        original = (self.root / rows[-1]["capture"]).read_text()
        self.write(rows[-1]["capture"], original + " ")
        self.assertEqual(validate()["status"], "fail")
        self.write(rows[-1]["capture"], original)
        references["fixture-call"].remove(full)
        self.assertEqual(validate()["status"], "fail")
        references["fixture-call"].add(full)
        self.write("project/untracked.js", "changed")
        self.assertEqual(validate()["status"], "fail")

    def test_external_capture_controller_requires_exit_and_rejects_linked_destination(self):
        path = Path(__file__).resolve().parents[1] / "validation/copilot-workflow-fixes-2026-10-19/capture-native-evidence.py"
        spec = importlib.util.spec_from_file_location("evidence_capture", path)
        capture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(capture)
        with self.assertRaisesRegex(ValueError, "only after"):
            capture.capture(self.root, self.session)
        self.write("outside/kept.txt", "unchanged")
        (self.root / "evidence-capture").symlink_to(self.root / "outside", target_is_directory=True)
        with self.assertRaises(ValueError):
            capture.preserve(self.root / "evidence-capture/kept.txt", b"altered")
        self.assertEqual((self.root / "outside/kept.txt").read_text(), "unchanged")

    def test_helper_mentions_cannot_become_native_workflow_milestones(self):
        helper = analyzer.helper_arguments
        self.assertEqual(helper('rg -- "--chain-done" plugin/zensu-log.sh', 'zensu-log.sh'), [])
        self.assertEqual(helper('echo bash plugin/zensu-log.sh --chain-done', 'zensu-log.sh'), [])
        self.assertEqual(helper("cat <<'EOF'\nbash plugin/zensu-log.sh --chain-done\nEOF", 'zensu-log.sh'), [])
        self.assertEqual(helper("bash plugin/zensu-log.sh --acceptance-record <<'EVIDENCE'\nbash fake/zensu-log.sh --chain-done\nEVIDENCE\nbash plugin/zensu-log.sh --acceptance-status", 'zensu-log.sh'), [['--acceptance-record', '<<', 'EVIDENCE'], ['--acceptance-status']])
        command = '# native context\nexport X=value; cd project\nbash "$ROOT/hooks/lib/zensu-log.sh" --chain-done --claimed-review-ticket ticket'
        self.assertEqual(helper(command, 'zensu-log.sh'), [['--chain-done', '--claimed-review-ticket', 'ticket']])


if __name__ == "__main__":
    unittest.main()
