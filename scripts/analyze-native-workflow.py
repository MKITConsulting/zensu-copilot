#!/usr/bin/env python3
"""Read-only analysis of explicitly named native invoice runs and exact sessions.

Prints bounded JSON metadata, never raw model reasoning, prompts or tool output.
It opens only files inside each named run. Bounded git ls-tree/ls-files reads
can verify the invoice tree; no shell, workflow helper, model, credential store
or process-control operation is invoked. Repeat both
--run-dir and --session-id in the same order to compare independent runs.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys


PACKET_START = "\n\n--- ZENSU CANONICAL REVIEW PACKET ---\nREVIEW PACKET v1\n"
PACKET_END = "\n--- END ZENSU CANONICAL REVIEW PACKET ---"
ASPECTS = {"conventions", "bugs", "architecture", "tests", "security"}
FLAGS = ("--tdd-begin", "--execution-start", "--tdd-complete", "--code-review-done",
         "--chain-done", "--chain-report", "--self-review-fixed", "--acceptance-record", "--acceptance-status")
MAX_FILE = 128 * 1024 * 1024
MAX_EVENT = 8 * 1024 * 1024
ORIGINAL_CHECKS = {
    "specified invoice", "half-up rounding", "empty items and zero discount default",
    "frozen inputs unchanged", "exact maximum safe subtotal", "subtotal overflow rejected",
    "sum overflow rejected", "invalid items rejected", "invalid discounts rejected",
    "200 seeded exact arithmetic samples", "existing formatter preserved", "CLI exact output",
    "CLI default discount", "CLI error contract",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    """Match JSON.stringify(stable(value)) for the packet's JSON data model."""
    if isinstance(value, dict):
        indexes = sorted((k for k in value if re.fullmatch(r"0|[1-9][0-9]*", k)
                          and int(k) < 2**32 - 1), key=int)
        rest = sorted(set(value) - set(indexes), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(canonical(k) + ":" + canonical(value[k]) for k in indexes + rest) + "}"
    if isinstance(value, list):
        return "[" + ",".join(map(canonical, value)) + "]"
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError("unsupported fractional packet value")
        value = int(value)
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def arguments(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            return {"patch": value}
    return {}


def result_text(event):
    data = event.get("data", {})
    result = data.get("result", {})
    return result.get("content", "") if isinstance(result, dict) else ""


def check(status, reason, evidence=None):
    return {"status": status, "reason": reason, "evidence": evidence or []}


def acceptance_status_pass(text):
    lines = re.findall(r"^ACCEPTANCE STATUS[^\r\n]*?\b(\d+)/(\d+) active criteria pass\b[^\r\n]*$", text, re.M)
    return bool(lines and lines[-1] == ("4", "4"))


def acceptance_is_current(status, last_edit, native_records):
    # A temporary proof file can be added and removed after the status command.
    # Only the independently validated final record/tree graph can supersede
    # this conservative timestamp check; a failed/stale status stays failed.
    return bool(status and status.get("successful") and acceptance_status_pass(status.get("text", ""))
        and (not last_edit or (status.get("completedAt") or "") > last_edit
             or native_records.get("status") == "pass"))


def source_name(value):
    if (not isinstance(value, str) or not value or len(value) > 4096 or value.startswith("/") or "\\" in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)
            or any(part in {"", ".", "..", ".git"} for part in value.split("/"))):
        raise ValueError("noncanonical source path")
    return value


def gate_assignments(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    lexer.commenters = "#"
    found, assignment_position = [], True
    try:
        for token in lexer:
            if token in {";", "&&", "||", "|", "&"}:
                assignment_position = True
            elif assignment_position and re.fullmatch(r"ZENSU_(?:EDIT_LANDING|FULL_SUITE|ACCEPTANCE|REQUIREMENTS)_GATE=off", token):
                found.append(token)
            elif assignment_position and (token in {"export", "env"} or re.match(r"[A-Za-z_][A-Za-z0-9_]*=", token)):
                continue
            else:
                assignment_position = False
    except ValueError:
        pass
    # Newlines separate shell commands; shlex otherwise treats them as spaces.
    for line in command.splitlines():
        if re.match(r"\s*(?:export\s+|env\s+)?ZENSU_(?:EDIT_LANDING|FULL_SUITE|ACCEPTANCE|REQUIREMENTS)_GATE=['\"]?off(?:['\"]?(?:\s|$))", line):
            found.append(line.strip().split()[0])
    return sorted(set(found))


def helper_arguments(command, basename):
    """Recognize direct literal shell invocations, not grep/echo mentions.

    Literal heredoc bodies are excluded; commands that consume them still count.
    Unsupported shell programs require manual analysis. Never execute or expand
    their contents to manufacture a workflow milestone.
    """
    pending, commands = [], []
    for line in command.splitlines(keepends=True):
        if pending:
            delimiter, strip_tabs = pending[0]
            candidate = line.rstrip("\r\n")
            if (candidate.lstrip("\t") if strip_tabs else candidate) == delimiter:
                pending.pop(0)
            continue
        line_lexer = shlex.shlex(line, posix=True, punctuation_chars="<>")
        line_lexer.whitespace_split = True
        line_lexer.commenters = "#"
        try:
            line_tokens = list(line_lexer)
        except ValueError:
            return []
        for i, token in enumerate(line_tokens):
            if token == "<<":
                if i + 1 == len(line_tokens):
                    return []
                delimiter = line_tokens[i + 1]
                strip_tabs = delimiter.startswith("-")
                delimiter = delimiter[1:] if strip_tabs else delimiter
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", delimiter):
                    return []
                pending.append((delimiter, strip_tabs))
        commands.append(line)
    if pending:
        return []
    command = "".join(commands)
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = "#"
    try:
        tokens = list(lexer)
    except ValueError:
        return []
    segments, segment = [], []
    for token in tokens + [";"]:
        if token and all(c in ";&|\n" for c in token):
            if segment:
                segments.append(segment)
            segment = []
        else:
            segment.append(token)
    result = []
    for segment in segments:
        i = 0
        if segment and segment[0] == "env":
            i += 1
        while i < len(segment) and re.match(r"[A-Za-z_][A-Za-z0-9_]*=", segment[i]):
            i += 1
        if i < len(segment) and Path(segment[i]).name in {"bash", "sh"}:
            i += 1
            if i < len(segment) and segment[i] == "--":
                i += 1
        if i < len(segment) and Path(segment[i]).name == basename:
            result.append(segment[i+1:])
    return result


def current_tree(reader, expected):
    """Read-only Git inventory and raw blob hashing for this plain invoice repo."""
    if not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", expected or ""):
        return check("fail", "Invalid receipt tree identifier.")
    project = reader.root / "project"
    for name in (".git", ".git/config"):
        target = project / name
        if target.is_symlink():
            return check("unassessed", "Linked Git metadata is outside this analyzer's invoice scope.")
    if not (project / ".git").is_dir():
        return check("unassessed", "Invoice tree validation requires its own local Git directory.")
    try:
        config = reader.read("project/.git/config", maximum=256 * 1024).decode()
        if re.search(r"^\s*\[\s*include|^\s*(?:worktree|worktreeConfig)\s*=", config, re.M | re.I):
            return check("unassessed", "Git includes or alternate worktree configuration are outside the bounded invoice scope.")
        metadata = list((project / ".git").rglob("*"))
        if len(metadata) > 10000 or any(p.is_symlink() for p in metadata):
            return check("unassessed", "Linked or oversized Git metadata is outside the bounded invoice scope.")
        if any((project / ".git" / p).exists() for p in ("objects/info/alternates", "commondir", "gitdir")):
            return check("unassessed", "External Git metadata is outside the bounded invoice scope.")
    except (OSError, ValueError, UnicodeError):
        return check("unassessed", "Local Git metadata could not be validated safely.")
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
               GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", GIT_ATTR_NOSYSTEM="1", LC_ALL="C")
    def git(args):
        result = subprocess.run(["git", "--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false",
                                 "-c", "core.attributesFile=" + os.devnull,
                                 "-c", "core.excludesFile=" + os.devnull, *args], cwd=project,
                                env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
            raise ValueError("read-only Git inventory unavailable")
        return result.stdout
    try:
        entries = git(["ls-tree", "-r", "-z", expected]).split(b"\0")
        inventory = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split(b"\0")
        current = {source_name(x.decode("utf-8")) for x in inventory if x and not x.startswith(b".zensu/")}
        current = {x for x in current if reader.read(Path("project") / x, optional=True, maximum=8 * 1024 * 1024) is not None}
        expected_paths, mismatches = set(), []
        if len(entries) > 10000 or len(current) > 10000:
            return check("unassessed", "Inventory exceeds invoice analyzer bound.")
        for entry in entries:
            if not entry:
                continue
            header, raw_name = entry.split(b"\t", 1)
            mode, kind, digest = header.decode("ascii").split(" ")
            name = source_name(raw_name.decode("utf-8"))
            if name.startswith(".zensu/"):
                return check("fail", "Receipt tree unexpectedly contains workflow internals.")
            if Path(name).name == ".gitattributes" or kind != "blob" or mode not in {"100644", "100755"}:
                return check("unassessed", "Attributes, symlinks or submodules need a separate native tree validator.")
            expected_paths.add(name)
            value = reader.read(Path("project") / name, optional=True, maximum=8 * 1024 * 1024)
            if value is None:
                mismatches.append(name)
                continue
            blob = b"blob " + str(len(value)).encode() + b"\0" + value
            actual = hashlib.sha1(blob).hexdigest() if len(digest) == 40 else sha(blob)
            actual_mode = "100755" if (project / name).stat().st_mode & 0o111 else "100644"
            if actual != digest or actual_mode != mode:
                mismatches.append(name)
        if any(Path(x).name == ".gitattributes" for x in current):
            return check("unassessed", "Current attributes need a separate native tree validator.")
        mismatches += sorted(current ^ expected_paths)
        return check("fail" if mismatches else "pass", "Read-only native Git inventory plus independently hashed current blobs and executable modes.",
                     [{"tree": expected, "files": len(expected_paths), "mismatches": sorted(set(mismatches))}])
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        return check("unassessed", "Bounded read-only Git inventory could not be validated.")


def landing_scope(reader, receipt, state, key):
    scope = receipt.get("auditScope") if receipt else None
    if not scope:
        return check("unassessed", "Historical receipt has no persisted scope; clean alone cannot prove context preservation.")
    project = reader.root / "project"
    try:
        if (receipt.get("clean") is not True or receipt.get("auditFailure")
                or type(receipt.get("claims")) is not int or receipt["claims"] < 1
                or receipt.get("landed") != receipt["claims"]
                or any(receipt.get(k) != 0 for k in ("pending", "notLanded", "unverified"))):
            raise ValueError("unclean scope")
        if scope.get("schema") != "edit-landing-scope-v1" or scope.get("root") != str(project) or scope.get("sessionKey") != key or scope.get("generation") != state.get("reviewGeneration"):
            raise ValueError("scope identity")
        if scope.get("claimRoot") != str(project):
            return check("unassessed", "Nested claim roots require a separate validator; this analyzer is bound to the plain invoice root.")
        if (not isinstance(scope.get("baseline"), str) or not isinstance(scope.get("epoch"), str)
                or not isinstance(scope.get("dirty"), list)
                or any(source_name(p) != p for p in scope["dirty"])
                or scope["dirty"] != sorted(set(scope["dirty"]))):
            raise ValueError("scope context")
        if scope.get("log") != str(project / state.get("workflowArtifacts", {}).get("log", "")):
            raise ValueError("scope log")
        log = reader.read(scope["log"])
        prefix = scope["logPrefix"]; count = prefix["bytes"]
        if type(count) is not int or count < 0 or count > len(log) or sha(log[:count]) != prefix["sha256"]:
            raise ValueError("log prefix")
        for line in log[count:].decode().splitlines():
            entry = re.sub(r"^\[[^]]*\]\s*", "", line.lstrip())
            if not re.match(r"EDIT LANDED |EDIT NOT LANDED |EDIT LANDING AUDIT |PENDING PREDICATE |UNVERIFIED |RECEIPT REFUSED ", entry) and re.search(r"IMPL completed [—–-] files:|\bWIRED\b", entry):
                raise ValueError("new claims")
        claims = scope.get("claims", [])
        if not isinstance(claims, list) or len(claims) != receipt.get("claims") or not claims or any(c.get("certified") is not True or not isinstance(c.get("raw"), str) or not isinstance(c.get("step"), str) for c in claims):
            raise ValueError("uncertified claims")
        snapshots = scope.get("snapshots", {})
        if not isinstance(snapshots, dict) or {c.get("path") for c in claims if c.get("path")} != set(snapshots):
            raise ValueError("snapshot inventory")
        for name, snapshot in snapshots.items():
            source_name(name)
            value = reader.read(Path("project") / name, optional=True, maximum=8 * 1024 * 1024)
            expected = {"path": name, "exists": value is not None}
            if value is not None:
                expected.update(bytes=len(value), sha256=sha(value))
            if snapshot != expected:
                raise ValueError("snapshot changed")
        tree = scope.get("tree", {})
        result = current_tree(reader, tree.get("tree")) if tree.get("kind") == "git" else check("unassessed", "Non-Git scope is not the invoice baseline.")
        return check(result["status"], "Scope identity, certified claims, append-only log prefix and current snapshots checked; " + result["reason"],
                     [{"generation": scope["generation"], "claims": len(claims), "snapshots": len(snapshots), "inheritedDirtyPaths": len(scope.get("dirty", [])), "treeCheck": result}])
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return check("fail", "Receipt scope, log history, claim certification or current file snapshots do not match.")


def native_evidence(reader, session, key, state, receipt, references, missing):
    manifest = reader.obj("evidence-capture/manifest.json", optional=True)
    if not manifest:
        return check(missing, "Exact-session native full-suite and acceptance record capture is still required.")
    try:
        if manifest.get("sessionId") != session or manifest.get("sessionKey") != key or manifest.get("runDirectory") != str(reader.root):
            raise ValueError("capture identity")
        runs, acceptance, logs = {}, {}, {}
        for row in manifest.get("files", []):
            identifier = row["id"]
            if not re.fullmatch(r"(?:er1|av1)_[0-9]{13}_[a-f0-9]{12}", identifier):
                raise ValueError("record identifier")
            if not row.get("callIds") or any(identifier not in references.get(call, set()) for call in row["callIds"]):
                raise ValueError("native reference missing")
            store = "evidence-run" if identifier.startswith("er1_") else "acceptance-verify"
            suffix = ".log" if row["kind"] == "log" else ".json"
            target = "evidence-capture/" + store + "/" + identifier + suffix
            if row["capture"] != target:
                raise ValueError("capture path")
            data = reader.read(target, maximum=6 * 1024 * 1024)
            if len(data) != row["bytes"] or sha(data) != row["sha256"]:
                raise ValueError("capture hash")
            if row["kind"] == "log":
                if identifier in logs:
                    raise ValueError("duplicate captured log")
                logs[identifier] = data
                continue
            if row["kind"] != "record":
                raise ValueError("capture kind")
            value = json.loads(data)
            if value.get("id") != identifier or value.get("session_key") != key or value.get("project_root") != str(reader.root / "project"):
                raise ValueError("record binding")
            bucket = runs if store == "evidence-run" else acceptance
            if identifier in bucket:
                raise ValueError("duplicate captured record")
            bucket[identifier] = value
        full = sorted((x for x in runs.values() if x.get("scope") == "full"), key=lambda x: x.get("started_at") or "")
        if not full:
            raise ValueError("missing full suite")
        final_full = full[-1]
        tree = (receipt or {}).get("auditScope", {}).get("tree", {}).get("tree") or final_full.get("tree_end")
        def green_run(value, scope):
            return (value.get("schema") == "evidence-run-v1" and value.get("scope") == scope and value.get("state") == "completed"
                and value.get("exit_code") == 0 and value.get("signal") is None
                and value.get("tree_start") == tree and value.get("tree_end") == tree
                and value.get("id") in logs and value.get("log_bytes") == len(logs[value["id"]])
                and value.get("log_truncated") is False)
        if not green_run(final_full, "full"):
            raise ValueError("latest full suite is not green on final tree")
        latest = {}
        for value in sorted(acceptance.values(), key=lambda x: x.get("recorded_at") or ""):
            latest[value.get("ac")] = value
        if set(latest) != {"AC-001", "AC-002", "AC-003", "AC-004"}:
            raise ValueError("four criteria required")
        log_path = state.get("workflowArtifacts", {}).get("log", "")
        stem = Path(log_path).stem
        for value in latest.values():
            if (value.get("schema") != "acceptance-verify-v1" or value.get("verdict") != "pass" or value.get("tree") != tree
                    or value.get("stem") != stem or value.get("plan") != ".zensu/plans/" + stem + ".md"
                    or not green_run(runs.get(value.get("evidence_run"), {}), "acceptance")):
                raise ValueError("acceptance record is stale, unbound or has no green native run")
        current = current_tree(reader, tree)
        return check(current["status"], "Exact native helper references, capture hashes, latest full-suite and four final criterion records agree on the independently checked current tree.",
            [{"manifest": "evidence-capture/manifest.json", "manifestSha256": sha(reader.read("evidence-capture/manifest.json")),
              "fullSuite": final_full["id"], "acceptanceRecords": {ac: row["id"] for ac, row in latest.items()},
              "acceptanceRuns": sorted({row["evidence_run"] for row in latest.values()}), "currentTree": current}])
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return check("fail", "Captured native evidence identity, reference, hash, final tree, full suite or four acceptance records do not agree.")


class RunReader:
    def __init__(self, directory):
        self.root = Path(directory).resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("run directory is not a directory")
        self.errors = []

    def relative(self, supplied):
        path = Path(supplied)
        if path.is_absolute():
            path = path.relative_to(self.root)
        if ".." in path.parts or not path.parts:
            raise ValueError("path leaves the named run")
        return path

    def read(self, supplied, optional=False, maximum=MAX_FILE):
        relative = self.relative(supplied)
        path = self.root
        try:
            for part in relative.parts:
                path /= part
                info = path.lstat()
                if stat.S_ISLNK(info.st_mode):
                    raise ValueError("symlink evidence refused")
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
                raise ValueError("nonregular or oversized evidence refused")
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as handle:
                opened = os.fstat(handle.fileno())
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    raise ValueError("evidence changed while opening")
                data = handle.read(maximum + 1)
                if len(data) > maximum:
                    raise ValueError("evidence grew past its bound")
                return data
        except FileNotFoundError:
            if optional:
                return None
            raise

    def obj(self, supplied, optional=False):
        data = self.read(supplied, optional, maximum=8 * 1024 * 1024)
        return json.loads(data) if data is not None else None

    def files(self, directory, pattern):
        base = self.root if str(directory) == "." else self.root / self.relative(directory)
        if not base.exists():
            return []
        if base.is_symlink() or not base.is_dir():
            raise ValueError("unsafe evidence directory")
        return sorted(base.glob(pattern))


def packet(reader, args):
    prompt = args.get("prompt", "")
    if not isinstance(prompt, str):
        return {"valid": False, "reason": "missing prompt"}
    refs = re.findall(r"^REVIEW-PACKET: (.+) sha256:([a-f0-9]{64})$", prompt, re.M)
    row = {"valid": False, "references": len(refs), "injected": PACKET_START in prompt}
    if len(refs) != 1:
        return row
    filename, digest = refs[0]
    row["packetHash"] = digest
    try:
        data = reader.obj(filename)
        row["reference"] = str(reader.relative(filename))
        row["valid"] = data.get("schema") == "zensu-review-packet-v1" and data.get("sha256") == digest == sha(canonical(data.get("payload")).encode())
        row["changedFiles"] = data.get("payload", {}).get("changed_files")
        if row["injected"]:
            body = prompt.split(PACKET_START, 1)[1]
            row["valid"] &= prompt.count(PACKET_START) == 1 and body.endswith(PACKET_END)
            body = body.removesuffix(PACKET_END)
            row["injectedPayloadHash"] = sha(canonical(json.loads(body)).encode())
            row["injectionBytesSha256"] = sha(body.encode())
            row["valid"] &= row["injectedPayloadHash"] == digest
    except (OSError, ValueError, TypeError, KeyError):
        row["valid"] = False
        row["reason"] = "reference or injected payload could not be verified inside this run"
    return row


def task_role(args):
    agent = str(args.get("agent_type", "")).removeprefix("zensu:")
    if agent == "review-judge":
        return "secondary" if re.search(r"^judge_run: second\s*$", args.get("prompt", ""), re.M) else "primary"
    if re.fullmatch(r"zensu-review-[A-Za-z0-9_-]+", agent):
        return "persona"
    return {"review-aspect": "aspect", "code-reviewer": "consume"}.get(agent)


def substantive(role, text):
    if not isinstance(text, str) or "REVIEW PACKET INVALID" in text:
        return False
    if role == "consume":
        return bool(re.search(r"^# Code Review Report\s*$", text, re.M)
                    and re.search(r"^- Verdict: (PASS|PASS WITH SUGGESTIONS|NEEDS CHANGES)\s*$", text, re.M))
    heading = r"^## Aspect: judge\s*$" if role == "primary" else r"^## Aspect: judge \(second run\)\s*$" if role == "secondary" else r"^## Aspect: .+\s*$" if role == "persona" else r"^## Aspect: (conventions|bugs|architecture|tests|security)\s*$"
    content = re.search(r"^- \(no findings\)\s*$", text, re.M) or (
        re.search(r"\b(CRITICAL|IMPORTANT|SUGGESTION)\b", text)
        and "Evidence:" in text and ("Fix:" in text or role in {"aspect", "persona"} and re.search(r"\b\S+:\d+\b", text)))
    return bool(re.search(heading, text, re.M) and content)


def source_paths(args, project):
    supplied = [args[k] for k in ("path", "file_path", "filename") if isinstance(args.get(k), str)]
    for key in ("patch", "input"):
        if isinstance(args.get(key), str):
            supplied += re.findall(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$", args[key], re.M)
    result = []
    for item in supplied:
        path = Path(item)
        try:
            relative = path.relative_to(project) if path.is_absolute() else path
        except ValueError:
            continue
        if ".." not in relative.parts and ".zensu" not in relative.parts:
            result.append(relative.as_posix())
    return result


def analyze(directory, session):
    reader = RunReader(directory)
    harness = reader.obj("harness.json")
    process = reader.obj("process.json", optional=True)
    command = reader.obj("command.json", optional=True)
    if harness.get("sessionId") != session or harness.get("runDirectory") != str(reader.root):
        raise ValueError("explicit session/run does not match harness identity")
    if process and process.get("sessionId") != session:
        raise ValueError("process belongs to another session")
    if command:
        positions = [i for i, value in enumerate(command) if value == "--session-id"]
        if len(positions) != 1 or command[positions[0] + 1] != session:
            raise ValueError("launch command does not bind the exact session")
    key = "scv1_" + sha(b"zensu.session-control/v1/session-id\0" + session.encode())
    state_path = "project/.zensu/state/tdd-phase-" + key + ".json"
    state = reader.obj(state_path, optional=True) or {}
    if state and state.get("session_id_hash") != "sha256:" + key.removeprefix("scv1_"):
        raise ValueError("workflow state belongs to another session")
    exit_record = reader.obj("exit.json", optional=True)
    interruption = reader.obj("controller-interruption.json", optional=True)
    if interruption and interruption.get("sessionId") != session:
        raise ValueError("controller interruption belongs to another session")
    missing = "fail" if exit_record else "pending"
    events, event_sources, ids, malformed = [], [], set(), 0
    for path in sorted(set(reader.files(".", "output*.jsonl") + reader.files(".", "events*.jsonl"))):
        raw = reader.read(path)
        event_sources.append({"path": str(reader.relative(path)), "bytes": len(raw), "sha256": sha(raw)})
        for line in raw.splitlines():
            if len(line) > MAX_EVENT:
                malformed += 1
                continue
            try:
                event = json.loads(line)
            except ValueError:
                malformed += 1
                continue
            if not isinstance(event, dict):
                malformed += 1
                continue
            identity = event.get("id")
            if identity in ids:
                continue
            if identity:
                ids.add(identity)
            data = event.get("data", {})
            if isinstance(data, dict) and data.get("sessionId") not in (None, session):
                raise ValueError("foreign session found in named event stream")
            # Reasoning/delta/model internals are never retained or reported.
            if event.get("type") in {"tool.execution_start", "tool.execution_complete", "subagent.started",
                                    "subagent.completed", "assistant.message", "session.error", "session.shutdown"}:
                events.append({k: v for k, v in event.items() if k in ("type", "data", "timestamp", "id", "agentId")})
    events.sort(key=lambda e: e.get("timestamp") or "")
    starts, ends, child_starts, child_ends = {}, {}, {}, {}
    for event in events:
        data = event.get("data", {})
        if not isinstance(data, dict):
            continue
        call = data.get("toolCallId")
        if event["type"] == "subagent.started":
            child_starts[call] = event
        elif event["type"] == "subagent.completed":
            child_ends[call] = event
        elif not event.get("agentId") and not data.get("ownerAgentId"):
            if event["type"] == "tool.execution_start":
                starts[call] = event
            elif event["type"] == "tool.execution_complete":
                ends[call] = event
    tasks, milestones, source_edits, skill_loads, oversized, verifier_runs, acceptance_runs = [], [], [], [], [], [], []
    binding_errors, copied_bindings, external_imports, landing_audits, gate_escapes = [], [], [], [], []
    for call, event in starts.items():
        data = event["data"]; args = arguments(data.get("arguments")); end = ends.get(call, {})
        end_data = end.get("data", {}); text = result_text(end); tool = data.get("toolName")
        ok = end_data.get("success") is True
        if tool == "bash":
            cmd = args.get("command", "")
            if not isinstance(cmd, str):
                continue
            code = end_data.get("shellExecution", {}).get("exitCode")
            completed = ok and code == 0
            helper_calls = helper_arguments(cmd, "zensu-log.sh")
            assignments = gate_assignments(cmd)
            escaped_verdict = helper_calls and re.search(r"^(?:FULL SUITE|ACCEPTANCE) [—–-] escaped\b", text, re.M)
            if assignments or escaped_verdict:
                gate_escapes.append({"callId": call, "assignments": assignments, "escapedVerdict": bool(escaped_verdict)})
            for flag in FLAGS:
                if any(flag in invocation for invocation in helper_calls):
                    observed_success = completed
                    if flag == "--acceptance-status":
                        # A later command in the same shell can exit zero after
                        # this subcommand refused stale or failed criteria.
                        observed_success = completed and acceptance_status_pass(text)
                    milestones.append({"operation": flag, "callId": call, "startedAt": event.get("timestamp"),
                                       "completedAt": end.get("timestamp"), "successful": observed_success,
                                       "exitCode": code, "exitCodeScope": "whole-shell-command-not-individual-subcommands", "ticketQualified": "--claimed-review-ticket" in cmd,
                                       "resultSha256": sha(text.encode()), "text": text})
            # Native execution_start contains the hook-rewritten command. A
            # prefix here is expected; only preToolUse input can prove copying.
            if "Malformed session binding" in text or "binding is malformed" in text:
                binding_errors.append(call)
            if "--external-review" in cmd:
                external_imports.append(call)
            if helper_arguments(cmd, "zensu-edit-landing.sh"):
                summary = re.findall(r"^EDIT LANDING AUDIT[^\r\n]*\bpending=(\d+)[^\r\n]*$", text, re.M)
                landing_audits.append({"callId": call, "startedAt": event.get("timestamp"),
                    "completedAt": end.get("timestamp"), "toolSucceeded": ok, "wholeShellExitCode": code,
                    "dirtyBeforeContextSupplied": bool(re.search(r"--dirty-before(?=\s|[=]|$)", cmd)),
                    "pending": int(summary[-1]) if summary else None,
                    "resultSha256": sha(text.encode()), "commandSha256": sha(cmd.encode())})
            if "finding-verify-v1.js" in cmd:
                total = re.search(r"(?:^|\s)total=(\d+)", text)
                input_count = None
                try:
                    tokens = shlex.split(cmd)
                    positions = [i for i, value in enumerate(tokens) if value == "--input"]
                    if len(positions) == 1:
                        filename = tokens[positions[0] + 1]
                        if Path(filename).is_absolute() and "$" not in filename:
                            supplied = reader.obj(filename)
                            if isinstance(supplied.get("findings"), list):
                                input_count = len(supplied["findings"])
                except (OSError, ValueError, TypeError, KeyError, IndexError):
                    pass
                verifier_runs.append({"callId": call, "successful": completed, "jsonInput": "--input" in cmd,
                                      "total": int(total.group(1)) if total else None,
                                      "inputFindingCount": input_count,
                                      "degraded": "invalid-input" in text or "DEGRADED" in text})
            if any("--evidence-run" in invocation and any(invocation[i:i+2] == ["--scope", "acceptance"] for i in range(len(invocation)-1)) for invocation in helper_calls):
                record = re.search(r"record=(er1_[A-Za-z0-9_]+)", text)
                acceptance_runs.append({"callId": call, "successful": completed, "record": record.group(1) if record else None,
                                        "resultSha256": sha(text.encode())})
        if tool in {"create", "edit", "apply_patch", "multi_edit", "str_replace"} and ok:
            paths = source_paths(args, reader.root / "project")
            if paths:
                source_edits.append({"callId": call, "startedAt": event.get("timestamp"), "paths": paths})
        if tool == "skill" and ok:
            skill_loads.append({"skill": args.get("skill"), "callId": call, "startedAt": event.get("timestamp"), "completedAt": end.get("timestamp")})
        if tool == "view" and ok:
            target = args.get("path") or args.get("file_path")
            if target == str(reader.root / "plugin/zensu/skills/zensu-self-review/SKILL.md") and not re.search(r"(?:^|\n)File too large to read at once", text):
                skill_loads.append({"skill": "zensu-self-review", "method": "native-view", "callId": call, "startedAt": event.get("timestamp"), "completedAt": end.get("timestamp")})
        if tool == "view" and isinstance(text, str) and re.search(r"(?:^|\n)File too large to read at once", text):
            oversized.append({"callId": call, "path": args.get("path") or args.get("file_path")})
        role = task_role(args) if tool == "task" else None
        if role:
            aspect = re.search(r"^## Aspect: (conventions|bugs|architecture|tests|security)\s*$", text, re.M)
            tasks.append({"callId": call, "name": args.get("name"), "role": role,
                          "aspect": aspect.group(1) if aspect else None, "startedAt": event.get("timestamp"),
                          "completedAt": end.get("timestamp"), "nativeSuccess": ok, "mode": args.get("mode"),
                          "workerStarted": call in child_starts, "workerCompleted": call in child_ends,
                          "substantive": substantive(role, text), "resultSha256": sha(text.encode()),
                          "formatWarnings": ["Finding has no explicit Fix: label; substantive cited evidence is present."] if role == "aspect" and "Evidence:" in text and "Fix:" not in text else [],
                          "packet": packet(reader, args), "text": text})
    captures, foreign_captures, roots = [], [], set()
    child_sessions = {e.get("agentId") for call, e in child_starts.items() if e.get("agentId")
                      and starts.get(call, {}).get("data", {}).get("toolName") == "task"}
    for folder in ("hooks", "captures", "hook-captures"):
        for path in reader.files(folder, "*.json"):
            data = reader.obj(path); payload = data.get("payload", {})
            if payload.get("sessionId") not in {session} | child_sessions:
                foreign_captures.append(str(reader.relative(path)))
                continue
            roots.add(data.get("environment", {}).get("pluginRoot"))
            args = arguments(payload.get("toolArgs"))
            if data.get("event") == "preToolUse" and payload.get("toolName") == "bash" and str(args.get("command", "")).startswith("# zensu-copilot-context-v1"):
                copied_bindings.append({"capture": str(reader.relative(path)), "sessionId": payload.get("sessionId"), "scope": "main" if payload.get("sessionId") == session else "native-child"})
            if payload.get("toolName") == "task" and task_role(args):
                captures.append({"path": str(reader.relative(path)), "event": data.get("event"),
                                 "name": args.get("name"), "role": task_role(args), "packet": packet(reader, args)})
    checks = {}
    checks["sessionIsolation"] = check("pass" if process and command and not foreign_captures else missing,
        "Exact main identity and only child sessions bound by its native subagent.started events; foreign captures are excluded.", foreign_captures[:20])
    project_config = reader.obj("project/.zensu/config.json", optional=True)
    evidence_config = (project_config or {}).get("evidence", {})
    configured_gates = evidence_config.get("fullSuiteGate") == "required" and evidence_config.get("acceptanceGate") == "required" and evidence_config.get("fullSuiteRunner") == "local" and (project_config or {}).get("hooks", {}).get("reviewPanel") == "full"
    checks["requiredGates"] = check("fail" if gate_escapes or state.get("bypasses") or project_config and not configured_gates else "pass" if configured_gates and state.get("bypasses") == [] else missing,
        "Invoice full-suite and acceptance gates remain required/local, the full panel remains configured, and neither explicit captured gate escapes nor the native bypass ledger may relax the workflow.",
        [{"capturedEscapes": gate_escapes, "nativeBypasses": state.get("bypasses"), "configurationMatches": configured_gates}])
    frozen = reader.obj("frozen-plugin.json", optional=True)
    integrity = {"frozenPayload": None, "globalCaptureComparison": None, "recordedPostcheck": None}
    if frozen:
        plugin = reader.relative(frozen["root"]); mismatches = []
        expected = frozen.get("files", {})
        for path, digest in expected.items():
            try:
                if sha(reader.read(plugin / path)) != digest:
                    mismatches.append(path)
            except (OSError, ValueError):
                mismatches.append(path)
        actual = [p.relative_to(reader.root / plugin).as_posix() for p in (reader.root / plugin).rglob("*") if p.is_file() or p.is_symlink()]
        mismatches += sorted(set(actual) ^ set(expected))
        integrity["frozenPayload"] = {"files": len(expected), "mismatches": sorted(set(mismatches)), "buildSha256": frozen.get("buildSha256")}
        checks["frozenPayload"] = check("fail" if mismatches else "pass", "Current run-local payload compared with every frozen digest.")
        checks["pluginRoot"] = check("pass" if roots == {frozen["root"]} else "fail", "Every captured plugin root must be this run's frozen payload.", sorted(str(x) for x in roots))
    else:
        checks["frozenPayload"] = check(missing, "Frozen payload inventory missing.")
    before = reader.obj("global-before.json", optional=True); after = reader.obj("global-after.json", optional=True)
    post = reader.obj("integrity-after.json", optional=True)
    integrity["globalCaptureComparison"] = before == after if before is not None and after is not None else None
    integrity["recordedPostcheck"] = post
    checks["globalIntegrity"] = check("pass" if before is not None and after == before and post and post.get("globalAndMarketplaceUnchanged") is True else "fail" if after is not None else missing,
        "Compare captured before/after global and marketplace hashes; do not inspect ambient global files.")
    closure = [x for x in milestones if x["operation"] == "--chain-done" and x["successful"] and x["ticketQualified"]]
    close = closure[-1] if closure else None
    state_closed = all(state.get(k) is True for k in ("implComplete", "codeReviewDone", "chainDone", "reviewTicketConsumed")) and bool(state.get("reviewTicket"))
    checks["workflowClosure"] = check("pass" if state_closed and close else missing,
        "Requires exact-session native state and a successful ticket-qualified chain-done call.", [x["callId"] for x in closure])
    implementation = [x for x in milestones if x["operation"] == "--execution-start" and x["successful"]]
    artifacts = state.get("workflowArtifacts", {}); log_text = ""; progress_text = ""
    if artifacts:
        for field in ("log", "progress"):
            name = artifacts.get(field)
            if name:
                value = reader.read(Path("project") / reader.relative(name), optional=True)
                if field == "log": log_text = value.decode() if value else ""
                else: progress_text = value.decode() if value else ""
    generation = state.get("reviewGeneration")
    landing_path = "project/.zensu/state/edit-landing-" + key + ".json"
    landing = reader.obj(landing_path, optional=True)
    landing_clean = bool(landing and landing.get("schema") in {"edit-landing-v1", "edit-landing-v2"}
        and landing.get("session") in {key, session} and landing.get("log") == artifacts.get("log")
        and not landing.get("auditFailure")
        and landing.get("clean") is True and all(landing.get(k) == 0 for k in ("notLanded", "unverified", "pending")))
    history = [{"line": i, "marker": match.group(0)} for i, line in enumerate(log_text.splitlines(), 1)
        if (match := re.search(r"EDIT NOT LANDED|PENDING PREDICATE|UNVERIFIED(?: \([^)]{0,60}\))?|EDIT LANDING AUDIT FAULT", line))]
    checks["editLanding"] = check("pass" if landing_clean else "fail" if exit_record or state_closed else "pending",
        "Final current-session, bound-log edit-landing receipt must remain clean. Historical pending/unverified markers are retained separately and never overwritten by closure state.",
        [{"receipt": landing_path, "sha256": sha(reader.read(landing_path)) if landing else None,
          "currentReceipt": landing, "historicalNonCleanMarkers": history}])
    scope_validation = landing_scope(reader, landing, state, key)
    # Historical bundles have no scoped receipt contract. Keep that limitation
    # explicit; never upgrade their clean boolean to current-scope proof.
    scope_module = reader.read(Path(frozen["root"]) / "hooks/lib/edit-landing-receipt-v1.js", optional=True, maximum=1024 * 1024) if frozen else None
    scoped_package = bool(scope_module and b"edit-landing-scope-v1" in scope_module)
    if scoped_package or landing and landing.get("auditScope"):
        checks["editLandingScope"] = scope_validation
    pending_context = False
    downgraded_audits = []
    for audit in landing_audits:
        if audit["dirtyBeforeContextSupplied"] and audit["pending"] and audit["pending"] > 0:
            pending_context = True
        elif pending_context and audit["pending"] == 0 and not audit["dirtyBeforeContextSupplied"]:
            downgraded_audits.append(audit["callId"])
    pending_paths = set(re.findall(r"PENDING PREDICATE [—–-] [^\r\n:]+: ([^\r\n]+?) was already dirty before", log_text))
    preserved_context = bool(downgraded_audits and scope_validation["status"] == "pass" and pending_paths
        and pending_paths <= set(landing.get("auditScope", {}).get("dirty", [])))
    checks["editLandingContext"] = check("pass" if preserved_context else "fail" if downgraded_audits else "pass" if landing_audits else missing,
        "Omitting a repeated flag is valid only when current certified scope preserves the previously pending paths. A clean boolean alone cannot erase historical pending context.",
        [{"audits": landing_audits, "contextDowngradeCalls": [] if preserved_context else downgraded_audits,
          "contextInheritedCalls": downgraded_audits if preserved_context else [], "pendingPaths": sorted(pending_paths),
          "persistedScope": scope_validation}])
    marker = "EXECUTION STARTED — generation=" + str(generation)
    marker_count = sum(line.endswith(marker) for line in log_text.splitlines())
    first_edit = min((x["startedAt"] for x in source_edits if x["startedAt"]), default=None)
    started = implementation[0]["completedAt"] if implementation else None
    checks["executionStart"] = check("pass" if marker_count == 1 and started and first_edit and started < first_edit else "fail" if first_edit else missing,
        "One generation marker and a successful native start must precede the first observed source-edit tool.",
        [{"markerCount": marker_count, "helperCompletedAt": started, "firstObservedSourceEditAt": first_edit,
          "limitation": "Shell-based source mutations are not inferred from arbitrary command text."}])
    contradictory = []
    for line in progress_text.splitlines():
        if not re.match(r"^- \[ \] ", line) or re.search(r"blocked|cancelled|skipped", line, re.I):
            continue
        label = line[6:]
        if (state.get("implComplete") and re.match(r"Phase\s*6\b", label, re.I)) or (state_closed and re.match(r"(?:Review chain|Chain clos|Terminal self.review|Self.review|Workflow chain|Code review|Implementation audit)", label, re.I)):
            contradictory.append(label[:180])
    managed = ["[x] Implementation audit accepted", "[x] Code review converged", "[x] Workflow chain closed"]
    managed_start = "<!-- zensu:workflow-status -->"
    managed_end = "<!-- /zensu:workflow-status -->"
    blocks = re.findall(re.escape(managed_start) + r"(.*?)" + re.escape(managed_end), progress_text, re.S)
    managed_valid = len(blocks) == 1 and progress_text.count(managed_start) == 1 and progress_text.count(managed_end) == 1 and all(x in blocks[0] for x in managed)
    if managed_valid and state.get("reviewGeneration"):
        managed_valid = f"Workflow generation: {state['reviewGeneration']}. Observed revision: {state.get('revision')}." in blocks[0]
    checks["progress"] = check("pass" if state_closed and progress_text and not contradictory and managed_valid else "fail" if contradictory else missing,
        "Both managed native status and original stage rows must agree; a managed checkbox alone is insufficient.", contradictory)
    valid_tasks = [t for t in tasks if t["nativeSuccess"] and t["mode"] == "sync" and t["workerStarted"] and t["workerCompleted"] and t["substantive"]]
    groups = collections.defaultdict(list)
    for task in tasks:
        # A pre-tool denial is friction, not an executed reviewer with a bad
        # packet. Keep it in nativeTasks without letting it satisfy the chain.
        if not task["workerStarted"]:
            continue
        groups[task["packet"].get("packetHash", "missing")].append(task)
    group_checks = []
    for index, (digest, group) in enumerate(sorted(groups.items(), key=lambda pair: min(t["startedAt"] or "" for t in pair[1]))):
        completed = [t for t in group if t in valid_tasks]
        roles = {t["role"] for t in completed}; aspects = {t["aspect"] for t in completed if t["role"] == "aspect"}
        all_rows = [t["packet"] for t in group] + [c["packet"] for c in captures if c["packet"].get("packetHash") == digest]
        injected = [p for p in all_rows if p.get("injected")]
        same_bytes = bool(injected) and all(p.get("valid") for p in all_rows) and len({p.get("injectionBytesSha256") for p in injected}) == 1
        consume = [t for t in completed if t["role"] == "consume"]
        judges = [t for t in completed if t["role"] in ("primary", "secondary")]
        order = bool(consume) and any(t["role"] == "primary" and t["completedAt"] < consume[0]["startedAt"] for t in judges)
        if index == 0:
            order &= any(t["role"] == "secondary" and t["completedAt"] < consume[0]["startedAt"] for t in judges) if consume else False
        aspect_end = max((t["completedAt"] for t in completed if t["role"] == "aspect"), default=None)
        aspects_before_judges = bool(aspect_end and judges and all(aspect_end < t["startedAt"] for t in judges)) if index == 0 else True
        group_checks.append({"packetHash": digest, "completeAspects": sorted(x for x in aspects if x),
                             "completedRoles": sorted(roles), "identicalInjectedBytes": same_bytes,
                             "judgesCompletedBeforeConsume": bool(order), "aspectsCompletedBeforeJudges": aspects_before_judges,
                             "firstFullPanel": aspects == ASPECTS if index == 0 else None})
    panel = bool(group_checks) and group_checks[0]["firstFullPanel"] and all(g["judgesCompletedBeforeConsume"] and g["aspectsCompletedBeforeJudges"] for g in group_checks)
    checks["nativeReviewChain"] = check("pass" if panel else missing, "Requires completed native worker results, the first five-aspect panel, both first judges and primary-before-consume ordering.", group_checks)
    checks["canonicalPackets"] = check("pass" if group_checks and all(g["identicalInjectedBytes"] for g in group_checks) else "fail" if group_checks else missing,
        "Every reference is rehashed; native injected bytes must be identical within each packet generation.", group_checks)
    self_loads = [s for s in skill_loads if str(s["skill"]).removeprefix("zensu:").removeprefix("zensu-") == "self-review"]
    explicit_self_invocations = [s for s in self_loads if s.get("method") != "native-view"]
    review_done = [x for x in milestones if x["operation"] == "--code-review-done" and x["successful"]]
    valid_self = bool(close and review_done and any(review_done[-1]["completedAt"] <= s["startedAt"] < close["startedAt"] for s in self_loads))
    after_close = [s["callId"] for s in self_loads if close and s["startedAt"] > close["completedAt"]]
    after_close_work = [x["callId"] for x in source_edits + tasks if close and x.get("startedAt") and x["startedAt"] > close["completedAt"]]
    after_close_work += [x["callId"] for x in milestones if close and x["operation"] == "--self-review-fixed" and x["successful"] and x["startedAt"] > close["completedAt"]]
    report_only = any(x["operation"] == "--chain-report" and x["successful"] and close and x["startedAt"] > close["completedAt"]
        and re.search(r'"status"\s*:\s*"closed"', x["text"]) and re.search(r'"nextAction"\s*:\s*"render-report-only"', x["text"]) for x in milestones)
    checks["terminalSelfReview"] = check("fail" if after_close_work or len(explicit_self_invocations) > 1 else "pass" if valid_self and (not after_close or report_only) else "unassessed" if after_close else missing,
        "Native self-review loads after convergence and before closure. Repeated explicit skill invocations fail. Bounded native file reads are not themselves extra invocations. A later entry read requires a closed report-only response and no further work.",
        [{"reads": self_loads, "explicitSkillInvocations": len(explicit_self_invocations), "postCloseEntryReads": after_close, "postCloseWork": after_close_work, "closedReportOnlyObserved": report_only}])
    consume_texts = [t["text"] for t in valid_tasks if t["role"] == "consume"]
    directives = [t["callId"] for t in valid_tasks if t["role"] == "consume" and re.search(r"^(?:#+\s*|[-*]\s*)?(?:Directive|Next Action)\s*:|Fix round required", t["text"].split('Tool "task" succeeded.')[0], re.M | re.I)]
    route_observed = any("Classify its findings by severity" in text or "post-review" in text and "self-review" in text for text in consume_texts)
    # Some CLI versions keep appended guidance only in post-hook capture, not the task result.
    checks["reviewRouting"] = check("fail" if directives else "pass" if consume_texts and route_observed else "unassessed" if consume_texts else missing,
        "Quality verdict must not invent a routing directive. Missing captured hook guidance requires manual assessment.", directives)
    records = []
    for item in milestones:
        if item["operation"] == "--acceptance-record" and item["successful"]:
            matches = re.findall(r"\b(AC-\d+)\s+pass\b", item["text"])
            reference = re.search(r"er1_[A-Za-z0-9_]+", item["text"])
            for ac in matches:
                records.append({"ac": ac, "callId": item["callId"], "record": reference.group(0) if reference else None})
    statuses = [x for x in milestones if x["operation"] == "--acceptance-status"]
    last_edit = max((x["startedAt"] for x in source_edits if x["startedAt"]), default=None)
    evidence_references = {call: set(re.findall(r"\b(?:er1|av1)_[0-9]{13}_[0-9a-f]{12}\b", result_text(ends.get(call, {}))))
        for call, event in starts.items() if event.get("data", {}).get("toolName") == "bash"
        and helper_arguments(arguments(event.get("data", {}).get("arguments")).get("command", ""), "zensu-log.sh")}
    checks["nativeEvidenceRecords"] = native_evidence(reader, session, key, state, landing, evidence_references, missing)
    acceptance_current = acceptance_is_current(statuses[-1] if statuses else None, last_edit, checks["nativeEvidenceRecords"])
    checks["acceptance"] = check("pass" if acceptance_current and {x["ac"] for x in records} >= {"AC-001", "AC-002", "AC-003", "AC-004"} else missing,
        "Four observed per-criterion records and a successful 4/4 status require either status-after-edit ordering or independently validated current-tree native records. Stale/failing status output is never overridden.", records)
    independent = reader.obj("independent-check.json", optional=True)
    independent_ok = False
    independent_comparison = None
    if independent:
        original = [c for c in independent.get("checks", []) if c.get("scope") == "original-invoice-acceptance"]
        hashes = independent.get("testedHashes", {})
        try:
            installed_root = reader.relative(independent["entry"]).parent
            source_matches = set(hashes) == {"index.js", "cli.js"} and all(
                sha(reader.read("project/src/" + name)) == row.get("source") == row.get("installed")
                == sha(reader.read(installed_root / name)) and row.get("equal") is True
                for name, row in hashes.items())
            tarball_matches = sha(reader.read(independent["packageTarball"])) == independent.get("packageTarballSha256")
        except (OSError, ValueError):
            source_matches = False
            tarball_matches = False
        except (KeyError, TypeError):
            source_matches = False
            tarball_matches = False
        independent_ok = len(original) == 14 and {c.get("name") for c in original} == ORIGINAL_CHECKS and all(c.get("status") == "pass" for c in original) and source_matches and tarball_matches and len(independent.get("packagedInstallCommands", [])) == 2 and all(c.get("exitCode") == 0 for c in independent["packagedInstallCommands"])
        independent_comparison = independent.get("priorImplementationComparison")
    checks["independentConsumer"] = check("pass" if independent_ok else "fail" if independent else missing,
        "Original acceptance assertions, offline packaged installation and final source/installed digest equality; prior one-MiB comparisons are separate.")
    checks["eventCompleteness"] = check("pass" if malformed == 0 else missing, "Invalid/trailing JSONL records prevent a complete final assertion.", [{"unparsedLines": malformed}])
    checks["processExit"] = check("pass" if exit_record and exit_record.get("exitCode") == 0 else "fail" if exit_record else "pending", "A clean process exit is necessary but never sufficient for workflow success.")
    findings = {}
    def finding(identifier, result, note):
        findings[identifier] = {"status": result["status"], "reason": note, "evidence": result.get("evidence", [])}
    finding("WF-001", check("fail" if binding_errors else "unassessed" if copied_bindings else "pass" if starts else missing, "", binding_errors + copied_bindings), "Only actual malformed-binding errors fail. Pre-hook repeated prefixes are observable replay candidates, but can be a host retry echo and do not establish model authorship. Injected execution_start prefixes are expected.")
    finding("WF-002", checks["canonicalPackets"], "Canonical packet use is observed; untracked/unborn/mid-commit edge cases remain deterministic-test coverage.")
    finding("WF-003", checks["editLandingContext"] if downgraded_audits else check("unassessed" if "EDIT NOT LANDED" in log_text else "unexercised", ""), "Unlanded-edit recovery is not proven by an ordinary run; dropping pending dirty-before context is a related audit-evidence failure.")
    finding("WF-004", check("fail" if external_imports else "pass" if tasks else missing, "", external_imports), "Observed reviewers use native tasks; unsupported external import branches were not exercised.")
    finding("WF-005", check("fail" if oversized else "pass" if starts else missing, "", oversized), "Actual native oversized-read responses, including audit references, are counted even if later recovered.")
    finding("WF-006", check("unassessed" if any(not a["successful"] for a in acceptance_runs) else "unexercised", ""), "Failure-diagnostic quality needs a failing synthetic assertion; green checks alone do not demonstrate it.")
    start_progress = checks["executionStart"] if checks["executionStart"]["status"] != "pass" else checks["progress"]
    finding("WF-007", start_progress, "Native start ordering and all completed-stage progress rows must agree.")
    finding("WF-008", checks["canonicalPackets"], "Exact injected payload hashes and byte hashes are compared within each review packet.")
    finding("WF-009", checks["nativeReviewChain"], "Successful additive review never substitutes for substantive primary completion.")
    verifier_good = verifier_runs and all(v["successful"] and v["jsonInput"] and not v["degraded"] and v["total"] == v["inputFindingCount"] and v["total"] is not None for v in verifier_runs)
    verifier_bad = any(not v["successful"] or not v["jsonInput"] or v["degraded"] or v["inputFindingCount"] is not None and v["total"] != v["inputFindingCount"] for v in verifier_runs)
    finding("WF-010", check("pass" if verifier_good else "fail" if verifier_bad else "unassessed" if verifier_runs else "unexercised", "", verifier_runs), "Structured input and exact summary/input counts are required; unresolved shell variables or absent finding files stay unassessed. Delimiter-injection negative cases remain deterministic coverage.")
    finding("WF-011", checks["reviewRouting"], "Quality reporting and the authoritative post-hook routing must remain distinct.")
    shared = collections.Counter(x["record"] for x in records if x["record"])
    finding("WF-012", check("pass" if any(n > 1 for n in shared.values()) else "unassessed" if records else missing, "", records), "A reused acceptance record with separate AC observations demonstrates sharing; distinct records alone do not prove redundant commands.")
    finding("WF-013", checks["terminalSelfReview"], "Bound closure and final reporting must not restart the terminal skill.")
    for task in tasks:
        task.pop("text", None)
    for milestone in milestones:
        milestone.pop("text", None)
    required = [value["status"] for value in checks.values()]
    overall = "failed" if "fail" in required or any(f["status"] == "fail" for f in findings.values()) else "passed" if required and all(x == "pass" for x in required) else "incomplete"
    if interruption and exit_record and exit_record.get("exitCode") != 0:
        overall = "interrupted"
    return {"schema": "zensu.native-workflow-final-analysis.v1", "runDirectory": str(reader.root), "sessionId": session,
            "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "status": overall,
            "nativeResultIsFinal": bool(exit_record), "baselineCommit": harness.get("baselineCommit"),
            "controllerInterruption": interruption,
            "frozenBuildSha256": frozen.get("buildSha256") if frozen else None,
            "eventSources": event_sources, "checks": checks, "originalFindings": findings,
            "nativeTasks": tasks, "milestones": milestones, "acceptanceRuns": acceptance_runs,
            "integrity": integrity, "priorImplementationComparison": independent_comparison,
            "state": {k: state.get(k) for k in ("revision", "reviewGeneration", "implComplete", "codeReviewDone", "chainDone", "reviewTicketConsumed", "reviewRound", "selfReviewFixed")},
            "limits": ["No model, workflow helper, shell interpreter, state transition or ambient credential/configuration read is performed; bounded read-only Git inventory commands are permitted for the named invoice project.",
                       "Source-only and negative branches can remain unexercised; this report never upgrades fixtures to live evidence.",
                       "A superseded run remains its own result; multiple runs never share completion proof."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", action="append", required=True)
    parser.add_argument("--session-id", action="append", required=True)
    args = parser.parse_args()
    if len(args.run_dir) != len(args.session_id):
        parser.error("repeat --run-dir and --session-id in matching order")
    reports = []
    for directory, session in zip(args.run_dir, args.session_id):
        try:
            reports.append(analyze(directory, session))
        except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
            reports.append({"runDirectory": str(Path(directory).absolute()), "sessionId": session,
                            "status": "invalid-evidence", "errorClass": type(error).__name__,
                            "reason": "Identity, path safety, schema or bounded-read validation failed; no success is inferred."})
    print(json.dumps({"schema": "zensu.native-workflow-multi-run-analysis.v1", "runs": reports}, indent=2))
    return 0 if all(r["status"] == "passed" for r in reports) else 1 if any(r["status"] in ("failed", "invalid-evidence") for r in reports) else 2


if __name__ == "__main__":
    raise SystemExit(main())
