'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const repo = path.resolve(__dirname, '../..');
const core = require('../../src/plugin/hooks/lib/session-control-core-v1');
const auto = require('../../src/plugin/hooks/lib/session-auto-adopt-v1');
const sweep = require('../../src/plugin/hooks/lib/review-evidence-sweep-v1');
const recoveryInvocation = require('../../src/plugin/hooks/lib/zensu-doctor-invocation');

function seal(root) {
  const files = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else if (name !== 'build.json') files.push({target:path.relative(root, file).split(path.sep).join('/'),
        sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
    }
  }
  visit(root);
  fs.writeFileSync(path.join(root, 'build.json'), JSON.stringify({schemaVersion:2, host:'copilot',
    version:JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'))).version, files}));
}

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-runtime-adoption-')));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const root = path.join(dir, 'installed-plugins/_direct/zensu');
  fs.cpSync(path.join(repo, 'src/plugin'), root, {recursive:true});
  fs.mkdirSync(path.join(root, 'hooks/native'), {recursive:true});
  for (const name of ['dispatcher', 'protocol', 'context', 'approval', 'helper', 'transcript', 'review-gate', 'ai-work']) fs.copyFileSync(path.join(repo, `src/${name}.js`), path.join(root, `hooks/native/${name}.js`));
  seal(root);
  const project = path.join(dir, 'project'), data = path.join(dir, 'data');
  fs.mkdirSync(project, {mode:0o700});
  // Native Copilot creates the host container as 0755, with private owned
  // session-control descendants. Keep the fixture faithful to that boundary.
  fs.mkdirSync(data, {mode:0o755});
  fs.chmodSync(data, 0o755);
  let recordDir = data;
  for (const segment of ['session-control', 'v1', 'records']) { recordDir=path.join(recordDir,segment); fs.mkdirSync(recordDir,{mode:0o700}); }
  const id=crypto.randomUUID(), options={recordsDir:recordDir, sessionId:id, host:'copilot', pluginData:data, executingPluginRoot:root};
  core.registerContext({...options, projectRoot:project, pluginRoot:root});
  core.initializeWorkflowState({projectRoot:project, sessionId:id});
  core.mutateWorkflowState({projectRoot:project, sessionId:id, workflowState:'review', event:'fixture-pending'}, state => {
    state.active=true; state.implComplete=true; state.chainDone=false; state.codeReviewDone=false;
    state.reviewTicket='pending-review-ticket'; state.reviewTicketConsumed=false; state.phase='REVIEW'; return state;
  });
  const record=path.join(recordDir, `${core.sessionKey(id)}.json`), workflow=core.adoptionWorkflowStatePath(project,id);
  const original=fs.readFileSync(record), workflowBytes=fs.readFileSync(workflow);
  const upgrade=() => { fs.appendFileSync(path.join(root,'hooks/native/protocol.js'), '\n// Native in-place package update fixture.\n'); seal(root); };
  const report=confirm => spawnSync('bash', [path.join(root,'hooks/lib/zensu-session-adopt.sh'), ...(confirm?['--confirm']:[])], {
    cwd:project, encoding:'utf8', env:{...process.env, COPILOT_SESSION_ID:id, ZENSU_BOUND_SESSION_ID:id,
      COPILOT_PLUGIN_ROOT:root, COPILOT_PLUGIN_DATA:data, PLUGIN_ROOT:root, COPILOT_PROJECT_DIR:project}, timeout:15000});
  return {dir,root,project,data,id,options,record,workflow,original,workflowBytes,upgrade,report};
}

test('same-path changed native package stays denied by strict reads and automatic adoption', t => {
  const f=fixture(t); f.upgrade();
  assert.throws(()=>core.readContext({...f.options,expectedHost:'copilot'}), /runtime digest mismatch/);
  assert.equal(core.adoptableRecord(f.options).reason, 'record-unreadable');
  assert.equal(auto.adoptForHook({...f.options, environment:{}, respectOptOut:false}).outcome, 'refused');
  const preview=core.previewInPlaceRuntimeAdoption(f.options);
  assert.equal(preview.ok,true,preview.cause);
  assert.throws(()=>core.adoptInPlaceRuntimeContext({...f.options,expected:preview}), /explicit.*confirmation/);
  const result=f.report(false);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/explicit confirmation required/);
  assert.match(result.stdout,/old runtime\nbytes cannot be checked/);
  assert.deepEqual(fs.readFileSync(f.record),f.original);
  assert.deepEqual(fs.readFileSync(f.workflow),f.workflowBytes);
});

test('confirmed same-version native package update preserves the entire pending workflow and record identity', t => {
  const f=fixture(t); f.upgrade();
  const result=f.report(true);
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  assert.match(result.stdout,/Runtime binding updated/);
  const before=JSON.parse(f.original), after=core.readContext({...f.options,expectedHost:'copilot'});
  assert.notEqual(after.runtime_digest,before.runtime_digest);
  assert.equal(after.source_revision,after.runtime_digest);
  assert.deepEqual({...after,source_revision:before.source_revision,runtime_digest:before.runtime_digest},before);
  assert.deepEqual(fs.readFileSync(f.workflow),f.workflowBytes);
  const archived=path.join(f.options.recordsDir,`${core.sessionKey(f.id)}.runtime-${before.runtime_digest.slice(7)}.json`);
  assert.deepEqual(fs.readFileSync(archived),f.original);
  assert.equal(core.readWorkflowState({projectRoot:f.project,sessionId:f.id}).chainDone,false);
  assert.equal(core.previewInPlaceRuntimeAdoption(f.options).ok,false);
  const retry=f.report(true);
  assert.equal(retry.status,0,retry.stderr+'\n'+retry.stdout);
  assert.deepEqual(fs.readFileSync(f.workflow),f.workflowBytes);
  assert.deepEqual(fs.readFileSync(archived),f.original);
});

test('native preToolUse keeps the exact manual repair reachable only for the main agent', t => {
  const f=fixture(t); f.upgrade();
  const run=(command, child=false, skill) => spawnSync(process.execPath,[path.join(f.root,'hooks/native/dispatcher.js'),'preToolUse'], {
    cwd:f.project,encoding:'utf8',timeout:20000,
    env:{...process.env,COPILOT_PLUGIN_ROOT:f.root,PLUGIN_ROOT:f.root,COPILOT_PLUGIN_DATA:f.data,
      COPILOT_HOME:path.join(f.dir,'copilot'),COPILOT_PROJECT_DIR:f.project},
    input:JSON.stringify({sessionId:f.id,timestamp:Date.now(),cwd:f.project,toolName:skill?'skill':'bash',
      toolArgs:skill?{skill}:{command,description:'Inspect native session recovery'},
      ...(child?{agentId:'review-child',agentType:'zensu:review-aspect',parentAgentId:f.id}:{} )})});
  const adopt='bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-session-adopt.sh"';
  let confirmation;
  for(const command of [adopt,adopt+' --confirm',
    'COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" COPILOT_PROJECT_DIR="${COPILOT_PROJECT_DIR}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-doctor.sh"']) {
    const main=run(command);assert.equal(main.status,0,main.stderr);
    const decision=JSON.parse(main.stdout);
    assert.notEqual(decision.permissionDecision,'deny',main.stdout);
    assert.match(decision.modifiedArgs.command, /^# zensu-copilot-context-v1\nexport /);
    if(command.endsWith('--confirm')) confirmation=decision.modifiedArgs.command;
  }
  for(const skill of ['zensu-adopt-session','zensu-doctor']) {
    const result=run(null,false,skill); assert.equal(result.status,0,result.stderr);
    assert.notEqual(JSON.parse(result.stdout).permissionDecision,'deny',result.stdout);
  }
  const child=run(adopt+' --confirm',true);assert.equal(child.status,0,child.stderr);
  assert.equal(JSON.parse(child.stdout).permissionDecision,'deny',child.stdout);
  const childSkill=run(null,true,'zensu-adopt-session');assert.equal(childSkill.status,0,childSkill.stderr);
  assert.equal(JSON.parse(childSkill.stdout).permissionDecision,'deny',childSkill.stdout);
  const compound=run(adopt+' --confirm; touch forbidden');assert.equal(compound.status,0,compound.stderr);
  assert.equal(JSON.parse(compound.stdout).permissionDecision,'deny',compound.stdout);
  assert.deepEqual(fs.readFileSync(f.record),f.original);
  assert.deepEqual(fs.readFileSync(f.workflow),f.workflowBytes);
  // Execute the actual modified native Bash arguments only in this synthetic
  // fixture, proving the bound variables resolve to the recognized installation.
  const executed=spawnSync('bash',['-c',confirmation],{cwd:f.project,env:process.env,encoding:'utf8',timeout:15000});
  assert.equal(executed.status,0,executed.stderr+'\n'+executed.stdout);
  assert.match(executed.stdout,/Runtime binding updated/);
  assert.deepEqual(fs.readFileSync(f.workflow),f.workflowBytes);
  assert.doesNotThrow(()=>core.readContext({...f.options,expectedHost:'copilot'}));
});

test('native recovery command grammar rejects shell expansion, selector changes and appended commands', () => {
  const root=path.join(repo,'src/plugin'), id=crypto.randomUUID();
  const env={ZENSU_RUNTIME_HOST:'copilot',ZENSU_BOUND_SESSION_ID:id,COPILOT_SESSION_ID:id,
    COPILOT_PLUGIN_ROOT:root,COPILOT_PLUGIN_DATA:'/fixture/data',COPILOT_PROJECT_DIR:'/fixture/project'};
  const base='bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-session-adopt.sh"';
  const check=(command,environment=env)=>recoveryInvocation.recognizeScript(
    {sessionId:id,toolName:'bash',toolArgs:{command}},root,recoveryInvocation.RECOGNIZED.adopt,environment).ok;
  assert.equal(check(base+' --confirm'),true);
  assert.equal(check(base,{}),false);
  assert.equal(check(base,{...env,COPILOT_SESSION_ID:'foreign'}),false);
  for(const command of [base+'; touch /tmp/no',base+' && echo no',base+' | cat',base+'\necho no',base+' --confirm > /tmp/no',
    base+'$(touch /tmp/no)',base+' `id`',base+' "$@"',base+' --confirm --confirm',
    'COPILOT_PLUGIN_ROOT=/tmp '+base,'COPILOT_SESSION_ID=foreign '+base,
    'COPILOT_PLUGIN_DATA="${COPILOT_PROJECT_DIR}" '+base,
    'COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" '+base,
    'bash "${HOME}/hooks/lib/zensu-session-adopt.sh"',
    'bash "${COPILOT_PLUGIN_ROOT}/../other/hooks/lib/zensu-session-adopt.sh"',
    "bash '${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-session-adopt.sh'",
    'env '+base, 'bash -c '+base]) assert.equal(check(command),false,command);
  assert.equal(recoveryInvocation.isRecoverySkillInvocation({sessionId:id,toolName:'skill',toolArgs:{skill:'zensu-tdd'}},root,env),false);
  assert.equal(recoveryInvocation.isRecoverySkillInvocation({sessionId:id,toolName:'skill',toolArgs:{skill:'zensu-adopt-session',args:'--confirm'}},root,env),false);
});

test('confirmation uses record, workflow and new-package CAS snapshots', t => {
  for (const changed of ['record','workflow','package']) {
    const f=fixture(t); f.upgrade();
    const preview=core.previewInPlaceRuntimeAdoption(f.options); assert.equal(preview.ok,true,preview.cause);
    if(changed==='record') {const value=JSON.parse(f.original);value.created_at='2026-01-01T00:00:00.000Z';fs.writeFileSync(f.record,JSON.stringify(value));}
    if(changed==='workflow') core.mutateWorkflowState({projectRoot:f.project,sessionId:f.id,workflowState:'review',event:'fixture-race'}, state=>state);
    if(changed==='package') {fs.appendFileSync(path.join(f.root,'hooks/native/protocol.js'),'\n// Another update.\n');seal(f.root);}
    const before=fs.readFileSync(f.record), workflow=fs.readFileSync(f.workflow);
    assert.throws(()=>core.adoptInPlaceRuntimeContext({...f.options,expected:preview,confirm:true}),/changed since preview|CAS mismatch/);
    assert.deepEqual(fs.readFileSync(f.record),before);
    assert.deepEqual(fs.readFileSync(f.workflow),workflow);
  }
});

test('native 0755 data container is allowed but group-writable container refuses recovery', t => {
  const f=fixture(t); f.upgrade();
  assert.equal(fs.statSync(f.data).mode & 0o777,0o755);
  const preview=core.previewInPlaceRuntimeAdoption(f.options);
  assert.equal(preview.ok,true,preview.cause);
  fs.chmodSync(f.data,0o775);
  const refused=core.previewInPlaceRuntimeAdoption(f.options);
  assert.equal(refused.ok,false);
  assert.match(refused.cause,/private record store is unsafe/);
  assert.throws(()=>core.adoptInPlaceRuntimeContext({...f.options,expected:preview,confirm:true}),/private record store is unsafe/);
  const report=f.report(true);
  assert.notEqual(report.status,0,report.stdout);
  assert.doesNotMatch(report.stdout,/Runtime binding updated/);
  assert.deepEqual(fs.readFileSync(f.record),f.original);
  assert.deepEqual(fs.readFileSync(f.workflow),f.workflowBytes);
});

test('unknown, malformed, tampered and aliased private bindings remain refused', t => {
  for(const changed of ['session','source','profile','unknown','timestamp','record-mode','store-mode','link','workflow','project']) {
    const f=fixture(t); f.upgrade();
    const record=JSON.parse(f.original);
    if(changed==='session')record.session_id_hash='sha256:'+'f'.repeat(64);
    if(changed==='source')record.source_revision='sha256:'+'f'.repeat(64);
    if(changed==='profile')record.principal_profiles.host='main-v1';
    if(changed==='unknown')record.untrusted=true;
    if(changed==='timestamp')record.created_at='invalid';
    if(changed==='project')record.project_root=f.project+'/.';
    fs.writeFileSync(f.record,JSON.stringify(record));
    if(changed==='record-mode')fs.chmodSync(f.record,0o644);
    if(changed==='store-mode')fs.chmodSync(f.options.recordsDir,0o755);
    if(changed==='link'){const copy=f.record+'.original';fs.renameSync(f.record,copy);fs.symlinkSync(copy,f.record);}
    if(changed==='workflow')fs.writeFileSync(f.workflow,'{}');
    assert.equal(core.previewInPlaceRuntimeAdoption(f.options).ok,false,changed);
    const result=f.report(true);assert.notEqual(result.status,0,changed);
    assert.doesNotMatch(result.stdout,/Runtime binding updated/,changed);
  }
});

test('new runtime must be a complete native build at the same root and compatible version', t => {
  for(const changed of ['tamper','extra','missing','symlink','downgrade','breaking','foreign-root','foreign-data','derived-id']) {
    const f=fixture(t); f.upgrade();const options={...f.options};
    if(changed==='tamper')fs.appendFileSync(path.join(f.root,'hooks/native/protocol.js'),'tamper');
    if(changed==='extra')fs.writeFileSync(path.join(f.root,'undeclared.js'),'tamper');
    if(changed==='missing')fs.unlinkSync(path.join(f.root,'hooks/native/dispatcher.js'));
    if(changed==='symlink'){const file=path.join(f.root,'hooks/native/protocol.js');fs.renameSync(file,file+'.real');fs.symlinkSync(file+'.real',file);}
    if(changed==='downgrade'||changed==='breaking'){const file=path.join(f.root,'plugin.json');const v=JSON.parse(fs.readFileSync(file));v.version=changed==='downgrade'?'0.1.9':'0.3.0';fs.writeFileSync(file,JSON.stringify(v));seal(f.root);}
    if(changed==='foreign-root'){const copy=path.join(f.dir,'other');fs.cpSync(f.root,copy,{recursive:true});options.executingPluginRoot=copy;}
    if(changed==='foreign-data')options.pluginData=f.project;
    if(changed==='derived-id')options.sessionId=core.sessionKey(f.id);
    assert.equal(core.previewInPlaceRuntimeAdoption(options).ok,false,changed);
    assert.deepEqual(fs.readFileSync(f.record),f.original);
    assert.deepEqual(fs.readFileSync(f.workflow),f.workflowBytes);
  }
});

test('digest-aware lease cleanup archives old same-path leases and retains new runtime leases', t => {
  const f=fixture(t), key=core.sessionKey(f.id);
  const records=path.join(f.data,'review-evidence/v1/records',key); fs.mkdirSync(records,{recursive:true,mode:0o700});
  const oldDigest=JSON.parse(f.original).runtime_digest;
  f.upgrade();const preview=core.previewInPlaceRuntimeAdoption(f.options); assert.equal(preview.ok,true,preview.cause);
  const next=preview.runtime.digest;
  // This sweep deliberately checks the lease owner's identity predicate only;
  // it does not grant validity or successful evidence to either fixture record.
  const oldId='rel1_'+'a'.repeat(32), currentId='rel1_'+'b'.repeat(32);
  for(const [id,digest] of [[oldId,oldDigest],[currentId,next]])fs.writeFileSync(path.join(records,id+'.json'),JSON.stringify({lease_id:id,plugin_root:f.root,project_root:f.project,runtime_digest:digest}),{mode:0o600});
  const result=sweep.discardSupersededLeases(f.data,key,f.root,f.project,next);
  assert.equal(result.unsafe,'');assert.deepEqual(result.failed,[]);
  assert.equal(result.discarded,1);
  assert.equal(fs.existsSync(path.join(records,oldId+'.json')),false);
  assert.equal(fs.existsSync(path.join(records,currentId+'.json')),true);
  assert.deepEqual(fs.readFileSync(f.workflow),f.workflowBytes);
});
