import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const [runRoot, name, pluginArg, delayArg, killArg] = process.argv.slice(2);
const plugin = fs.realpathSync(pluginArg);
const delayMs = Number(delayArg);
const killOnChatRequest = Number(killArg);
if (!Number.isInteger(delayMs) || delayMs < 0 || !Number.isInteger(killOnChatRequest) || killOnChatRequest < 2) throw new Error('usage: stop-probe.mjs <run-root> <name> <plugin> <delay-ms> <kill-on-chat-request>');
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
const model = 'gpt-5.4';
const slowHooks = path.join(path.dirname(fileURLToPath(import.meta.url)), 'slow-hooks.cjs');
const flag = path.join(root, 'stop-phase');
const slowConfig = path.join(root, 'slow-hooks.json');
fs.writeFileSync(slowConfig, JSON.stringify({ pluginRoot: plugin, flag, delayMs, log: path.join(root, 'slow-hooks.jsonl') }));

fs.writeFileSync(path.join(dirs.project, 'README.md'), 'Disposable project for a Copilot CLI stop-deadline probe.\n');
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
let chatRequests = 0;
let killed = null;
let child = null;
const stopChild = reason => {
  if (killed || !child) return;
  killed = { reason, t: Date.now() };
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
};
function chunk(delta, finish) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
const server = http.createServer((request, response) => {
  const parts = [];
  request.on('data', part => parts.push(part));
  request.on('end', () => {
    const raw = Buffer.concat(parts).toString('utf8');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unparsed: true }; }
    const entry = { index: requests.length, t: Date.now(), method: request.method, url: request.url, bytes: Buffer.byteLength(raw) };
    requests.push(entry);
    fs.writeFileSync(path.join(dirs.provider, `request-${String(entry.index).padStart(3, '0')}.json`), JSON.stringify({ method: request.method, url: request.url, body }, null, 2));
    if (request.method === 'GET' && /models/.test(request.url)) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'probe' }] }));
      return;
    }
    if (request.method !== 'POST' || !/chat\/completions/.test(request.url)) {
      entry.unhandled = true;
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not handled by probe provider' } }));
      return;
    }
    chatRequests += 1;
    entry.chat = chatRequests;
    if (chatRequests >= killOnChatRequest) {
      entry.stoppedRun = true;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'probe stopped the run' } }));
      stopChild(`chat request ${chatRequests} arrived`);
      return;
    }
    const text = 'Probe complete.';
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    const finish = () => { fs.writeFileSync(flag, String(Date.now())); entry.answered = Date.now(); };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(chunk({ role: 'assistant', content: text }, null));
      response.write(chunk({}, 'stop'));
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage })}\n\n`);
      response.end('data: [DONE]\n\n', finish);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }), finish);
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(CLAUDE|ZENSU_|COPILOT_|GH_|GITHUB_)/.test(key) || ['PLUGIN_ROOT', 'PLUGIN_DATA', 'NODE_OPTIONS', 'OLLAMA_HOST', 'STOP_PROBE_CONFIG'].includes(key)) continue;
  env[key] = value;
}
Object.assign(env, {
  HOME: dirs.userhome, PWD: dirs.project, PATH: `${dirs.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  COPILOT_HOME: dirs.home, COPILOT_OFFLINE: 'true', COPILOT_AUTO_UPDATE: 'false', COPILOT_PLUGIN_DIR_ONLY: 'true',
  COPILOT_DISABLE_LOGIN_SHELL_ENV: '1', COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`, COPILOT_PROVIDER_TYPE: 'openai',
  COPILOT_PROVIDER_API_KEY: 'offline-probe', COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: model,
  ZENSU_COPILOT_CAPTURE_DIR: dirs.hooks, NODE_OPTIONS: `--require ${slowHooks}`, STOP_PROBE_CONFIG: slowConfig,
});
const args = [copilotEntry, '-C', dirs.project, '--plugin-dir', plugin, '--add-dir', plugin,
  '--output-format', 'json', '--no-auto-update', '--no-ask-user', '--disable-builtin-mcps', '--allow-all-tools',
  '--log-level', 'debug', '--log-dir', dirs.logs, '-p', 'Reply with the single word done.'];
save('command.json', { node: nodeBinary, args, envOverrides: Object.fromEntries(Object.entries(env).filter(([key]) => /^(HOME|PWD|PATH|COPILOT_|ZENSU_|NODE_OPTIONS|STOP_PROBE_CONFIG)/.test(key))) });
const before = globalState();
save('global-before.json', before);
const started = Date.now();
child = spawn(nodeBinary, args, { cwd: dirs.project, env, stdio: ['ignore', fs.openSync(path.join(root, 'output.jsonl'), 'w'), fs.openSync(path.join(root, 'stderr.txt'), 'w')], detached: true });
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; stopChild('timeout'); }, 900 * 1000);
const code = await new Promise(resolve => child.on('exit', (exitCode, signal) => resolve({ exitCode, signal })));
clearTimeout(timer);
server.close();
const after = globalState();
save('global-after.json', after);
save('run.json', {
  name, port, model, plugin, pluginVersion: JSON.parse(fs.readFileSync(path.join(plugin, 'plugin.json'), 'utf8')).version,
  delayMs, killOnChatRequest, started, elapsedSeconds: (Date.now() - started) / 1000, timedOut, killed, ...code,
  chatRequests, requests, captures: fs.readdirSync(dirs.hooks).sort(),
  globalStateUnchanged: JSON.stringify(before) === JSON.stringify(after),
});
console.log(JSON.stringify({ name, exit: code, timedOut, killed, chatRequests, captures: fs.readdirSync(dirs.hooks).length }));
