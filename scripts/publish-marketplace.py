#!/usr/bin/env python3
"""Publish a verified release as an atomic, SHA-pinned Copilot marketplace."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(file, data):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def version_tuple(version):
    require(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version),
            "Only stable semantic versions can be published")
    return tuple(map(int, version.split(".")))


def safe_path(name):
    path = PurePosixPath(name)
    require(name and not path.is_absolute() and ".." not in path.parts
            and ".git" not in path.parts and "\\" not in name,
            f"Unsafe package path: {name}")
    return path


def verify_release(assets, version, output):
    archive_name = f"zensu-copilot-{version}.tar.gz"
    expected = {archive_name, "build.json"}
    checksums = {}
    for line in (assets / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        require(match and match[2] in expected and match[2] not in checksums,
                "Unexpected or duplicate release checksum entry")
        checksums[match[2]] = match[1]
    require(set(checksums) == expected, "Missing release checksums")
    for name, checksum in checksums.items():
        require(digest((assets / name).read_bytes()) == checksum, f"Checksum mismatch: {name}")

    # Inspect every member before writing anything; never follow archive links.
    with tarfile.open(assets / archive_name, "r:gz") as archive:
        members = archive.getmembers()
        names = set()
        total = 0
        for member in members:
            path = safe_path(member.name)
            require(path.parts[0] == "zensu", "Archive must contain only zensu/")
            require(member.isfile() or member.isdir(), f"Unsupported archive member: {member.name}")
            require(str(path) not in names, f"Duplicate archive member: {member.name}")
            names.add(str(path))
            total += member.size
        require(total <= 100 * 1024 * 1024, "Release package exceeds 100 MiB")
        for member in members:
            target = output.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open("wb") as destination:
                    shutil.copyfileobj(source, destination)
                target.chmod(member.mode & 0o777)

    plugin = output / "zensu"
    receipt_bytes = (plugin / "build.json").read_bytes()
    require(receipt_bytes == (assets / "build.json").read_bytes(), "Inner and outer build receipts differ")
    receipt = json.loads(receipt_bytes)
    manifest = json.loads((plugin / "plugin.json").read_text())
    require(receipt["schemaVersion"] == 2 and receipt["host"] == "copilot", "Not a native Copilot build")
    require(manifest["name"] == "zensu" and manifest["version"] == receipt["version"] == version,
            "Release, plugin and build versions differ")
    require(manifest["$schema"] == "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "Expected the native Agent Plugins manifest")
    recorded = set()
    for entry in receipt["files"]:
        name = str(safe_path(entry["target"]))
        require(name not in recorded and name != "build.json", "Duplicate build inventory entry")
        recorded.add(name)
        require(digest((plugin / name).read_bytes()) == entry["sha256"], f"Package hash mismatch: {name}")
    actual = {file.relative_to(plugin).as_posix() for file in plugin.rglob("*") if file.is_file()}
    require(actual == recorded | {"build.json"}, "Package inventory differs from build receipt")
    for name in ["hooks/native/dispatcher.js", "com.github.copilot/hooks/hooks.json", "harness"]:
        require((plugin / name).exists(), f"Incomplete native package: {name}")
    require(not (plugin / ".claude-plugin").exists(), "Foreign plugin manifest refused")
    return plugin, manifest, checksums


def publish(args):
    require(args.tag.startswith("v"), "Release tag must start with v")
    version = args.tag[1:]
    version_tuple(version)
    require(re.fullmatch(r"[0-9a-f]{40}", args.source_sha), "Expected a full source commit SHA")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository), "Invalid GitHub repository")
    work = Path(args.work_dir).resolve()
    work.mkdir(parents=True, exist_ok=False)
    plugin, manifest, checksums = verify_release(Path(args.assets).resolve(), version, work / "extracted")
    repo = work / "repository"
    repo.mkdir()

    def git(*arguments, check=True):
        config = ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false"]
        if os.environ.get("GH_TOKEN"):
            config += ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
        result = subprocess.run(["git", *config, *arguments], cwd=repo, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if check and result.returncode:
            raise RuntimeError(f"git {arguments[0]} failed: {result.stderr.strip()}")
        return result

    remote = args.remote or f"https://github.com/{args.repository}.git"
    git("init", "--initial-branch=marketplace", "--object-format=sha1")
    git("remote", "add", "origin", remote)
    branch = "refs/heads/marketplace"
    release_ref = f"refs/tags/marketplace/{args.tag}"
    refs = git("ls-remote", "origin", branch, release_ref).stdout.splitlines()
    known_refs = dict(line.split()[::-1] for line in refs)
    if branch in known_refs:
        git("fetch", "--no-tags", "origin", branch)
        git("checkout", "-B", "marketplace", "FETCH_HEAD")
        previous = json.loads((repo / "publication.json").read_text())
        require(version_tuple(version) >= version_tuple(previous["version"]), "Refusing marketplace version rollback")
        if version == previous["version"]:
            require(previous["sourceCommit"] == args.source_sha and previous["checksums"] == checksums,
                    "Published version is immutable; release content changed")
            require(known_refs.get(release_ref) == git("rev-parse", "HEAD").stdout.strip(),
                    "Published release tag does not match marketplace HEAD")
            print(f"Marketplace already publishes {args.tag}; no changes")
            return
    require(release_ref not in known_refs, "Immutable marketplace release tag already exists")

    destination = repo / "plugins/zensu"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(plugin, destination)
    git("add", "--force", "--all", "plugins/zensu")
    staged = {}
    for entry in git("ls-files", "--stage", "-z", "plugins/zensu").stdout.split("\0"):
        if entry:
            metadata, name = entry.split("\t", 1)
            staged[name] = metadata.split()[1]
    expected_blobs = {}
    for file in plugin.rglob("*"):
        if file.is_file():
            data = file.read_bytes()
            name = "plugins/zensu/" + file.relative_to(plugin).as_posix()
            expected_blobs[name] = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
    require(staged == expected_blobs, "Git staging changed or omitted released package bytes")

    def commit(message):
        git("-c", "user.name=github-actions[bot]", "-c",
            "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-m", message)

    commit(f"Publish native Zensu package {args.tag}")
    package_sha = git("rev-parse", "HEAD").stdout.strip()
    write_json(repo / ".github/plugin/marketplace.json", {
        "name": "zensu", "owner": {"name": "MKITConsulting"},
        "metadata": {"description": "Native Zensu workflows for GitHub Copilot CLI", "version": version},
        "plugins": [{"name": "zensu", "version": version, "description": manifest["description"],
                     "license": manifest["license"],
                     "source": {"source": "github", "repo": args.repository,
                                "sha": package_sha, "path": "plugins/zensu"}}],
    })
    write_json(repo / "publication.json", {
        "schemaVersion": 1, "version": version, "releaseTag": args.tag,
        "sourceCommit": args.source_sha, "packageCommit": package_sha, "checksums": checksums,
    })
    (repo / "README.md").write_text(
        f"# Zensu Copilot marketplace\n\nGenerated from release `{args.tag}`. Do not edit this branch.\n\n"
        f"```bash\ncopilot plugin marketplace add {args.repository}#marketplace\n"
        "copilot plugin install zensu@zensu\n```\n\n"
        f"Source and publication instructions: https://github.com/{args.repository}/tree/main\n",
        encoding="utf-8")
    git("add", "--all")
    commit(f"Update native marketplace to {args.tag}")
    if args.push:
        git("push", "--atomic", "origin", f"HEAD:{branch}", f"HEAD:{release_ref}")
        print(f"Published {args.tag}; package pinned to {package_sha}")
    else:
        print(f"Prepared {args.tag} in {repo}; no remote changes (--push to publish)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--repository", default="MKITConsulting/zensu-copilot")
    parser.add_argument("--remote", help="Override the Git remote for local integration tests")
    parser.add_argument("--work-dir", required=True, help="New, disposable directory (must not exist)")
    parser.add_argument("--push", action="store_true")
    publish(parser.parse_args())
