import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [runRoot, ...names] = process.argv.slice(2);
const home = os.homedir();

function sanitize(text, run) {
  return String(text).split(run.root).join('<run>').split(run.plugin).join('<plugin>').split(home).join('<home>');
}
function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function summarize(name) {
  const root = path.join(runRoot, name);
  const runFile = JSON.parse(fs.readFileSync(path.join(root, 'run.json'), 'utf8'));
  const run = { root, plugin: runFile.plugin };
  const started = runFile.started;
  const rel = t => Math.round((t - started) / 100) / 10;
  const logFile = fs.readdirSync(path.join(root, 'logs')).filter(file => file.endsWith('.log')).map(file => path.join(root, 'logs', file))[0];
  const log = readLines(logFile);
  const version = (log.join('\n').match(/Version number: ([0-9.]+)/) || [])[1] || null;
  const marks = [];
  const outputs = [];
  for (const line of log) {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(line)) {
      if (outputs.length) outputs.at(-1).text += `\n${line}`;
      continue;
    }
    const time = Date.parse(line.slice(0, 24));
    const mark = line.match(/"event_type":"hook\.(start|end)"/);
    if (mark) marks.push({ t: time, kind: mark[1] });
    const out = line.match(/\[rust:hooks\] \[hook (stdout|stderr)\] (.*)$/);
    if (out) outputs.push({ t: time, stream: out[1], text: out[2] });
  }
  const pairs = [];
  let open = null;
  for (const mark of marks) {
    if (mark.kind === 'start') open = mark.t;
    else if (open !== null) { pairs.push({ start: open, end: mark.t }); open = null; }
  }
  const captures = runFile.captures.map(file => {
    const [t, , event] = file.replace(/\.json$/, '').split('-');
    return { t: Number(t), event };
  });
  const hooks = captures.map(capture => {
    const pair = pairs.find(candidate => candidate.start <= capture.t + 50 && candidate.end >= capture.t);
    const lines = pair ? outputs.filter(output => output.t >= pair.start && output.t <= pair.end) : [];
    return {
      event: capture.event, at: rel(capture.t), seconds: pair ? Math.round((pair.end - pair.start) / 100) / 10 : null,
      stdout: lines.filter(line => line.stream === 'stdout').map(line => sanitize(line.text, run).slice(0, 2000)),
      stderr: lines.filter(line => line.stream === 'stderr').flatMap(line => sanitize(line.text, run).split('\n')).filter(Boolean),
    };
  });
  const events = readLines(path.join(root, 'output.jsonl')).map(line => { try { return JSON.parse(line); } catch { return {}; } });
  const userMessages = events.filter(event => event.type === 'user.message').map(event => sanitize(String(event.data?.content || ''), run).slice(0, 160));
  const slow = readLines(path.join(root, 'slow-hooks.jsonl')).map(line => JSON.parse(line));
  const delayed = {};
  for (const row of slow.filter(row => row.delayMs > 0)) delayed[row.script] = (delayed[row.script] || 0) + 1;
  return {
    name, copilotVersion: version, pluginVersion: runFile.pluginVersion, delayMs: runFile.delayMs,
    elapsedSeconds: runFile.elapsedSeconds, exitCode: runFile.exitCode, signal: runFile.signal, timedOut: runFile.timedOut,
    stoppedByProbe: runFile.killed ? sanitize(runFile.killed.reason, run) : null,
    chatRequests: runFile.chatRequests,
    chatRequestTimes: runFile.requests.filter(request => request.chat).map(request => rel(request.t)),
    userMessages, agentStops: hooks.filter(hook => hook.event === 'agentStop'),
    nodeStartsLogged: slow.length, delayedNodeStarts: delayed,
    globalStateUnchanged: runFile.globalStateUnchanged,
  };
}

const result = { runs: names.map(summarize) };
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
