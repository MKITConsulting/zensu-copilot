import pathlib,json,subprocess,os,hashlib
r=pathlib.Path(__file__).parent
p=r/'project'
metadata=json.loads((r/'harness.json').read_text())
expected='sha256:'+hashlib.sha256(b'zensu.session-control/v1/session-id\0'+metadata['sessionId'].encode()).hexdigest()
states=[json.loads(f.read_text()) for f in (p/'.zensu/state').glob('tdd-phase-*.json')]
matching=[state for state in states if state.get('session_id_hash')==expected]
assert len(matching)==1, 'Expected exactly one state for the fresh main session'
state=matching[0]
assert state.get('chainDone') and state.get('codeReviewDone') and state.get('reviewTicketConsumed'), 'Workflow is still open or its review is incomplete'
base=r/'independent-consumer'; base.mkdir(exist_ok=True)
packages=base/'packages'; packages.mkdir(exist_ok=True)
consumer=base/'consumer'; consumer.mkdir(exist_ok=True)
env=os.environ.copy(); env['npm_config_cache']=str(base/'npm-cache')
commands=[]
def run(args,cwd):
 x=subprocess.run(args,cwd=cwd,env=env,capture_output=True,text=True)
 commands.append({'args':args,'exitCode':x.returncode,'stdout':x.stdout,'stderr':x.stderr})
 if x.returncode: raise RuntimeError(x.stdout+x.stderr)
 return x
pack=run(['npm','pack','--ignore-scripts','--json','--pack-destination',str(packages)],p)
filename=json.loads(pack.stdout)[0]['filename']
run(['npm','install','--offline','--ignore-scripts','--no-audit','--no-fund','--prefix',str(consumer),str(packages/filename)],p)
entry=consumer/'node_modules/zensu-live-invoice/dist/index.js'
bin=consumer/'node_modules/.bin/invoice-quote'
run(['node',str(r/'independent-check.mjs'),str(entry),str(bin)],p)
result=json.loads((r/'independent-check.json').read_text())
result['packagedInstallCommands']=commands[:2]
result['testedHashes']={}
for name in ['index.js','cli.js']:
 source=p/'src'/name; installed=entry.parent/name
 sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
 result['testedHashes'][name]={'source':sha(source),'installed':sha(installed),'equal':sha(source)==sha(installed)}
 assert result['testedHashes'][name]['equal']
result['packageTarballSha256']=hashlib.sha256((packages/filename).read_bytes()).hexdigest()
result['packageTarball']=str(packages/filename)
(r/'independent-check.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'status':result['status'],'checks':len(result['checks']),'testedHashes':result['testedHashes']}))
