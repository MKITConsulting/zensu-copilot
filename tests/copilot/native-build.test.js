'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const repository = path.resolve(__dirname, '../..');

test('the complete native plugin builds independently without the source-host repository or transformers', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['src', 'scripts', 'docs']) fs.cpSync(path.join(repository, name), path.join(root, name), { recursive: true });
  for (const name of ['package.json', 'README.md']) fs.copyFileSync(path.join(repository, name), path.join(root, name));
  assert(!fs.existsSync(path.join(root, 'upstream')));
  assert(!fs.existsSync(path.join(root, 'src/render.js')));
  assert(!fs.existsSync(path.join(root, 'src/runtime-patches.js')));
  const result = spawnSync(process.execPath, ['scripts/build.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = path.join(root, 'dist/zensu');
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'build.json')));
  assert.equal(manifest.skills.length, 32);
  assert.equal(manifest.agents, 6);
  for (const file of manifest.files) {
    const original = fs.readFileSync(path.join(root, file.source));
    const shipped = fs.readFileSync(path.join(output, file.target));
    assert(original.equals(shipped), `${file.target}: build changed runtime semantics`);
    assert.equal(crypto.createHash('sha256').update(shipped).digest('hex'), file.sha256);
  }
  const first = fs.readFileSync(path.join(output, 'build.json'));
  assert.equal(spawnSync(process.execPath, ['scripts/build.js'], { cwd: root }).status, 0);
  assert(first.equals(fs.readFileSync(path.join(output, 'build.json'))), 'native build must be deterministic');
});
