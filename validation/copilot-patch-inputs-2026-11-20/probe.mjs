import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const [runRoot, name, scenarioFile] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
const root = path.join(path.resolve(runRoot), name);
if (fs.existsSync(root)) throw new Error(`run directory already exists: ${root}`);
const dirs = Object.fromEntries(['home', 'userhome', 'project', 'hooks', 'logs', 'provider', 'bin'].map(key => [key, path.join(root, key)]));
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const save = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + '\n');
const which = command => execFileSync('/usr/bin/which', [command]).toString().trim();
const copilotEntry = fs.realpathSync(which('copilot'));
const gitBinary = which('git');
const nodeBinary = process.execPath;

for (const [relative, content] of Object.entries(scenario.seed || {})) {
  const target = path.join(dirs.project, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
fs.writeFileSync(path.join(dirs.project, 'README.md'), 'Disposable project for a Copilot CLI hook probe.\n');
const git = (...args) => execFileSync(gitBinary, ['-C', dirs.project, ...args], { stdio: 'pipe' });
git('init', '-q');
git('config', 'user.name', 'Zensu Live Validation');
git('config', 'user.email', 'live-validation@example.invalid');
git('add', '.');
git('commit', '-qm', 'test: seed probe project');
fs.symlinkSync(nodeBinary, path.join(dirs.bin, 'node'));
fs.symlinkSync(gitBinary, path.join(dirs.bin, 'git'));

function inventory(dir) {
  const result = {};
  if (!fs.existsSync(dir)) return result;
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result[path.relative(dir, full)] = sha(fs.readFileSync(full));
    }
  };
  walk(dir);
  return result;
}
function globalState() {
  const home = os.homedir();
  const copilotHome = path.join(home, '.copilot');
  const files = [path.join(home, '.zensu/config.json'), ...['settings.json', 'permissions-config.json', 'mcp-config.json'].map(file => path.join(copilotHome, file))];
  const sessionState = path.join(copilotHome, 'session-state');
  return {
    files: Object.fromEntries(files.map(file => [file, fs.existsSync(file) ? sha(fs.readFileSync(file)) : null])),
    installedZensu: inventory(path.join(copilotHome, 'installed-plugins/zensu/zensu')),
    sessionStateEntries: fs.existsSync(sessionState) ? fs.readdirSync(sessionState).length : null,
    packageCache: fs.existsSync(path.join(home, 'Library/Caches/copilot/pkg/darwin-arm64')) ? fs.readdirSync(path.join(home, 'Library/Caches/copilot/pkg/darwin-arm64')).sort() : null,
  };
}

const requests = [];
const issued = [];
const scripted = scenario.tools || [];
function decide(body) {
  const calls = (body.messages || []).filter(message => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length).length;
  if (Array.isArray(body.tools) && body.tools.length && calls < scripted.length) return { tool: scripted[calls], index: calls };
  return { text: scenario.finalText || 'Probe complete.' };
}
function chunk(model, delta, finish) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
const server = http.createServer((request, response) => {
  const parts = [];
  request.on('data', part => parts.push(part));
  request.on('end', () => {
    const raw = Buffer.concat(parts).toString('utf8');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unparsed: true }; }
    const entry = { index: requests.length, method: request.method, url: request.url, bytes: Buffer.byteLength(raw) };
    requests.push(entry);
    fs.writeFileSync(path.join(dirs.provider, `request-${String(entry.index).padStart(3, '0')}.json`), JSON.stringify({ method: request.method, url: request.url, body }, null, 2));
    if (request.method === 'GET' && /models/.test(request.url)) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: scenario.model, object: 'model', owned_by: 'probe' }] }));
      return;
    }
    if (request.method !== 'POST' || !/chat\/completions/.test(request.url)) {
      entry.unhandled = true;
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not handled by probe provider' } }));
      return;
    }
    const model = body.model || scenario.model;
    const choice = decide(body);
    entry.response = choice.tool ? { tool: choice.tool.name, index: choice.index } : { text: true };
    const custom = choice.tool && choice.tool.type === 'custom';
    const payload = choice.tool ? (custom ? choice.tool.input : choice.tool.arguments) : '';
    if (choice.tool) issued.push({ request: entry.index, name: choice.tool.name, type: custom ? 'custom' : 'function', payloadSha256: sha(payload), payloadBytes: Buffer.byteLength(payload) });
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (choice.tool) {
        const id = `call_probe_${choice.index}`;
        if (custom) {
          response.write(chunk(model, { role: 'assistant', content: null, tool_calls: [{ index: 0, id, type: 'custom', custom: { name: choice.tool.name, input: '' } }] }, null));
          response.write(chunk(model, { tool_calls: [{ index: 0, custom: { input: payload } }] }, null));
        } else {
          response.write(chunk(model, { role: 'assistant', content: null, tool_calls: [{ index: 0, id, type: 'function', function: { name: choice.tool.name, arguments: '' } }] }, null));
          response.write(chunk(model, { tool_calls: [{ index: 0, function: { arguments: payload } }] }, null));
        }
        response.write(chunk(model, {}, 'tool_calls'));
      } else {
        response.write(chunk(model, { role: 'assistant', content: choice.text }, null));
        response.write(chunk(model, {}, 'stop'));
      }
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    const message = choice.tool
      ? { role: 'assistant', content: null, tool_calls: [custom
        ? { id: `call_probe_${choice.index}`, type: 'custom', custom: { name: choice.tool.name, input: payload } }
        : { id: `call_probe_${choice.index}`, type: 'function', function: { name: choice.tool.name, arguments: payload } }] }
      : { role: 'assistant', content: choice.text };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: choice.tool ? 'tool_calls' : 'stop' }], usage }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(CLAUDE_|ZENSU_|COPILOT_|GH_|GITHUB_)/.test(key) || ['PLUGIN_ROOT', 'PLUGIN_DATA', 'NODE_OPTIONS', 'OLLAMA_HOST'].includes(key)) continue;
  env[key] = value;
}
Object.assign(env, {
  HOME: dirs.userhome, PWD: dirs.project, PATH: `${dirs.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  COPILOT_HOME: dirs.home, COPILOT_OFFLINE: 'true', COPILOT_AUTO_UPDATE: 'false', COPILOT_PLUGIN_DIR_ONLY: 'true',
  COPILOT_DISABLE_LOGIN_SHELL_ENV: '1', COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`, COPILOT_PROVIDER_TYPE: 'openai',
  COPILOT_PROVIDER_API_KEY: 'offline-probe', COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: scenario.model,
  ZENSU_COPILOT_CAPTURE_DIR: dirs.hooks,
});
const args = [copilotEntry, '-C', dirs.project];
if (scenario.plugin) args.push('--plugin-dir', scenario.plugin, '--add-dir', scenario.plugin);
args.push('--output-format', 'json', '--no-auto-update', '--no-ask-user', '--disable-builtin-mcps',
  '--allow-all-tools', '--log-level', 'debug', '--log-dir', dirs.logs, ...(scenario.extraArgs || []), '-p', scenario.prompt);
save('command.json', { node: nodeBinary, args, envOverrides: Object.fromEntries(Object.entries(env).filter(([key]) => /^(HOME|PWD|PATH|COPILOT_|ZENSU_)/.test(key))) });
const before = globalState();
save('global-before.json', before);
const started = Date.now();
const child = spawn(nodeBinary, args, { cwd: dirs.project, env, stdio: ['ignore', fs.openSync(path.join(root, 'output.jsonl'), 'w'), fs.openSync(path.join(root, 'stderr.txt'), 'w')], detached: true });
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, (scenario.timeoutSeconds || 240) * 1000);
const code = await new Promise(resolve => child.on('exit', (exitCode, signal) => resolve({ exitCode, signal })));
clearTimeout(timer);
server.close();
const after = globalState();
save('global-after.json', after);
const projectFiles = {};
for (const [relative, digest] of Object.entries(inventory(dirs.project))) if (!relative.startsWith('.git/')) projectFiles[relative] = digest;
save('run.json', {
  name, port, model: scenario.model, plugin: scenario.plugin || null, elapsedSeconds: (Date.now() - started) / 1000, timedOut, ...code,
  requests, issued, projectFiles, captures: fs.readdirSync(dirs.hooks).sort(),
  globalStateUnchanged: JSON.stringify(before) === JSON.stringify(after),
});
console.log(JSON.stringify({ name, exit: code, timedOut, requests: requests.length, issued: issued.length, captures: fs.readdirSync(dirs.hooks).length }));
