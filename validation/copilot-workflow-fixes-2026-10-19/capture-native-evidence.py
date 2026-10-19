#!/usr/bin/env python3
"""Copy only exact completed-run native evidence references into its own run.

This controller never invokes a model/helper or mutates native state. Its only
external reads are regular evidence files under the Copilot plugin-data path
recorded by this main session, and the exact domain-separated session directory.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys


REPOSITORY = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("native_analyzer", REPOSITORY / "scripts/analyze-native-workflow.py")
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)
IDENTIFIER = re.compile(r"\b(?:er1|av1)_[0-9]{13}_[0-9a-f]{12}\b")


def external_read(path, maximum):
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("linked external evidence refused")
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
        raise ValueError("unsupported external evidence file")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as source:
        opened = os.fstat(source.fileno())
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("external evidence changed while opening")
        data = source.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError("external evidence exceeded bound")
    return data


def preserve(destination, value):
    current = Path(destination.anchor)
    for part in destination.parts[1:-1]:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            current.mkdir()
            info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ValueError("capture ancestor is not a regular directory")
    if destination.is_symlink() or destination.exists() and destination.stat().st_nlink != 1:
        raise ValueError("linked capture target refused")
    if destination.exists() and destination.read_bytes() != value:
        raise ValueError("refusing to replace a different prior capture")
    if not destination.exists():
        with destination.open("xb") as target:
            target.write(value)


def capture(directory, session):
    reader = analyzer.RunReader(directory)
    harness = reader.obj("harness.json")
    if harness.get("sessionId") != session or harness.get("runDirectory") != str(reader.root):
        raise ValueError("exact run/session required")
    if not reader.obj("exit.json", optional=True):
        raise ValueError("capture is permitted only after the owned process exits")
    key = "scv1_" + analyzer.sha(b"zensu.session-control/v1/session-id\0" + session.encode())
    state = reader.obj("project/.zensu/state/tdd-phase-" + key + ".json")
    if state.get("session_id_hash") != "sha256:" + key[5:]:
        raise ValueError("foreign native state")
    roots = set()
    for path in reader.files("hooks", "*.json"):
        value = reader.obj(path)
        if value.get("payload", {}).get("sessionId") == session:
            root = value.get("environment", {}).get("pluginData")
            if root:
                roots.add(root)
    if len(roots) != 1:
        raise ValueError("exactly one captured native plugin-data root is required")
    plugin_data = Path(roots.pop())
    allowed = Path.home() / ".copilot/plugin-data"
    if not plugin_data.is_absolute() or ".." in plugin_data.parts or not plugin_data.is_relative_to(allowed):
        raise ValueError("captured path is not Copilot plugin data")
    starts, completions = {}, []
    for path in sorted(set(reader.files(".", "output*.jsonl") + reader.files(".", "events*.jsonl"))):
        for raw in reader.read(path).splitlines():
            event = json.loads(raw)
            if event.get("agentId") or event.get("data", {}).get("ownerAgentId"):
                continue
            data = event.get("data", {})
            if event.get("type") == "tool.execution_start":
                command = analyzer.arguments(data.get("arguments")).get("command", "")
                if data.get("toolName") == "bash" and analyzer.helper_arguments(command, "zensu-log.sh"):
                    starts[data.get("toolCallId")] = event
            if event.get("type") == "tool.execution_complete":
                completions.append(event)
    references = {}
    for event in completions:
        call = event.get("data", {}).get("toolCallId")
        if call not in starts:
            continue
        for identifier in set(IDENTIFIER.findall(analyzer.result_text(event))):
            references.setdefault(identifier, set()).add(call)
    if not references:
        raise ValueError("no native helper evidence references were captured")
    rows, absent = [], []
    for identifier, calls in sorted(references.items()):
        store = "evidence-run" if identifier.startswith("er1_") else "acceptance-verify"
        source = plugin_data / store / "v1/records" / key / (identifier + ".json")
        try:
            data = external_read(source, 256 * 1024)
        except FileNotFoundError:
            absent.append({"id": identifier, "source": str(source), "callIds": sorted(calls)})
            continue
        value = json.loads(data)
        if value.get("id") != identifier or value.get("session_key") != key or value.get("project_root") != str(reader.root / "project"):
            raise ValueError("foreign native evidence record")
        target = Path("evidence-capture") / store / (identifier + ".json")
        preserve(reader.root / target, data)
        rows.append({"id": identifier, "kind": "record", "source": str(source), "capture": str(target),
            "sha256": analyzer.sha(data), "bytes": len(data), "callIds": sorted(calls)})
        if store == "evidence-run" and value.get("scope") in {"full", "acceptance"}:
            source = plugin_data / store / "v1/logs" / key / (identifier + ".log")
            log = external_read(source, 6 * 1024 * 1024)
            target = Path("evidence-capture") / store / (identifier + ".log")
            preserve(reader.root / target, log)
            rows.append({"id": identifier, "kind": "log", "source": str(source), "capture": str(target),
                "sha256": analyzer.sha(log), "bytes": len(log), "callIds": sorted(calls)})
    report = {"schema": "zensu.native-evidence-capture.v1", "runDirectory": str(reader.root), "sessionId": session,
        "sessionKey": key, "pluginData": str(plugin_data), "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "boundary": "Only exact main-session helper references, own domain-separated record paths and full/acceptance logs; no unrelated session listing, native-state write or model invocation.",
        "files": rows, "missingReferences": absent}
    previous = reader.obj("evidence-capture/manifest.json", optional=True)
    if previous:
        report["capturedAt"] = previous.get("capturedAt")
    preserve(reader.root / "evidence-capture/manifest.json", (json.dumps(report, indent=2) + "\n").encode())
    return {"runDirectory": str(reader.root), "sessionId": session, "capturedFiles": len(rows), "missingReferences": len(absent)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--session-id", required=True)
    args = parser.parse_args()
    print(json.dumps(capture(args.run_dir, args.session_id), indent=2))
