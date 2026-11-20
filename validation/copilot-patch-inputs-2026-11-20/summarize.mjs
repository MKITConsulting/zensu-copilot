import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [runsDir, replayDir, outFile, pr30Commit, mainCommit, copilotVersion] = process.argv.slice(2);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const visible = text => JSON.stringify(text).split(LS).join('<U+2028>').split(PS).join('<U+2029>');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const runs = {};
for (const name of fs.readdirSync(runsDir).sort()) {
  const root = path.join(runsDir, name);
  if (!fs.existsSync(path.join(root, 'run.json'))) continue;
  const run = readJson(path.join(root, 'run.json'));
  const project = path.join(root, 'project');
  const redact = text => String(text).replace(new RegExp(`[^ ,"]*/runs/${name}/project/`, 'g'), '<project>/');
  const events = fs.readFileSync(path.join(root, 'output.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const tools = events.filter(event => event.type === 'tool.execution_complete').map(event => ({
    success: event.data.success,
    message: redact(event.data.error ? event.data.error.message : (event.data.result && (event.data.result.content ?? JSON.stringify(event.data.result))) || '').slice(0, 240),
  }));
  const result = events.find(event => event.type === 'result');
  const files = {};
  const smallFiles = {};
  for (const [relative, digest] of Object.entries(run.projectFiles)) {
    if (relative.startsWith('.zensu/') || relative === 'README.md') continue;
    files[relative] = digest;
    const full = path.join(project, relative);
    if (fs.statSync(full).size <= 256) smallFiles[relative] = visible(fs.readFileSync(full, 'utf8'));
  }
  runs[name] = {
    plugin: run.plugin ? path.basename(run.plugin) : 'none', exitCode: run.exitCode, timedOut: run.timedOut,
    premiumRequests: result && result.usage ? result.usage.premiumRequests : null,
    providerRequests: run.requests.length, scriptedToolCalls: run.issued.map(call => ({ name: call.name, type: call.type, bytes: call.payloadBytes, sha256: call.payloadSha256 })),
    toolResults: tools, projectFilesAfter: files, smallFileContents: smallFiles,
    hookEvents: run.captures.map(file => file.replace(/^\d+-\d+-/, '').replace(/\.json$/, '')),
    globalStateUnchanged: run.globalStateUnchanged,
    rawDigests: Object.fromEntries(['output.jsonl', 'stderr.txt', 'run.json'].map(file => [file, sha(fs.readFileSync(path.join(root, file)))])),
  };
}
const replay = {};
for (const file of fs.readdirSync(replayDir).filter(name => /^replay-.*\.json$/.test(name)).sort()) {
  const data = readJson(path.join(replayDir, file));
  replay[file.replace(/^replay-|\.json$/g, '')] = {
    nativeToolName: data.toolName, nativeToolArgsType: data.toolArgsType, nativeToolArgsBytes: data.toolArgsBytes,
    builds: Object.fromEntries(Object.entries(data.builds).map(([build, value]) => [build.startsWith('pr30') ? 'pr30' : 'main', {
      decision: value.decision, reason: value.reason, hookSpawns: value.hookSpawns, operationInputs: value.distinctOperationInputs,
      maxInputBytes: value.maxInputBytes, minInputBytes: value.minInputBytes, inputsOver1MiB: value.inputsOver1MiB,
      embedsPatch: value.embedsPatch, operations: value.operations,
    }])),
  };
}
fs.writeFileSync(outFile, JSON.stringify({
  schema: 'zensu.copilot-patch-inputs-capture.v1',
  copilotCliVersion: copilotVersion,
  builds: { pr30: { commit: pr30Commit }, main: { commit: mainCommit } },
  provider: { offline: true, type: 'openai', wireApi: 'completions', model: 'gpt-5.4', applyPatchTool: 'custom freeform tool with a Lark grammar whose lines end in LF' },
  runs, replay,
}, null, 2) + '\n');
console.log(JSON.stringify({ runs: Object.keys(runs), replay: Object.keys(replay) }));
