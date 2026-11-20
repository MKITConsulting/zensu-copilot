import datetime
import getpass
import glob
import hashlib
import json
import os
import re
import sys

PROBE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
USER = getpass.getuser()
KEEP = {
    "session.start", "session.auto_mode_resolved", "user.message", "assistant.message",
    "tool.execution_start", "tool.execution_complete", "hook.start", "hook.end",
    "permission.requested", "permission.completed", "session.error", "session.end",
    "assistant.turn_start", "assistant.turn_end", "session.shutdown",
}
TOKEN = re.compile(r"(gh[opsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})")
CALL = re.compile(r"(call|toolu|tooluse)_[A-Za-z0-9_\-]+")
PATHS = re.compile(r"/[^\s\"]+")
ROOTS = (os.path.realpath(PROBE), PROBE)


def truncated_probe_path(match):
    text = match.group(0)
    stem = text.rstrip("…")
    if len(stem) >= 10 and any(root.startswith(stem) or stem.startswith(root) for root in ROOTS):
        return "<probe-path>"
    return text
DROP = {"sessionId", "interactionId", "messageId", "originatingMessageId", "hookInvocationId", "toolCallId", "id", "turnId"}


def redact(value):
    if isinstance(value, str):
        for prefix in ROOTS:
            value = value.replace(prefix, "<probe>")
        value = PATHS.sub(truncated_probe_path, value).replace(HOME, "~")
        value = re.sub(re.escape(USER), "<user>", value, flags=re.IGNORECASE)
        return TOKEN.sub("<token>", value)
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {("<toolCallId>" if CALL.fullmatch(k) else k): redact(v) for k, v in value.items() if k not in DROP}
    return value


def epoch(stamp):
    return datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def iso(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


def hook_log(run_dir):
    rows = []
    path = os.path.join(run_dir, "hooklog", "events.log")
    if not os.path.exists(path):
        return rows
    for line in read(path).splitlines():
        parts = line.split()
        row = {"at": iso(float(parts[0]))}
        for part in parts[1:]:
            key, _, value = part.partition("=")
            if key in {"pid", "ppid", "pgid", "sleeper_pid"}:
                continue
            row[key] = iso(float(value)) if key == "stdin_read_at" else value
        rows.append(row)
    return rows


def slim(event):
    data = event.get("data", {})
    kind = event["type"]
    out = {"at": event.get("timestamp"), "type": kind}
    if kind == "session.start":
        out.update({"copilotVersion": data.get("copilotVersion"), "selectedModel": data.get("selectedModel")})
    elif kind == "session.auto_mode_resolved":
        out.update({"chosenModel": data.get("chosenModel"), "availableModels": data.get("availableModels")})
    elif kind == "user.message":
        out["content"] = data.get("content")
    elif kind == "assistant.message":
        out.update({"model": data.get("model"), "content": data.get("content"),
                    "toolRequests": [{"name": r.get("name"), "command": (r.get("arguments") or {}).get("command")} for r in data.get("toolRequests") or []]})
    elif kind in {"tool.execution_start", "tool.execution_complete"}:
        out.update({k: data[k] for k in ("toolName", "success", "result", "error") if k in data})
        if "arguments" in data:
            out["command"] = (data.get("arguments") or {}).get("command")
    elif kind in {"hook.start", "hook.end"}:
        out.update({k: v for k, v in data.items() if k != "input"})
    elif kind == "session.shutdown":
        snapshot = data.get("accountingSnapshot") or {}
        out.update({"totalPremiumRequestCost": snapshot.get("totalPremiumRequestCost"),
                    "modelRequests": {m: (v.get("requests") or {}).get("count") for m, v in (snapshot.get("modelMetrics") or {}).items()}})
    elif kind in {"assistant.turn_start", "assistant.turn_end"}:
        pass
    else:
        out["data"] = data
    return redact(out)


def raw_entry(path):
    data = open(path, "rb").read()
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
            "tokenPatternFound": bool(TOKEN.search(data.decode("utf-8", "replace")))}


def summarize(run):
    run_dir = os.path.join(PROBE, f"run-{run}")
    files = glob.glob(os.path.join(run_dir, "home", "session-state", "*", "events.jsonl"))
    native = [slim(json.loads(line)) for line in read(files[0]).splitlines() if json.loads(line).get("type") in KEEP] if len(files) == 1 else []
    hook = hook_log(run_dir)
    pick = lambda kind: [e for e in native if e["type"] == kind]
    start, end = pick("hook.start"), pick("hook.end")
    tool_start, tool_end = pick("tool.execution_start"), pick("tool.execution_complete")
    version = next((e["copilotVersion"] for e in native if e["type"] == "session.start"), None)
    model = next((e["chosenModel"] for e in native if e["type"] == "session.auto_mode_resolved"), None)
    derived = {}
    if start and end:
        derived["nativeHookStartToEndSeconds"] = round(epoch(end[0]["at"]) - epoch(start[0]["at"]), 3)
    if tool_start and tool_end:
        derived["nativeToolStartToCompleteSeconds"] = round(epoch(tool_end[0]["at"]) - epoch(tool_start[0]["at"]), 3)
    if end and tool_end:
        derived["nativeHookEndToToolCompleteSeconds"] = round(epoch(tool_end[0]["at"]) - epoch(end[0]["at"]), 3)
    target = [r for r in hook if r.get("event") == "sleeping"]
    if target:
        call = target[0]["call"]
        began = next(r["at"] for r in hook if r.get("call") == call and r.get("event") == "start")
        derived["hookProcessStartedAt"] = began
        for name in ("slept", "deny-written", "sigterm", "sighup", "sigint"):
            hit = [r for r in hook if r.get("call") == call and r.get("event") == name]
            if hit:
                derived["hookProcess" + name.title().replace("-", "") + "AfterSeconds"] = round(epoch(hit[0]["at"]) - epoch(began), 3)
    runner = []
    for line in read(os.path.join(run_dir, "runner.log")).splitlines():
        stamp, _, event = line.partition(" ")
        runner.append({"at": iso(float(stamp)), "event": redact(event)})
    raw = {}
    candidates = [("stdout.jsonl", os.path.join(run_dir, "stdout.jsonl")), ("hook-events.log", os.path.join(run_dir, "hooklog", "events.log"))]
    candidates += [("session-events.jsonl", f) for f in files]
    candidates += [(f"cli-debug-{i}.log", f) for i, f in enumerate(sorted(glob.glob(os.path.join(run_dir, "cli-logs", "process-*.log"))))]
    for label, path in candidates:
        if os.path.exists(path):
            raw[label] = raw_entry(path)
    before = read(os.path.join(run_dir, "global-before.txt"))
    after = read(os.path.join(run_dir, "global-after.txt"))
    leftovers = [p for p in ("ps-after-exit.txt", "ps-settled.txt") if os.path.exists(os.path.join(run_dir, p)) and read(os.path.join(run_dir, p)).strip()]
    return {
        "copilotCliVersion": version,
        "chosenModel": model,
        "hookConfig": redact(json.loads(read(os.path.join(run_dir, "repo", ".github", "hooks", "probe.json")))),
        "markerFile": "present" if os.path.exists(os.path.join(run_dir, "repo", f"probe-{run}-ran.txt")) else "absent",
        "derived": derived,
        "runner": runner,
        "hookProcess": hook,
        "native": native,
        "hookProcessesLeftAfterCopilotExit": "none" if not leftovers else "see local raw evidence",
        "globalCopilotState": {
            "checked": ["~/.copilot/config.json", "~/.copilot/settings.json", "~/.copilot/installed-plugins file hashes",
                        "~/.copilot/plugin-data file hashes", "~/.copilot/session-state entry count"],
            "unchanged": before == after,
        },
        "rawEvidenceRetainedLocally": raw,
    }


def attempts():
    found = []
    for path in sorted(glob.glob(os.path.join(PROBE, "attempt*-run-a-*"))):
        stderr = read(os.path.join(path, "stderr.txt")).strip()
        hooks = os.path.join(path, "hooklog", "events.log")
        found.append({"attempt": os.path.basename(path), "copilotCliVersion": read(os.path.join(path, "version.txt")).split()[3].rstrip("."),
                      "stderr": redact(stderr), "hookInvocations": len(read(hooks).splitlines()) if os.path.exists(hooks) else 0,
                      "sessionStateCreated": bool(glob.glob(os.path.join(path, "home", "session-state", "*", "events.jsonl")))})
    return found


json.dump({"setupAttempts": attempts(), "runs": {run: summarize(run) for run in sys.argv[1:]}}, sys.stdout, indent=2)
sys.stdout.write("\n")
