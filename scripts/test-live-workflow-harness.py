#!/usr/bin/env python3
"""Exercise the controller with a fake CLI, never a model or installed plugin."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "live_workflow_harness", Path(__file__).with_name("live-copilot-workflow-retest.py")
)
HARNESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HARNESS)


class LaunchDirectoryTest(unittest.TestCase):
    def test_child_pwd_and_working_directory_agree_without_changing_parent(self):
        with tempfile.TemporaryDirectory(prefix="zensu-harness-pwd-") as directory:
            root = Path(directory).resolve()
            project = root / "project"
            project.mkdir()
            plugin = root / "plugin"
            plugin.mkdir()
            (plugin / "fixture.txt").write_text("fake plugin; no hooks\n")
            (root / "prompt.txt").write_text("Fake process fixture only.\n")
            HARNESS.save(root / "frozen-plugin.json", {
                "root": str(plugin), "files": HARNESS.inventory(plugin),
            })
            HARNESS.save(root / "global-before.json", {})
            fake_cli = root / "fake-copilot"
            fake_cli.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                "print(json.dumps({'cwd': os.getcwd(), 'pwd': os.environ.get('PWD'), "
                "'arguments': sys.argv[1:]}))\n"
            )
            fake_cli.chmod(0o755)
            metadata = {
                "status": "frozen-preflight-passed-model-not-started",
                "sessionId": "fake-cli-pwd-fixture",
            }
            parent_directory = Path.cwd()
            stale_pwd = str(root / "unrelated-launch-checkout")
            with mock.patch.dict(os.environ, {"PWD": stale_pwd}), \
                    mock.patch.object(HARNESS.shutil, "which", return_value=str(fake_cli)), \
                    mock.patch.object(HARNESS, "global_state", return_value={}), \
                    contextlib.redirect_stdout(io.StringIO()):
                result = HARNESS.execute(root, metadata)
                self.assertEqual(os.environ["PWD"], stale_pwd)
            self.assertEqual(Path.cwd(), parent_directory)
            self.assertEqual(result, 0)
            child = json.loads((root / "output.jsonl").read_text())
            self.assertEqual(child["cwd"], str(project))
            self.assertEqual(child["pwd"], str(project))
            self.assertNotIn("--allow-all-paths", child["arguments"])
            self.assertEqual(child["arguments"].count("--add-dir"), 1)
            self.assertEqual(child["arguments"][child["arguments"].index("--add-dir") + 1], str(plugin))
            overrides = json.loads((root / "environment-overrides.json").read_text())
            self.assertEqual(overrides["PWD"], str(project))
            self.assertEqual(json.loads((root / "integrity-after.json").read_text()), {
                "frozenPluginUnchanged": True, "globalAndMarketplaceUnchanged": True,
            })


if __name__ == "__main__":
    unittest.main()
