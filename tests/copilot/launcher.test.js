'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const launcher = require('../../src/harness/launcher.js');

const ROOT = path.resolve(__dirname, '../..');
const ORDER = '44444444-4444-4444-8444-444444444444';
const SESSION = '5f0c3c3e-1d2b-4c1a-9b7e-2f6a1c0d9e88';
const TOKEN = 'zst_fixture_secret_do_not_log';
const required = ['--order', ORDER, '--session-id', SESSION];

function sealPackage(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (file !== path.join(root, 'build.json')) files.push({ target: path.relative(root, file),
        sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
  }
  visit(root);
  fs.writeFileSync(path.join(root, 'build.json'), JSON.stringify({schemaVersion:2, host:'copilot',
    version: JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'))).version, files}));
}

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-copilot-launcher-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plugin = path.join(dir, 'plugin');
  for (const name of ['harness', 'hooks/lib', 'scripts']) fs.mkdirSync(path.join(plugin, name), { recursive: true });
  fs.mkdirSync(path.join(dir, 'project'));
  fs.copyFileSync(path.join(ROOT, 'src/harness/launcher.js'), path.join(plugin, 'harness/launcher.js'));
  fs.copyFileSync(path.join(ROOT, 'src/plugin/scripts/process-supervisor.js'), path.join(plugin, 'scripts/process-supervisor.js'));
  fs.writeFileSync(path.join(plugin, 'hooks/lib/work-order-v1.js'), `
    const fs = require('node:fs');
    const call = (value) => fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(value) + '\\n');
    exports.tokenPresent = env => Boolean(env.ZENSU_SESSION_TOKEN);
    exports.sessionKeyOf = id => 'copilot:' + id;
    exports.VERDICTS = { LOST: 'lost' };
    exports.loadContext = ({env, projectRoot, sessionKey}) => {
      if (!env.FAKE_LEASE) return null;
      call({type:'context', projectRoot, sessionKey, host:env.ZENSU_RUNTIME_HOST});
      return { marker: {orderId:'${ORDER}', attempt:2}, files:{lease:'fixture'} };
    };
    exports.readState = () => ({leaseSeconds:12});
    exports.renew = (context, {env, thresholdMs}) => {
      call({type:'renew', thresholdMs});
      return {verdict:env.FAKE_LEASE === 'lost' && fs.existsSync(env.FAKE_GRANDCHILD) ? 'lost' : 'ok'};
    };
    exports.releasePlan = (root, order, below) => {
      call({type:'releasePlan', root, order, below}); return ['run_fixture'];
    };
  `);
  fs.writeFileSync(path.join(plugin, 'hooks/lib/zensu-autopilot-state.sh'),
    'autopilot_release_work_order_run() { printf "%s\\n" "$1|$2|$3|$4" >> "$FAKE_RELEASE"; }\n');
  fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({name:'zensu',version:'0.2.0'}));
  sealPackage(plugin);
  const fake = path.join(dir, 'fake-copilot.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
    const fs = require('node:fs');
    const {spawn} = require('node:child_process');
    const args = process.argv.slice(2), mode=process.env.FAKE_MODE || 'success';
    if (args.includes('plugin') && args.includes('list')) {
      if (process.env.FAKE_INVENTORY_ERROR) process.stderr.write(process.env.FAKE_INVENTORY_ERROR);
      process.stdout.write(process.env.FAKE_INVENTORY || '[]');
      process.exit(Number(process.env.FAKE_INVENTORY_STATUS || 0));
    }
    const sid = args[args.indexOf('--session-id')+1];
    const line = m => process.stdout.write(JSON.stringify(m)+'\\n');
    fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(args));
    fs.writeFileSync(process.env.FAKE_ENV, JSON.stringify({host:process.env.ZENSU_RUNTIME_HOST,
      native:process.env.COPILOT_SESSION_ID, bound:process.env.ZENSU_BOUND_SESSION_ID, foreign:process.env.CLAUDE_CODE_SESSION_ID,
      root:process.env.COPILOT_PLUGIN_ROOT, project:process.env.COPILOT_PROJECT_DIR,
      data:process.env.COPILOT_PLUGIN_DATA, nativeData:process.env.COPILOT_PLUGIN_DATA}));
    fs.writeFileSync(process.env.FAKE_PID, String(process.pid));
    if (mode==='empty') process.exit(0);
    if (!['no-init','no-init-error','no-init-mismatch'].includes(mode)) line({type:'session.start',data:{sessionId:mode==='mismatch'?'00000000-0000-0000-0000-000000000000':sid}});
    else line({type:'session.info',data:{infoType:'model',message:'fixture'}});
    line({type:'assistant.message',data:{content:'PRIVATE_TRANSCRIPT '+process.env.ZENSU_SESSION_TOKEN}});
    process.stderr.write(process.env.ZENSU_SESSION_TOKEN.slice(0,8));
    process.stderr.write(process.env.ZENSU_SESSION_TOKEN.slice(8)+'\\n');
    if (mode==='error-zero' || mode==='rate' || mode==='no-init-error') line({type:'session.error', data:{errorType:mode==='rate'?'rate_limit':'authentication',statusCode:mode==='rate'?429:401,message:'private error'}});
    if (mode==='subagent-error') line({type:'session.error',agentId:'child',data:{errorType:'other'}});
    const done = () => {line({type:'result',sessionId:mode==='no-init-mismatch'?'00000000-0000-0000-0000-000000000000':sid,exitCode:mode==='failure'?1:0,
      ...(mode==='blocked'?{outcome:'blocked'}:{})}); process.exit(mode==='failure'?1:0);};
    if (mode==='hang') {
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      fs.writeFileSync(process.env.FAKE_GRANDCHILD,String(child.pid));
      setInterval(()=>{},1000);
    } else if (mode==='linger') setTimeout(done,250);
    else if (mode==='missing-result') process.exit(0);
    else done();
  `, { mode: 0o755 });
  const env = { ...process.env, COPILOT_HOME:path.join(dir,'copilot-home'), ZENSU_SESSION_TOKEN: TOKEN, ZENSU_LAUNCHER_TICK_MS: '50',
    ZENSU_LAUNCHER_STOP_GRACE_MS: '100', FAKE_ARGV: path.join(dir, 'argv.json'),
    FAKE_ENV: path.join(dir, 'env.json'), FAKE_PID: path.join(dir, 'pid'),
    FAKE_GRANDCHILD: path.join(dir, 'grandchild'), FAKE_CALLS: path.join(dir, 'calls.jsonl'),
    FAKE_RELEASE: path.join(dir, 'release.txt') };
  const args = [path.join(plugin, 'harness/launcher.js'), ...required, '--project', path.join(dir, 'project'), '--copilot', fake];
  return { dir, plugin, env, args, run(mode = 'success', extra = [], overrides = {}) {
    return spawnSync(process.execPath, [...args, ...extra], { env: { ...env, FAKE_MODE: mode, ...overrides }, encoding: 'utf8', timeout: 15000 });
  } };
}

function records(output) {
  return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('arguments preserve claim identity and reject host/session overrides', () => {
  assert.equal(launcher.parseLauncherArgs(required).options.order, ORDER);
  for (const extra of [['--session-id', SESSION], ['--output-format=text'], ['--trust-folder'], ['--prompt=other'], ['-pother'], ['--worktree=x'], ['--config-dir=/other'], ['--add-dir=/other']]) {
    assert.match(launcher.parseLauncherArgs([...required, '--', ...extra]).error, /controlled/);
  }
  assert.match(launcher.parseLauncherArgs([...required, '--permission-mode', 'acceptEdits']).error, /unknown/);
  assert.match(launcher.parseLauncherArgs(['--order', ORDER]).error, /session-id/);
  assert.match(launcher.parseLauncherArgs([...required, '--order', ORDER]).error, /repeated/);
});

test('Copilot arguments use JSONL, a local plugin, native skill, and no implicit permission grant', () => {
  const options = launcher.parseLauncherArgs([...required, '--mcp-config', '/tmp/mcp.json', '--', '--allow-tool=read', '--model', 'fixture']).options;
  const args = launcher.copilotArguments(options);
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.equal(args[args.indexOf('--session-id') + 1], SESSION);
  assert.equal(args[args.indexOf('--additional-mcp-config') + 1], '@/tmp/mcp.json');
  assert.deepEqual(args.slice(-2), ['-p', `/zensu-work ${ORDER}`]);
  for (const flag of ['--allow-all', '--allow-all-tools', '--yolo', '--trust-folder', '--verbose', '--strict-mcp-config']) assert.ok(!args.includes(flag));
});

test('translator ignores arbitrary text and child events; terminal result must explicitly succeed', () => {
  assert.equal(launcher.translate({type:'assistant.message',data:{content:'done'}}), null);
  assert.equal(launcher.translate({type:'session.error',agentId:'child',data:{}}), null);
  assert.equal(launcher.translate({type:'session.resume',data:{resumeTime:'2026-10-18T12:00:00Z',eventCount:1}}), null);
  assert.equal(launcher.translate({type:'result',sessionId:SESSION}).isError, true);
  assert.equal(launcher.translate({type:'result',sessionId:SESSION,exitCode:0}).isError, false);
  assert.deepEqual(launcher.translate({type:'session.error',data:{statusCode:429}}), {kind:'error',rateLimited:true,resetAt:null});
});

test('success emits only the two work-order protocol events and binds child environment', (t) => {
  const f = fixture(t), r = f.run('success',[],{CLAUDE_PLUGIN_DATA:'/other/host/data',COPILOT_PLUGIN_DATA:'',PLUGIN_DATA:''});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(records(r.stdout), [{event:'session_started',client_session_id:SESSION}, {event:'exited',status:'success',exit_code:0}]);
  const env = JSON.parse(fs.readFileSync(f.env.FAKE_ENV));
  const data=path.join(f.dir,'copilot-home','zensu','plugin-data');
  assert.deepEqual(env, {host:'copilot',native:SESSION,bound:SESSION,root:f.plugin,project:path.join(f.dir,'project'),data,nativeData:data});
  assert.ok(!r.stdout.includes(TOKEN) && !r.stdout.includes('PRIVATE_TRANSCRIPT'));
  assert.equal(f.run('success',[],{COPILOT_PLUGIN_DATA:'/fixture/copilot-data'}).status,0);
  const dataEnv=JSON.parse(fs.readFileSync(f.env.FAKE_ENV));
  assert.equal(dataEnv.data,'/fixture/copilot-data');
  assert.equal(dataEnv.nativeData,'/fixture/copilot-data');
});

function installedFixture(f, marketplace = '') {
  const root = path.join(f.env.COPILOT_HOME, 'installed-plugins', marketplace || '_direct', 'zensu');
  fs.mkdirSync(path.dirname(root), {recursive:true});
  fs.cpSync(f.plugin, root, {recursive:true});
  const entry = {name:'zensu', marketplace, version:'0.2.0', enabled:true, source:'installed'};
  return {root, entry, env:{FAKE_INVENTORY:JSON.stringify([entry])}};
}

test('matching installed package is loaded once with its installed runtime root', (t) => {
  for (const marketplace of ['', 'team']) {
    const f = fixture(t), installed = installedFixture(f, marketplace);
    const result = f.run('success', [], installed.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(f.env.FAKE_ARGV)).includes('--plugin-dir'), false);
    assert.equal(JSON.parse(fs.readFileSync(f.env.FAKE_ENV)).root, installed.root);
  }
});

test('different installed bytes, including an unchanged version, require reinstall before spawning', (t) => {
  for (const change of ['version', 'content', 'untracked', 'tampered-receipt']) {
    const f = fixture(t), installed = installedFixture(f);
    if (change === 'version') {
      fs.writeFileSync(path.join(installed.root, 'plugin.json'), JSON.stringify({name:'zensu',version:'0.1.0'}));
      installed.entry.version = '0.1.0';
    } else if (change === 'untracked') fs.writeFileSync(path.join(installed.root, 'surprise.sh'), 'exit 0');
    else fs.appendFileSync(path.join(installed.root, 'hooks/lib/work-order-v1.js'), '\n// Different runtime.\n');
    if (change !== 'tampered-receipt' && change !== 'untracked') sealPackage(installed.root);
    const result = f.run('success', [], {FAKE_INVENTORY:JSON.stringify([installed.entry])});
    assert.equal(result.status, 2, change);
    assert.match(result.stderr, /reinstall/);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(f.env.FAKE_PID), false);
  }
});

test('explicit plugin directory uses the same installation conflict checks and absolute root', (t) => {
  const f = fixture(t), copy = path.join(f.dir, 'explicit');
  fs.cpSync(f.plugin, copy, {recursive:true});
  const first = f.run('success', ['--plugin-dir', copy]);
  assert.equal(first.status, 0, first.stderr);
  const args = JSON.parse(fs.readFileSync(f.env.FAKE_ARGV));
  assert.equal(args[args.indexOf('--plugin-dir') + 1], copy);
  const installed = installedFixture(f);
  const same = f.run('success', ['--plugin-dir', copy], installed.env);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.env.FAKE_ARGV)).includes('--plugin-dir'), false);
  fs.appendFileSync(path.join(copy, 'harness/launcher.js'), '\n// Alternate build.\n');
  sealPackage(copy);
  assert.equal(f.run('success', ['--plugin-dir', copy], installed.env).status, 2);
});

test('disabled, duplicate, unknown, broken, and redirected plugin inventories fail closed', (t) => {
  const cases = [
    {entry:{enabled:false}, pattern:/disabled/},
    {duplicate:true, pattern:/multiple/},
    {entry:{source:'live'}, pattern:/source/},
    {entry:{marketplace:'../other'}, pattern:/location/},
    {entry:{enabled:null}, pattern:/format/},
    {inventory:'{}', pattern:/format/},
    {inventory:'not json', pattern:/format/},
    {env:{FAKE_INVENTORY_STATUS:'1'}, pattern:/inventory/},
    {env:{FAKE_INVENTORY_ERROR:TOKEN}, pattern:/inventory/},
    {env:{COPILOT_PLUGIN_DIR_ONLY:'true'}, pattern:/COPILOT_PLUGIN_DIR_ONLY/},
    {symlink:true, pattern:/cannot be verified/},
  ];
  for (const scenario of cases) {
    const f = fixture(t), installed = installedFixture(f);
    Object.assign(installed.entry, scenario.entry);
    if (scenario.symlink) {
      fs.rmSync(installed.root, {recursive:true});
      fs.symlinkSync(f.plugin, installed.root);
    }
    const result = f.run('success', [], {...installed.env,
      FAKE_INVENTORY:scenario.inventory || JSON.stringify(scenario.duplicate ? [installed.entry, installed.entry] : [installed.entry]),
      ...scenario.env});
    assert.equal(result.status, 2, JSON.stringify(scenario));
    assert.match(result.stderr, scenario.pattern);
    assert.ok(!result.stderr.includes(TOKEN));
    assert.equal(fs.existsSync(f.env.FAKE_PID), false);
  }
});

test('error events, blocked result, incomplete output and mismatched session cannot produce success', (t) => {
  const f = fixture(t);
  for (const [mode, reason] of [['error-zero','harness_error'], ['blocked','harness_error'],
    ['empty','incomplete_stream'], ['missing-result','incomplete_stream'], ['mismatch','session_mismatch'], ['failure','harness_error']]) {
    const r=f.run(mode), last=records(r.stdout).at(-1);
    assert.equal(r.status, 1, `${mode}: ${r.stderr}`);
    assert.equal(last.status,'failure',mode);
    assert.equal(last.reason,reason,mode);
  }
  assert.equal(f.run('subagent-error').status, 0);
});

test('native terminal result proves identity when Copilot attaches stdout after session.start', (t) => {
  const f=fixture(t), r=f.run('no-init');
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(records(r.stdout),[{event:'session_started',client_session_id:SESSION},{event:'exited',status:'success',exit_code:0}]);
  const failed=f.run('no-init-error');
  assert.equal(failed.status,1);
  assert.equal(records(failed.stdout).at(-1).reason,'harness_error');
  const mismatch=f.run('no-init-mismatch');
  assert.equal(mismatch.status,1);
  assert.equal(records(mismatch.stdout).length,1);
  assert.equal(records(mismatch.stdout)[0].reason,'session_mismatch');
});

test('rate-limit error emits normalized rate_limited with no invented reset time', (t) => {
  const r=fixture(t).run('rate');
  assert.equal(r.status,1);
  assert.deepEqual(records(r.stdout)[1], {event:'rate_limited',reset_at:null});
});

test('opt-in log is private, redacts split stdout/stderr tokens, and refuses symlinks', (t) => {
  const f=fixture(t), log=path.join(f.dir,'child.log');
  fs.writeFileSync(log,'existing\n', {mode:0o644});
  const r=f.run('success',['--log',log]);
  assert.equal(r.status,0,r.stderr);
  const text=fs.readFileSync(log,'utf8');
  assert.ok(text.includes('PRIVATE_TRANSCRIPT') && text.includes('[REDACTED]'));
  assert.ok(!text.includes(TOKEN));
  assert.equal(fs.statSync(log).mode & 0o777,0o600);
  const link=path.join(f.dir,'link.log');fs.symlinkSync(log,link);
  assert.equal(f.run('success',['--log',link]).status,2);
});

test('missing session token and unavailable executable fail without exposing credentials', (t) => {
  const f=fixture(t);
  const missing=f.run('success',[],{ZENSU_SESSION_TOKEN:''});
  assert.equal(missing.status,2); assert.equal(missing.stdout,'');
  const args=f.args.slice();args[args.indexOf('--copilot')+1]=path.join(f.dir,'missing');
  const r=spawnSync(process.execPath,args,{env:f.env,encoding:'utf8',timeout:15000});
  assert.equal(r.status,1);
  assert.deepEqual(records(r.stdout),[{event:'exited',status:'failure',exit_code:null,reason:'harness_unavailable'}]);
});

test('watchdog uses the Copilot claim, one-third renewal threshold and releases the prior attempt', (t) => {
  const f=fixture(t), r=f.run('linger',[],{FAKE_LEASE:'active'});
  assert.equal(r.status,0,r.stderr);
  const calls=records(fs.readFileSync(f.env.FAKE_CALLS,'utf8'));
  assert.ok(calls.some((c)=>c.type==='renew' && c.thresholdMs===4000));
  assert.ok(calls.filter((c)=>c.type==='context').every((c)=>c.sessionKey===`copilot:${SESSION}` && c.host==='copilot'));
  assert.ok(calls.some((c)=>c.type==='releasePlan' && c.order===ORDER && c.below===3));
  assert.equal(fs.readFileSync(f.env.FAKE_RELEASE,'utf8'),`run_fixture|${ORDER}|3|${path.join(f.dir,'project')}\n`);
});

test('lease loss terminates the owned child and reports lease_lost', (t) => {
  const f=fixture(t), r=f.run('hang',[],{FAKE_LEASE:'lost'});
  assert.equal(r.status,1,r.stderr);
  assert.equal(records(r.stdout).at(-1).reason,'lease_lost');
  const pid=Number(fs.readFileSync(f.env.FAKE_PID,'utf8'));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('SIGTERM cancels and terminates the child process group', async (t) => {
  const f=fixture(t);
  const child=spawn(process.execPath,f.args,{env:{...f.env,FAKE_MODE:'hang'},stdio:['ignore','pipe','pipe']});
  let output='', error='';child.stdout.on('data',(chunk)=>{output+=chunk});child.stderr.on('data',(chunk)=>{error+=chunk});
  const done=new Promise((resolve)=>child.once('close',(code)=>resolve(code)));
  const deadline=Date.now()+5000;
  while ((!output.includes('session_started') || !fs.existsSync(f.env.FAKE_GRANDCHILD)) && Date.now()<deadline) await new Promise((resolve)=>setTimeout(resolve,20));
  child.kill('SIGTERM');
  const code=await done;
  assert.equal(code,143,error);
  assert.equal(records(output).at(-1).status,'cancelled');
  for (const file of [f.env.FAKE_PID,f.env.FAKE_GRANDCHILD]) {
    const pid=Number(fs.readFileSync(file,'utf8'));
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }
});
