#!/usr/bin/env python3
"""Prepare, freeze, or explicitly run the disposable native invoice workflow.

Preparation never launches a model. Freeze only after the repository's build and
checks finish. The installed marketplace plugin and user settings remain intact.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import uuid


BASELINE = "1f1d96a026b1f63f716518f185e4cb2119c94c10"
DEFAULT_BASELINE_REPO = "/private/tmp/zensu-workflow-live-z3lbjucv/project"
REPORT_PATH = "validation/copilot-workflow-fixes-2026-10-19"
DOCS = "https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/plugin-directories"


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def read_json(path):
    return json.loads(path.read_text())


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def inventory(root):
    if not root.exists():
        return None
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Refusing a symbolic link in plugin payload: {path}")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    return result


def global_state():
    home = Path.home()
    copilot_home = Path(os.environ.get("COPILOT_HOME", home / ".copilot"))
    files = [home / ".zensu/config.json"] + [
        copilot_home / name
        for name in ("settings.json", "permissions-config.json", "mcp-config.json")
    ]
    return {
        "files": {str(p): digest(p.read_bytes()) if p.is_file() else None for p in files},
        "marketplacePlugin": inventory(copilot_home / "installed-plugins/zensu/zensu"),
    }


def run_env(root):
    env = dict(os.environ)
    # Copilot's shell path preflight also reads PWD. Popen(cwd=...) does not
    # update the inherited value, which can otherwise name the launch checkout.
    env["PWD"] = str((root / "project").resolve())
    # Official process-scoped isolation; no persisted enable/disable operation.
    env["COPILOT_PLUGIN_DIR_ONLY"] = "true"
    env["COPILOT_AUTO_UPDATE"] = "false"
    env["ZENSU_COPILOT_CAPTURE_DIR"] = str(root / "hooks")
    return env


class RunInterrupted(Exception):
    def __init__(self, signum):
        self.signum = signum


def stop_owned_process(process, signum):
    """Stop only the new process group created for this disposable run."""
    def send(value):
        try:
            os.killpg(process.pid, value)
            return True
        except ProcessLookupError:
            return False

    send(signum)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    # The CLI can exit before a tool child. Finish the owned group as well.
    if send(signal.SIGTERM):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and send(0):
            time.sleep(0.05)
        if send(0):
            send(signal.SIGKILL)
    return process.wait(timeout=5)


def checked_root(value):
    root = Path(value).resolve()
    if not (root / "harness.json").is_file():
        raise ValueError("--run-dir must name a directory prepared by this harness")
    metadata = read_json(root / "harness.json")
    if metadata.get("schema") != "zensu.copilot-workflow-retest-harness.v1":
        raise ValueError("Unknown harness metadata")
    if metadata.get("runDirectory") != str(root):
        raise ValueError("Harness directory has moved; prepare a fresh run")
    return root, metadata


def prepare(repo, baseline_repo, run_dir):
    if run_dir:
        root = Path(run_dir).resolve()
        root.mkdir(parents=False, exist_ok=False)
    else:
        root = Path(tempfile.mkdtemp(prefix="zensu-copilot-workflow-retest-", dir="/private/tmp"))
    project = root / "project"
    project.mkdir()
    files = git(baseline_repo, "ls-tree", "-rz", "--name-only", BASELINE).decode().split("\0")
    for name in filter(None, files):
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"Unsafe baseline path: {name}")
        target = project / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git(baseline_repo, "show", f"{BASELINE}:{name}"))
    # Keep the exact original project baseline. Only the invocation authorizes
    # installing this project's own tarball in a disposable package consumer.
    for args in (
        ["init", "-q"], ["config", "user.name", "Zensu Live Validation"],
        ["config", "user.email", "live-validation@example.invalid"],
        ["add", "."], ["commit", "-qm", "test: seed invoice workflow baseline"],
    ):
        subprocess.run(["git", "-C", str(project), *args], check=True)
    original_tree = git(baseline_repo, "rev-parse", f"{BASELINE}^{{tree}}").decode().strip()
    actual_tree = git(project, "rev-parse", "HEAD^{tree}").decode().strip()
    if original_tree != actual_tree:
        raise ValueError("Prepared project differs from the original baseline tree")
    prompt = (repo / REPORT_PATH / "invoice-retest-prompt.txt").read_text()
    (root / "prompt.txt").write_text(prompt)
    for name in ("independent-check.mjs", "validate-independent.py"):
        shutil.copyfile(repo / REPORT_PATH / name, root / name)
    save(root / "harness.json", {
        "schema": "zensu.copilot-workflow-retest-harness.v1", "createdAt": now(),
        "runDirectory": str(root), "repository": str(repo),
        "baselineRepository": str(baseline_repo), "baselineCommit": BASELINE,
        "baselineTree": original_tree, "projectBaseline": git(project, "rev-parse", "HEAD").decode().strip(),
        "sessionId": str(uuid.uuid4()), "status": "prepared-model-not-started",
        "launchDocumentation": DOCS,
    })
    print(json.dumps({"runDirectory": str(root), "status": "prepared-model-not-started"}))


def verify_distribution(repo, distribution):
    build = read_json(distribution / "build.json")
    expected = {"build.json"}
    for row in build["files"]:
        target = Path(row["target"])
        source = Path(row["source"])
        if any(p.is_absolute() or ".." in p.parts for p in (target, source)):
            raise ValueError("Unsafe build inventory path")
        expected.add(target.as_posix())
        if digest((distribution / target).read_bytes()) != row["sha256"]:
            raise ValueError(f"Distribution hash mismatch: {target}")
        if digest((repo / source).read_bytes()) != row["sha256"]:
            raise ValueError(f"Build is stale relative to source: {source}")
    if set(inventory(distribution)) != expected:
        raise ValueError("Distribution has missing or extra files")
    return build


def freeze(root, metadata):
    if (root / "frozen-plugin.json").exists():
        raise ValueError("A frozen plugin already exists; prepare a fresh run for another build")
    repo = Path(metadata["repository"])
    distribution = repo / "dist/zensu"
    build = verify_distribution(repo, distribution)
    plugin = root / "plugin/zensu"
    shutil.copytree(distribution, plugin, symlinks=False)
    verify_distribution(repo, plugin)
    hashes = inventory(plugin)
    for path in sorted(plugin.rglob("*"), reverse=True):
        path.chmod(0o555 if path.is_dir() or path.stat().st_mode & 0o111 else 0o444)
    plugin.chmod(0o555)
    save(root / "frozen-plugin.json", {
        "root": str(plugin), "frozenAt": now(), "version": build["version"],
        "repositoryHead": git(repo, "rev-parse", "HEAD").decode().strip(),
        "repositoryStatus": git(repo, "status", "--short").decode().splitlines(),
        "buildSha256": hashes["build.json"], "files": hashes,
    })
    save(root / "global-before.json", global_state())
    command = [
        shutil.which("copilot") or "copilot", "-C", str(root / "project"),
        "--plugin-dir", str(plugin), "--no-auto-update", "plugin", "list", "--json",
    ]
    completed = subprocess.run(command, cwd=root / "project", env=run_env(root), text=True, capture_output=True)
    save(root / "plugin-list-command.json", command)
    (root / "plugin-list.stdout.json").write_text(completed.stdout)
    (root / "plugin-list.stderr.txt").write_text(completed.stderr)
    if completed.returncode != 0:
        raise ValueError("Native plugin listing failed; inspect plugin-list.stderr.txt")
    rows = json.loads(completed.stdout)
    enabled = [p for p in rows if p.get("enabled")]
    if len(enabled) != 1 or enabled[0].get("name") != "zensu" or enabled[0].get("source") != "external":
        raise ValueError("Native plugin listing did not resolve exclusively to external Zensu")
    if global_state() != read_json(root / "global-before.json"):
        raise ValueError("Native plugin preflight changed monitored global state")
    metadata["status"] = "frozen-preflight-passed-model-not-started"
    save(root / "harness.json", metadata)
    print(json.dumps({"runDirectory": str(root), "status": metadata["status"], "pluginFiles": len(hashes)}))


def execute(root, metadata):
    if metadata.get("status") != "frozen-preflight-passed-model-not-started":
        raise ValueError("Run requires a frozen, preflight-verified, never-started harness")
    frozen = read_json(root / "frozen-plugin.json")
    if inventory(Path(frozen["root"])) != frozen["files"]:
        raise ValueError("Frozen plugin changed before launch")
    if (root / "process.json").exists():
        raise ValueError("This run has already launched; never reuse a completed session as a fresh run")
    command = [
        shutil.which("copilot") or "copilot", "-C", str(root / "project"),
        "--session-id", metadata["sessionId"], "--name", "Zensu invoice workflow fixes retest",
        "--plugin-dir", frozen["root"], "--add-dir", frozen["root"],
        "--output-format", "json", "--no-auto-update", "--no-remote", "--no-remote-export",
        "--no-ask-user", "--disable-builtin-mcps", "--allow-all-tools",
        "--log-level", "debug", "--log-dir", str(root / "logs"),
        "-p", (root / "prompt.txt").read_text(),
    ]
    save(root / "command.json", command)
    save(root / "environment-overrides.json", {
        key: run_env(root)[key]
        for key in ("PWD", "COPILOT_PLUGIN_DIR_ONLY", "COPILOT_AUTO_UPDATE", "ZENSU_COPILOT_CAPTURE_DIR")
    })
    started = time.monotonic()
    interrupted = None
    process = None
    code = None
    previous_handlers = {}

    def interrupt(signum, _frame):
        raise RunInterrupted(signum)

    with (root / "output.jsonl").open("x") as output, (root / "stderr.txt").open("x") as errors:
        try:
            for signum in (signal.SIGINT, signal.SIGTERM):
                previous_handlers[signum] = signal.signal(signum, interrupt)
            process = subprocess.Popen(command, cwd=root / "project", env=run_env(root),
                                       stdout=output, stderr=errors, start_new_session=True)
            save(root / "process.json", {"pid": process.pid, "processGroup": process.pid,
                 "sessionId": metadata["sessionId"], "startedAt": now()})
            metadata["status"] = "running"
            save(root / "harness.json", metadata)
            print(json.dumps({"pid": process.pid, "sessionId": metadata["sessionId"], "runDirectory": str(root)}), flush=True)
            code = process.wait()
        except RunInterrupted as error:
            interrupted = error.signum
        finally:
            # A second interrupt must not orphan the CLI during bounded teardown.
            for signum in previous_handlers:
                signal.signal(signum, signal.SIG_IGN)
            try:
                if process is not None:
                    if interrupted is not None or process.poll() is None:
                        code = stop_owned_process(process, interrupted or signal.SIGTERM)
                    else:
                        code = process.returncode
                save(root / "exit.json", {"exitCode": code, "interruptedBySignal": interrupted,
                     "elapsedSeconds": round(time.monotonic() - started, 2), "finishedAt": now()})
                metadata["status"] = "process-exited-awaiting-workflow-validation" if process is not None else "launch-failed"
                save(root / "harness.json", metadata)
                after = global_state()
                save(root / "global-after.json", after)
                save(root / "integrity-after.json", {
                    "frozenPluginUnchanged": inventory(Path(frozen["root"])) == frozen["files"],
                    "globalAndMarketplaceUnchanged": after == read_json(root / "global-before.json"),
                })
            finally:
                for signum, handler in previous_handlers.items():
                    signal.signal(signum, handler)
    print(json.dumps({"exitCode": code, "runDirectory": str(root)}), flush=True)
    # Process completion is not workflow success. Inspect native evidence separately.
    return 128 + interrupted if interrupted is not None else code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "freeze", "run"))
    parser.add_argument("--run-dir")
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--baseline-repo", default=DEFAULT_BASELINE_REPO)
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(Path(args.repo).resolve(), Path(args.baseline_repo).resolve(), args.run_dir)
        return 0
    if not args.run_dir:
        parser.error("--run-dir is required for freeze and run")
    root, metadata = checked_root(args.run_dir)
    if args.action == "freeze":
        freeze(root, metadata)
        return 0
    return execute(root, metadata)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f"live workflow harness: {error}")
