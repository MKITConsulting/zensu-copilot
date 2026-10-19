"""Local Git/archive integration tests; these are not live Copilot validation."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/publish-marketplace.py"


def sha(data):
    return hashlib.sha256(data).hexdigest()


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zensu-marketplace-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / "remote.git"
        self.git("init", "--bare", str(self.remote))
        self.attempt = 0

    def git(self, *args, check=True):
        return subprocess.run(["git", *args], check=check, capture_output=True, text=True)

    def fixture(self, version="0.2.0", variant="original", extra=None, corrupt_file=False):
        assets = self.root / f"assets-{version}-{variant}"
        assets.mkdir()
        files = {
            "plugin.json": json.dumps({
                "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
                "name": "zensu", "version": version, "description": "Fixture", "license": "MIT",
            }).encode(),
            "hooks/native/dispatcher.js": f"// {variant}\n".encode(),
            "com.github.copilot/hooks/hooks.json": b'{"version":1,"hooks":{}}\n',
            "harness/run.sh": b"#!/bin/sh\nexit 0\n",
            ".gitignore": b"ignored.txt\n",
            "ignored.txt": b"A released file must survive Git ignore rules.\n",
        }
        receipt = json.dumps({
            "schemaVersion": 2, "host": "copilot", "version": version,
            "files": [{"target": name, "sha256": sha(data)} for name, data in files.items()],
        }).encode()
        files["build.json"] = receipt
        if corrupt_file:
            files["hooks/native/dispatcher.js"] = b"changed after receipt"
        archive_path = assets / f"zensu-copilot-{version}.tar.gz"
        with tarfile.open(archive_path, "w:gz") as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(f"zensu/{name}")
                member.size = len(data)
                member.mode = 0o755 if name.endswith(".sh") else 0o644
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra, io.BytesIO(b""))
        (assets / "build.json").write_bytes(receipt)
        self.checksums(assets, version)
        return assets, files

    def checksums(self, assets, version):
        names = [f"zensu-copilot-{version}.tar.gz", "build.json"]
        (assets / "SHA256SUMS").write_text("".join(f"{sha((assets / name).read_bytes())}  {name}\n" for name in names))

    def publish(self, assets, version="0.2.0", push=True, source="a" * 40):
        self.attempt += 1
        command = [sys.executable, str(SCRIPT), "--assets", str(assets), "--tag", f"v{version}",
                   "--source-sha", source, "--repository", "MKITConsulting/zensu-copilot",
                   "--remote", str(self.remote), "--work-dir", str(self.root / f"run-{self.attempt}")]
        if push:
            command.append("--push")
        return subprocess.run(command, text=True, capture_output=True)

    def read(self, spec):
        return self.git("--git-dir", str(self.remote), "show", spec).stdout

    def head(self):
        return self.git("--git-dir", str(self.remote), "rev-parse", "refs/heads/marketplace").stdout.strip()

    def test_publish_exact_bytes_and_sha_pinned_catalog_then_idempotent_retry(self):
        assets, files = self.fixture()
        result = self.publish(assets)
        self.assertEqual(result.returncode, 0, result.stderr)
        first = self.head()
        catalog = json.loads(self.read("marketplace:.github/plugin/marketplace.json"))
        source = catalog["plugins"][0]["source"]
        self.assertEqual(catalog["name"], "zensu")
        self.assertEqual(source["path"], "plugins/zensu")
        self.assertEqual(len(source["sha"]), 40)
        self.assertNotEqual(source["sha"], first)
        for name, data in files.items():
            self.assertEqual(self.read(f'{source["sha"]}:plugins/zensu/{name}').encode(), data)
        mode = self.git("--git-dir", str(self.remote), "ls-tree", source["sha"], "plugins/zensu/harness/run.sh").stdout
        self.assertTrue(mode.startswith("100755"))
        self.assertEqual(self.read("marketplace/v0.2.0:publication.json"), self.read("marketplace:publication.json"))
        result = self.publish(assets)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no changes", result.stdout)
        self.assertEqual(self.head(), first)

    def test_upgrade_retains_pinned_package_and_refuses_rollback_or_changed_version(self):
        old, _ = self.fixture()
        self.assertEqual(self.publish(old).returncode, 0)
        first = self.head()
        old_source = json.loads(self.read("marketplace:.github/plugin/marketplace.json"))["plugins"][0]["source"]["sha"]
        changed, _ = self.fixture(variant="changed")
        result = self.publish(changed)
        self.assertIn("immutable", result.stderr)
        self.assertEqual(self.head(), first)
        new, _ = self.fixture("0.2.1")
        result = self.publish(new, "0.2.1", source="b" * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        second = self.head()
        self.assertEqual(self.git("--git-dir", str(self.remote), "merge-base", "--is-ancestor", first, second).returncode, 0)
        self.assertIn("original", self.read(f"{old_source}:plugins/zensu/hooks/native/dispatcher.js"))
        result = self.publish(old)
        self.assertIn("rollback", result.stderr)
        self.assertEqual(self.head(), second)

    def test_checksum_inventory_and_receipt_mismatches_do_not_publish(self):
        assets, _ = self.fixture()
        (assets / "build.json").write_text("tampered")
        self.assertIn("Checksum mismatch", self.publish(assets).stderr)
        self.checksums(assets, "0.2.0")
        self.assertIn("receipts differ", self.publish(assets).stderr)
        altered, _ = self.fixture(variant="corrupt", corrupt_file=True)
        self.assertIn("Package hash mismatch", self.publish(altered).stderr)
        extra, _ = self.fixture(variant="extra", extra=tarfile.TarInfo("zensu/unlisted"))
        self.assertIn("inventory differs", self.publish(extra).stderr)
        self.assertEqual(self.git("ls-remote", str(self.remote)).stdout, "")

    def test_unsafe_archive_paths_links_and_duplicate_entries_are_refused(self):
        for index, name in enumerate(["zensu/../../escape", "/zensu/absolute", "other/file", "zensu/.git/config",
                                      "zensu/hooks/native/dispatcher.js", "zensu/link"]):
            with self.subTest(name=name):
                member = tarfile.TarInfo(name)
                if name.endswith("link"):
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/tmp"
                assets, _ = self.fixture(variant=str(index), extra=member)
                self.assertNotEqual(self.publish(assets).returncode, 0)
        self.assertEqual(self.git("ls-remote", str(self.remote)).stdout, "")

    def test_version_mismatch_prerelease_and_unpushed_preparation(self):
        assets, _ = self.fixture()
        result = self.publish(assets, "0.2.0-rc.1")
        self.assertIn("stable semantic versions", result.stderr)
        other, _ = self.fixture("0.2.1")
        (other / "zensu-copilot-0.2.1.tar.gz").rename(other / "zensu-copilot-0.2.0.tar.gz")
        self.checksums(other, "0.2.0")
        self.assertIn("versions differ", self.publish(other).stderr)
        result = self.publish(assets, push=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("ls-remote", str(self.remote)).stdout, "")

    def test_failed_atomic_push_leaves_branch_and_tag_unchanged(self):
        old, _ = self.fixture()
        self.assertEqual(self.publish(old).returncode, 0)
        before = self.git("ls-remote", str(self.remote)).stdout
        hook = self.remote / "hooks/update"
        hook.write_text('#!/bin/sh\ncase "$1" in refs/tags/*) exit 1;; esac\nexit 0\n')
        hook.chmod(0o755)
        new, _ = self.fixture("0.2.1")
        result = self.publish(new, "0.2.1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git("ls-remote", str(self.remote)).stdout, before)
