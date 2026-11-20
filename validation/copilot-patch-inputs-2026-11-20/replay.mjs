import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const [captureDir, ...plugins] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const file = fs.readdirSync(captureDir).find(name => name.endsWith('-preToolUse.json'));
const capture = JSON.parse(fs.readFileSync(path.join(captureDir, file), 'utf8'));
const raw = capture.payload;
const rawBytes = Buffer.byteLength(JSON.stringify(raw));
const result = { capture: file, toolName: raw.toolName, toolArgsType: typeof raw.toolArgs, toolArgsBytes: Buffer.byteLength(typeof raw.toolArgs === 'string' ? raw.toolArgs : JSON.stringify(raw.toolArgs)), rawPayloadBytes: rawBytes, builds: {} };
for (const plugin of plugins) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-replay-'));
  const env = { PATH: process.env.PATH, HOME: base, COPILOT_HOME: path.join(base, 'copilot'), COPILOT_PLUGIN_ROOT: plugin,
    COPILOT_PLUGIN_DATA: path.join(base, 'data'), COPILOT_PROJECT_DIR: raw.cwd, COPILOT_SESSION_ID: raw.sessionId };
  fs.mkdirSync(env.COPILOT_PLUGIN_DATA, { mode: 0o700 });
  const { dispatch } = require(path.join(plugin, 'hooks/native/dispatcher.js'));
  const spawns = [];
  let output;
  try {
    output = dispatch('preToolUse', JSON.parse(JSON.stringify(raw)), { root: plugin, env, spawnSync: (_file, args, options) => {
      spawns.push({ hook: path.basename(args[0]), bytes: Buffer.byteLength(options.input), input: options.input });
      return { status: 0, stdout: '{}' };
    } });
  } catch (error) {
    output = { thrown: error.message };
  }
  const inputs = [...new Map(spawns.map(spawn => [spawn.input, spawn.bytes])).values()];
  result.builds[path.basename(plugin)] = {
    decision: output.permissionDecision || null, reason: output.permissionDecisionReason ? output.permissionDecisionReason.slice(0, 160) : output.thrown || null,
    hookSpawns: spawns.length, distinctOperationInputs: inputs.length, maxInputBytes: inputs.length ? Math.max(...inputs) : 0,
    minInputBytes: inputs.length ? Math.min(...inputs) : 0, inputsOver1MiB: inputs.filter(bytes => bytes > 1024 * 1024).length,
    embedsPatch: spawns.some(spawn => spawn.input.includes('*** Begin Patch')),
    operations: [...new Map(spawns.map(spawn => [spawn.input, spawn.input])).values()].map(input => { const parsed = JSON.parse(input); return { tool: parsed.toolName, path: parsed.toolArgs && parsed.toolArgs.path, operation: parsed.toolArgs && parsed.toolArgs.operation }; }),
  };
  fs.rmSync(base, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
