/** Independent fixture-only service QA. Integrate as tests/package-service-acceptance.test.ts.
 * Prepared against accepted revision 2 and the coordinator's confirmed service API.
 * NOT EXECUTED: coordinator must integrate before running. Relative imports target tests/.
 * No installed-package discovery, real executor/process/group or runtime durability claim.
 * S14 intentionally covers 20 service semantic faults; primitive substeps have separate QA.
 * Capacity reserves every proven declaration; historical child directory metadata is validated, not contents.
 * Integration seams: literal hook names/ordinals below must be reached, never silently skipped.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, mock, test, type TestContext } from 'node:test';
import { ToolError } from '../src/errors.ts';
import { parseJsonBytes } from '../src/json.ts';
import { ledgerBytes, parseAttempt, parseLedger, type PackageExit, type PackageLedger } from '../src/package-attempt.ts';
import { MIB, TOOL_ID, packageIdentity, type PackageDecl, type Platform } from '../src/schema.ts';
import { applyRestore, inspectRestore, resolveRestore, rollbackRestore, runPackageAttempts, type TxOptions } from '../src/transaction.ts';
import { dirId, fileId, type PackageExecutor, type PackageSpawnSpec, type PidProbe, type TxDeps } from '../src/transaction-fs.ts';

const BOOT='11111111-2222-4333-8444-555555555555', OTHER='99999999-2222-4333-8444-555555555555';
const PLAN=`sha256:${'a'.repeat(64)}`, PKG=`sha256:${'b'.repeat(64)}`, OLD=`sha256:${'c'.repeat(64)}`;
const GOOD:PackageExit={code:0,signal:null,stdoutBytes:0,stderrBytes:0,timedOut:false,overflow:false};
const DECLS:PackageDecl[]=['npm:qa-one',{source:'npm:qa-two',autoload:false,extensions:[],skills:['+skills/a','-skills/b']}];
const PRIVATE='QA_PRIVATE_EXECUTOR_SENTINEL_927183';
type Locked={tx:string;planToken:string;packages:readonly PackageDecl[]};
type ServiceOptions=TxOptions & {expectedTargets:{agent:string;lens:string|null};packageToken:string;
  protectedRoots:readonly string[];verifyLockedPackageIntent:(locked:Locked)=>string};
const mocks:{mock:{restore():void;calls:readonly unknown[]}}[]=[];
beforeEach(()=>{
  mocks.push(mock.method(process,'kill',()=>assert.fail('real process operation forbidden')));
  for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'] as const)
    mocks.push(mock.method(childProcess,key,()=>assert.fail('real child process forbidden')));
  syncBuiltinESMExports();
});
afterEach(()=>{const list=mocks.splice(0).reverse();try {for(const m of list)assert.equal(m.mock.calls.length,0,'no real process API even if caught');}
  finally {for(const m of list)m.mock.restore();syncBuiltinESMExports();}});
function deferred<T>() { let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;
  const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
function fixed(e:unknown,code?:string):e is ToolError {
  assert.ok(e instanceof ToolError); assert.match(e.code,/^[a-z][a-z0-9-]{0,63}$/);
  assert.equal(e.message,e.code); assert.ok(e.exit===1||e.exit===2);
  assert.ok(!JSON.stringify(e).includes(PRIVATE)); if(code)assert.equal(e.code,code); return true;
}
async function refused(fn:()=>unknown,code?:string) { await assert.rejects(async()=>{await fn();},e=>fixed(e,code)); }
function snapshot(root:string):Map<string,string> {
  const out=new Map<string,string>();
  function visit(p:string) { const s=fs.lstatSync(p,{bigint:true});
    const id=[s.dev,s.ino,s.birthtimeNs,s.mode,s.uid,s.gid];
    if(!s.isDirectory())id.push(s.ctimeNs,s.mtimeNs,s.nlink,s.size);
    const body=s.isSymbolicLink()?fs.readlinkSync(p):s.isFile()?fs.readFileSync(p).toString('base64'):'';
    out.set(path.relative(root,p)||'.',`${s.isDirectory()?'d':s.isFile()?'f':'x'}:${id.join(':')}:${body}`);
    if(s.isDirectory())for(const n of fs.readdirSync(p).sort())visit(path.join(p,n));
  } visit(root); return out;
}
function fixture(t:TestContext,decls:PackageDecl[]=DECLS) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pmc-service-qa-')));
  t.after(()=>{fs.rmSync(root,{recursive:true,force:true});assert.ok(!fs.existsSync(root));});
  const home=path.join(root,'home');fs.mkdirSync(home);
  const state=path.join(root,'state'),agent=path.join(root,'agent');
  const deps:TxDeps={platform:process.platform,uid:()=>process.getuid!(),pid:()=>4_000_001,
    bootId:()=>BOOT,hostname:()=> 'qa-host',probePid:()=> 'esrch',probeGroup:()=> 'unknown',
    packageExecutor:null,randomHex:n=>crypto.randomBytes(n).toString('hex'),fault:()=>{}};
  const common:TxOptions={env:{},guard:{home},deps,expectedTargets:{agent,lens:null}};
  const bytes=Buffer.from('# Fixture instructions\n');
  const applied=applyRestore({planToken:PLAN,platform:process.platform as Platform,state,agentTarget:agent,
    lensTarget:null,settings:{theme:'dark'},packages:decls,protectedRoots:[],files:[{root:'agent',path:'AGENTS.md',
      class:'agent-context',bytes,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}]},common);
  const name=(n:string)=>path.join(state,n), original=snapshot(agent);
  const journal=fs.readFileSync(name('journal.json'));
  const opts:ServiceOptions={...common,expectedTargets:{agent,lens:null},packageToken:PKG,protectedRoots:[],
    verifyLockedPackageIntent(locked) {
      assert.deepEqual(structuredClone(locked),{tx:applied.tx,planToken:PLAN,packages:decls});
      assert.equal((parseJsonBytes(fs.readFileSync(name('lock.json'))) as any).kind,'pi-machine-config/package-lock');
      return PKG;
    }};
  return {root,home,state,agent,tx:applied.tx,deps,common,opts,decls,name,original,journal};
}
type Fx=ReturnType<typeof fixture>;
function unchanged(f:Fx) { assert.deepEqual(snapshot(f.agent),f.original); assert.deepEqual(fs.readFileSync(f.name('journal.json')),f.journal); }
function ledger(f:Fx) {return parseLedger(fs.readFileSync(f.name('package-ledger.json')));}
function gate(f:Fx) {return parseAttempt(fs.readFileSync(f.name('package-attempt.json')));}
function nonLockState(f:Fx) { const s=snapshot(f.state); s.delete('lock.json');return s; }
function successfulSyncTrace(t:TestContext,f:Fx) {
  const timeline:string[]=[],sync=fs.fsyncSync,id=dirId(fs.lstatSync(f.state,{bigint:true}));
  t.mock.method(fs,'fsyncSync',(fd:number)=>{sync(fd);const s=fs.fstatSync(fd,{bigint:true});
    if(!s.isDirectory()||s.dev.toString()!==id.dev||s.ino.toString()!==id.ino)return;
    if(fs.existsSync(f.name('package-ledger.json'))) {const l=ledger(f);timeline.push(`sync:ledger:${l.runs.at(-1)?.state}:${l.nextSeq}:${l.attempts.at(-1)?.outcome?.code??'none'}`);
      if(!fs.existsSync(f.name('package-attempt.json')))timeline.push(`sync:gate-absent:${l.nextSeq}`);}
    if(fs.existsSync(f.name('package-attempt.json'))) {const a=gate(f);timeline.push(`sync:attempt:${a.seq}:${a.phase}`);}
    if(!fs.existsSync(f.name('lock.json')))timeline.push('sync:lock-absent');
  });return timeline;
}
function driver(f:Fx,exits:PackageExit[]=[GOOD],fault:(point:string)=>void=()=>{},timeline:string[]=[]) {
  const requests:PackageSpawnSpec[]=[],events:string[]=[],groups:number[]=[];let probes=0;
  const executor:PackageExecutor=spec=>{const a=gate(f),l=ledger(f);assert.equal(a.phase,'intent');assert.equal(a.source,spec.source);
    assert.equal(l.runs.at(-1)?.state,'open');assert.equal(l.attempts.at(-1)?.seq,a.seq);assert.equal(l.attempts.at(-1)?.source,spec.source);
    assert.deepEqual({...l.runs.at(-1)!.lock},fileId(fs.lstatSync(f.name('lock.json'),{bigint:true})));
    timeline.push(`spawn:${requests.length}`);requests.push(structuredClone(spec));return {pid:4_100_001+requests.length,exit:Promise.resolve(exits[Math.min(requests.length-1,exits.length-1)])};};
  const opts:ServiceOptions={...f.opts,deps:{...f.deps,packageExecutor:executor,
    probeGroup:pgid=>{groups.push(pgid);const observation=probes++%2===0?'alive':'esrch';timeline.push(`probe:${requests.length-1}:${observation}`);return observation;},
    fault:p=>{events.push(p);timeline.push(`before:${p}`);fault(p);}}};
  return {opts,requests,events,groups,run:()=>runPackageAttempts(f.state,f.tx,opts)};
}
function closed(f:Fx,codes:string[]) { const l=ledger(f);
  assert.equal(l.runs.at(-1)?.state,'closed'); assert.deepEqual(l.attempts.map(a=>a.outcome?.code),codes);
  assert.ok(!fs.existsSync(f.name('package-attempt.json')));assert.ok(!fs.existsSync(f.name('lock.json')));unchanged(f);return l;
}
async function blocked(f:Fx) {
  assert.equal((parseJsonBytes(fs.readFileSync(f.name('lock.json'))) as any).kind,'pi-machine-config/package-lock');
  const before=snapshot(f.root);
  for(const boot of [BOOT,OTHER]) {
    const opts={...f.common,deps:{...f.deps,bootId:()=>boot,probePid:()=>assert.fail('no stale parent probe'),
      probeGroup:()=>assert.fail('no recovery group probe')}};
    const r=inspectRestore(f.state,opts);assert.equal(r.reason,'package-attempt-unresolved');assert.deepEqual(r.actions,[]);
    await refused(()=>rollbackRestore(f.state,f.tx,opts));
    await refused(()=>resolveRestore(f.state,{tx:f.tx,expect:'lock-stale',action:'release-lock'},opts));
  } assert.deepEqual(snapshot(f.root),before);
}
function controlled(t:TestContext,f:Fx) {
  const exit=deferred<PackageExit>(),spawned=deferred<void>();let observations=0;
  const requests:PackageSpawnSpec[]=[];let after:PidProbe='esrch';
  const sync=fs.fsyncSync, stateId=dirId(fs.lstatSync(f.state,{bigint:true}));
  const observer=t.mock.method(fs,'fsyncSync',(fd:number)=>{sync(fd);const s=fs.fstatSync(fd,{bigint:true});
    if(s.isDirectory()&&s.dev.toString()===stateId.dev&&s.ino.toString()===stateId.ino&&
      fs.existsSync(f.name('package-attempt.json'))&&gate(f).phase==='spawned')spawned.resolve();});
  const opts:ServiceOptions={...f.opts,deps:{...f.deps,packageExecutor:spec=>{
    requests.push(structuredClone(spec));return {pid:4_100_001,exit:exit.promise};},
    probeGroup:()=>observations++===0?'alive':after}};
  const settled=runPackageAttempts(f.state,f.tx,opts).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  const ready=()=>Promise.race([spawned.promise,settled.then(()=>assert.fail('service settled before durable spawned')),
    new Promise<never>((_,reject)=>t.signal.addEventListener('abort',()=>reject(new Error('test aborted')),{once:true}))]);
  return {opts,requests,settled,ready,setGroup:(v:PidProbe)=>{after=v;},finish:(e=GOOD)=>exit.resolve(e),
    cleanup:async()=>{after='esrch';exit.resolve({...GOOD,code:1});await settled;observer.mock.restore();}};
}
function seedHistory(f:Fx,n:number,runs:number,failLast=false) {
  const work=f.name('package-work');fs.mkdirSync(work,{mode:0o700});
  const id=dirId(fs.lstatSync(work,{bigint:true}));let seq=0;
  const l:PackageLedger={schemaVersion:1,kind:'pi-machine-config/package-ledger',tool:TOOL_ID,tx:f.tx,planToken:PLAN,
    workParent:id,nextSeq:n,runs:[],attempts:[]};
  for(let run=0;run<runs;run++) {
    l.runs.push({run,state:'closed',packageToken:run===0?OLD:PKG,lock:{...id,ino:String(100+run),ctimeNs:'1'},
      owner:{pid:4_000_001,uid:f.deps.uid(),hostname:'qa-host',bootId:BOOT,platform:process.platform as Platform}});
    const count=Math.floor(n/runs)+(run<n%runs?1:0);assert.ok(count<=f.decls.length);
    for(let index=0;index<count;index++,seq++) {const name=`w${seq}-${seq.toString(16).padStart(16,'0')}`;
      const child=path.join(work,name);fs.mkdirSync(child,{mode:0o700});
      l.attempts.push({seq,run,index,source:packageIdentity(f.decls[index]),work:{name,id:dirId(fs.lstatSync(child,{bigint:true}))},
        outcome:failLast&&index===count-1?{code:'exit-nonzero',exit:{code:1,signal:null,stdoutBytes:0,stderrBytes:0}}:
          {code:'installed',exit:{code:0,signal:null,stdoutBytes:0,stderrBytes:0}}});}
  } fs.writeFileSync(f.name('package-ledger.json'),ledgerBytes(l),{mode:0o600,flag:'wx'});return l;
}
const many=(n:number)=>Array.from({length:n},(_,i)=>`npm:qa-${i}`);

describe('trusted fixture-only package service',{concurrency:false},()=>{
  for(const explicit of [false,true])test(`S01: disabled executor before any FS (${explicit})`,async t=>{
    const f=fixture(t),traps:{mock:{restore():void}}[]=[];let calls=0;
    const trap=()=>{calls++;throw new Error(PRIVATE);};
    const opts={...f.opts,verifyLockedPackageIntent:trap,deps:{...f.deps,bootId:trap,uid:trap,hostname:trap,pid:trap,
      randomHex:trap,probePid:trap,probeGroup:trap,packageExecutor:explicit?null:undefined}};
    if(!explicit)delete (opts.deps as Partial<TxDeps>).packageExecutor;
    try {
      traps.push(t.mock.method(fs.realpathSync,'native',trap));
      for(const key of ['lstatSync','statSync','realpathSync','openSync','readFileSync','opendirSync','readdirSync',
        'mkdirSync','writeFileSync','renameSync','unlinkSync','accessSync','existsSync','readSync','writeSync','fsyncSync'] as const)
        traps.push(t.mock.method(fs,key,trap));
      for(const key of ['lstat','stat','realpath','open','readFile','opendir','readdir','mkdir','writeFile','rename','unlink','access'] as const)
        traps.push(t.mock.method(fs.promises,key,trap));
      assert.throws(()=>fs.lstatSync(f.state));assert.equal(calls,1);calls=0;
      await refused(()=>runPackageAttempts(f.state,f.tx,opts),'package-executor-unavailable');assert.equal(calls,0);
    } finally {for(const m of traps.reverse())m.mock.restore();}
    assert.deepEqual(fs.readdirSync(f.state),['journal.json']);unchanged(f);
  });
  const admission=['token','tx','context','lens','no-context','no-verifier','not-applied','changed-output'] as const;
  for(const bad of admission)test(`S02: refuse ${bad} without non-lock writes`,async t=>{
    const f=fixture(t),d=driver(f);let tx=f.tx;const opts={...d.opts} as any;
    if(bad==='token')opts.packageToken=OLD;
    if(bad==='tx')tx='f'.repeat(32);
    if(bad==='context')opts.expectedTargets={agent:path.join(f.root,'other'),lens:null};
    if(bad==='lens')opts.expectedTargets={agent:f.agent,lens:path.join(f.root,'lens.json')};
    if(bad==='no-context')delete opts.expectedTargets;
    if(bad==='no-verifier')delete opts.verifyLockedPackageIntent;
    if(bad==='not-applied')rollbackRestore(f.state,f.tx,f.common);
    if(bad==='changed-output')fs.writeFileSync(path.join(f.agent,'AGENTS.md'),'changed');
    const before=nonLockState(f),target=snapshot(f.agent);
    await refused(()=>runPackageAttempts(f.state,tx,opts),bad==='token'?'package-approval-mismatch':undefined);
    assert.equal(d.requests.length,0);assert.deepEqual(nonLockState(f),before);assert.deepEqual(snapshot(f.agent),target);
  });
  for(const bad of ['boot','host','pid','uid','protected','live-alias'] as const)test(`S03: owner/root ${bad}`,async t=>{
    const f=fixture(t),d=driver(f),opts={...d.opts,deps:{...d.opts.deps}};
    if(bad==='boot')opts.deps.bootId=()=>null;
    if(bad==='host')opts.deps.hostname=()=>'';
    if(bad==='pid')opts.deps.pid=()=>1;
    if(bad==='uid')opts.deps.uid=()=>-1;
    if(bad==='protected')opts.protectedRoots=[f.agent];
    if(bad==='live-alias') {const live=path.join(f.home,'.pi');fs.mkdirSync(live);const alias=path.join(f.root,'alias');
      fs.symlinkSync(live,alias);opts.protectedRoots=[alias];opts.expectedTargets={agent:path.join(alias,'agent'),lens:null};}
    await refused(()=>runPackageAttempts(f.state,f.tx,opts));assert.equal(d.requests.length,0);
    assert.ok(!fs.existsSync(f.name('package-work')));assert.ok(!fs.existsSync(f.name('package-ledger.json')));unchanged(f);
  });
  for(const [decls,n,r,allowed] of [[1025,0,0,false],[32,992,31,true],[33,1023,31,false],[1,32,32,false],[1,31,31,true]] as const)
    test(`S04: capacity declarations=${decls} attempts=${n} runs=${r}`,async t=>{
      const f=fixture(t,many(decls));if(r)seedHistory(f,n,r,true);const before=nonLockState(f),d=driver(f);
      if(!allowed){await refused(d.run,'package-attempt-limit');assert.equal(d.requests.length,0);assert.deepEqual(nonLockState(f),before);}
      else {const result=await d.run();assert.equal(result.status,'completed');assert.equal(d.requests.length,decls);
        assert.equal(ledger(f).nextSeq,n+decls);assert.equal(ledger(f).runs.length,r+1);}
      unchanged(f);
    });
  test('S05: sequential full declarations, literal policy, phase ordering and private persistent work',async t=>{
    const f=fixture(t),timeline=successfulSyncTrace(t,f),d=driver(f,[GOOD],()=>{},timeline),result=await d.run();
    assert.deepEqual(result,{tx:f.tx,status:'completed',attempted:2,installed:2,failed:null});
    const l=closed(f,['installed','installed']);assert.deepEqual(l.attempts.map(a=>[a.seq,a.run,a.index,a.source]),[[0,0,0,'npm:qa-one'],[1,0,1,'npm:qa-two']]);
    assert.deepEqual(d.requests.map(r=>r.source),['npm:qa-one','npm:qa-two']);assert.equal(d.groups.length,4);
    for(const request of d.requests) {assert.equal(request.agentDir,f.agent);assert.equal(request.timeoutMs,120000);
      for(const [key,p] of Object.entries(request.work)) {assert.ok(p.startsWith(f.name('package-work')+path.sep));const s=fs.lstatSync(p);
        assert.equal(s.mode&0o777,key==='userconfig'||key==='globalconfig'?0o600:0o700);
        if(key==='userconfig'||key==='globalconfig')assert.equal(fs.readFileSync(p).length,0);
        else assert.deepEqual(fs.readdirSync(p),[]);}}
    const positions=(p:string)=>d.events.flatMap((v,i)=>v===p?[i]:[]);
    assert.equal(positions('attempt-create').length,2);assert.equal(positions('attempt-rename').length,6);
    assert.equal(positions('attempt-unlink').length,2);assert.equal(positions('ledger-dirsync').length,6);
    assert.ok(positions('attempt-dirsync')[0]<positions('attempt-rename')[0]);
    assert.ok(positions('attempt-rename-dirsync')[2]<positions('attempt-unlink')[0]);
    assert.ok(positions('attempt-unlink-dirsync')[0]<positions('attempt-create')[1]);
    assert.ok(positions('ledger-dirsync').at(-1)!<positions('pkglock-release')[0]);
    const order=['sync:ledger:open:0:none','sync:ledger:open:1:none','sync:attempt:0:intent','spawn:0','probe:0:alive',
      'sync:attempt:0:spawned','probe:0:esrch','sync:attempt:0:stopped-proven','sync:attempt:0:config-verified',
      'sync:ledger:open:1:installed','before:attempt-unlink','sync:gate-absent:1','sync:ledger:open:2:none',
      'sync:attempt:1:intent','spawn:1','probe:1:alive','sync:attempt:1:spawned','probe:1:esrch',
      'sync:attempt:1:stopped-proven','sync:attempt:1:config-verified','sync:ledger:open:2:installed',
      'sync:gate-absent:2','sync:ledger:closed:2:installed','before:pkglock-release','sync:lock-absent'];
    let cursor=-1;for(const expected of order){cursor=timeline.indexOf(expected,cursor+1);assert.ok(cursor>=0,`missing durable ordered event ${expected}`);}
  });
  test('S06: retry appends sequence/run, permits historical different consent and preserves completed prefix',async t=>{
    const f=fixture(t,['npm:qa-one']);await driver(f,[{...GOOD,code:1}]).run();const before=ledger(f);
    const opts=driver(f).opts;opts.packageToken=OLD;opts.verifyLockedPackageIntent=()=>OLD;
    const r=await runPackageAttempts(f.state,f.tx,opts);assert.equal(r.status,'completed');const l=ledger(f);
    assert.deepEqual(l.attempts[0],before.attempts[0]);assert.deepEqual(l.attempts.map(a=>[a.seq,a.run,a.index,a.source]),[[0,0,0,'npm:qa-one'],[1,1,0,'npm:qa-one']]);
    assert.deepEqual(l.runs.map(r=>r.packageToken),[PKG,OLD]);unchanged(f);
  });
  for(const [reason,exit] of [['exit-nonzero',{...GOOD,code:7}],['signal',{...GOOD,code:null,signal:'SIGTERM'}],
    ['timeout',{...GOOD,timedOut:true}],['output-limit',{...GOOD,overflow:true}]] as const)
    test(`S07: stop after partial success / ${reason}`,async t=>{
      const f=fixture(t,many(3)),d=driver(f,[GOOD,exit]);const r=await d.run();
      assert.deepEqual(r,{tx:f.tx,status:'install-failed',attempted:2,installed:1,failed:{index:1,reason}});
      const l=closed(f,['installed',reason]);assert.equal(l.nextSeq,2);assert.equal(d.requests.length,2);
    });
  for(const stream of ['stdoutBytes','stderrBytes'] as const)for(const n of [MIB,MIB+1])
    test(`S08: independent ${stream}=${n}, overflow=false`,async t=>{
      const f=fixture(t,many(2)),d=driver(f,[{...GOOD,[stream]:n},GOOD]);const r=await d.run();
      assert.equal(r.status,n===MIB?'completed':'install-failed');assert.equal(d.requests.length,n===MIB?2:1);
      closed(f,n===MIB?['installed','installed']:['output-limit']);
    });
  test('S08: both streams at cap are valid, not a combined budget',async t=>{
    const f=fixture(t,['npm:qa-one']);await driver(f,[{...GOOD,stdoutBytes:MIB,stderrBytes:MIB}]).run();closed(f,['installed']);
  });
  for(const stage of ['initial','after-exit'] as const)for(const observation of ['alive','esrch','eperm','unknown'] as const) {
    if((stage==='initial'&&observation==='alive')||(stage==='after-exit'&&observation==='esrch'))continue;
    test(`S09: ${stage} group=${observation} is not stop/ownership proof`,async t=>{
      const f=fixture(t,['npm:qa-one']),d=driver(f);let probes=0;
      d.opts.deps!.probeGroup=()=>++probes===1?(stage==='initial'?observation:'alive'):observation;
      await refused(d.run,stage==='initial'?'package-spawn-unresolved':'package-stop-unproven');
      assert.equal(d.requests.length,1);assert.ok(!['stopped-proven','config-verified'].includes(gate(f).phase));await blocked(f);unchanged(f);
    });
  }
  for(const kind of ['invalid-pid','rejected-exit'] as const)test(`S09: unresolved executor facts ${kind}`,async t=>{
    const f=fixture(t,['npm:qa-one']),d=driver(f);
    d.opts.deps!.packageExecutor=()=>kind==='invalid-pid'?{pid:1,exit:Promise.resolve(GOOD)}:
      {pid:4_100_001,exit:Promise.reject(new Error(PRIVATE))};
    await refused(d.run,kind==='invalid-pid'?'package-spawn-unresolved':undefined);await blocked(f);unchanged(f);
  });
  test('S10: installer window does not release exclusion; 150s backstop retains unproven exit',{timeout:5000},async t=>{
    const f=fixture(t,['npm:qa-one']);let now=0;const clock=t.mock.method(performance,'now',()=>now);
    t.mock.timers.enable({apis:['setTimeout']});const c=controlled(t,f);
    const tick=(ms:number)=>{now+=ms;t.mock.timers.tick(ms);};
    try {await c.ready();let done=false;void c.settled.then(()=>{done=true;});
      const stillWaiting=()=>Promise.race([c.settled.then(()=>false),new Promise<boolean>(yes=>setImmediate(()=>yes(!done)))]);
      tick(120000);assert.equal(await stillWaiting(),true);
      tick(29999);assert.equal(await stillWaiting(),true);
      tick(1);const result=await c.settled;fixed(result.error,'package-stop-unproven');
      assert.equal(c.requests[0].timeoutMs,120000);await blocked(f);
    } finally {await c.cleanup();t.mock.timers.reset();clock.mock.restore();}
  });
  for(const kind of ['bytes','same-bytes','work-parent','work-child','state'] as const)
    test(`S11: across-await identity/config drift ${kind}`,{timeout:5000},async t=>{
      const f=fixture(t),c=controlled(t,f);try {await c.ready();let relocated:string|undefined;
        if(kind==='bytes')fs.writeFileSync(path.join(f.agent,'settings.json'),'{}\n');
        if(kind==='same-bytes') {const p=path.join(f.agent,'settings.json'),tmp=path.join(f.root,'replacement');fs.writeFileSync(tmp,fs.readFileSync(p),{mode:0o600});fs.renameSync(tmp,p);}
        if(kind==='work-parent'||kind==='work-child'||kind==='state') {const p=kind==='state'?f.state:kind==='work-parent'?f.name('package-work'):path.join(f.name('package-work'),gate(f).work.name);
          relocated=p+'-displaced';fs.renameSync(p,relocated);fs.mkdirSync(p,{mode:0o700});}
        const target=snapshot(f.agent);c.finish();const r=await c.settled;assert.ok(r.error);
        fixed(r.error,kind==='bytes'||kind==='same-bytes'?'package-config-drift':kind==='state'?undefined:'package-work-changed');
        assert.equal(c.requests.length,1);assert.deepEqual(snapshot(f.agent),target);
        if(kind==='state')assert.ok(fs.existsSync(path.join(relocated!,'lock.json')));else await blocked(f);
      } finally {await c.cleanup();}
    });
  for(const target of ['package-attempt.json','lock.json','package-ledger.json'])
    test(`S12: same bytes/new inode cannot retain capability / ${target}`,{timeout:5000},async t=>{
      const f=fixture(t),c=controlled(t,f);try {await c.ready();const p=f.name(target),tmp=path.join(f.root,'replacement');
        fs.writeFileSync(tmp,fs.readFileSync(p),{mode:0o600});fs.renameSync(tmp,p);const before=fs.lstatSync(p,{bigint:true});
        c.finish();const r=await c.settled;assert.ok(r.error);fixed(r.error);assert.equal(c.requests.length,1);
        assert.equal(fs.lstatSync(p,{bigint:true}).ino,before.ino);await blocked(f);unchanged(f);
      } finally {await c.cleanup();}
    });
  test('S12: parse-valid attempt facts cannot skip the live coordinator phase',{timeout:5000},async t=>{
    const f=fixture(t),c=controlled(t,f);try {await c.ready();const a=gate(f);
      a.phase='config-verified';a.exit={...GOOD};fs.writeFileSync(f.name('package-attempt.json'),JSON.stringify(a));
      c.finish();const result=await c.settled;assert.ok(result.error);fixed(result.error);assert.equal(c.requests.length,1);await blocked(f);
    } finally {await c.cleanup();}
  });
  test('S12: consent recomputation after await cannot reuse stale approval',{timeout:5000},async t=>{
    const f=fixture(t);let current=PKG;const verify=f.opts.verifyLockedPackageIntent;
    f.opts.verifyLockedPackageIntent=locked=>{verify(locked);return current;};const c=controlled(t,f);
    try {await c.ready();current=OLD;c.finish();const r=await c.settled;assert.ok(r.error);fixed(r.error,'package-approval-mismatch');
      assert.equal(c.requests.length,1);await blocked(f);unchanged(f);
    } finally {await c.cleanup();}
  });
  test('S13: inspect, rollback, recovery and identical owner second caller are excluded while awaiting', {timeout:5000},async t=>{
    const f=fixture(t),c=controlled(t,f);try {await c.ready();const before=snapshot(f.root);await blocked(f);
      await refused(()=>runPackageAttempts(f.state,f.tx,c.opts));assert.equal(c.requests.length,1);assert.deepEqual(snapshot(f.root),before);
      c.finish({...GOOD,code:1});const r=await c.settled;assert.equal(r.value?.status,'install-failed');closed(f,['exit-nonzero']);
    } finally {await c.cleanup();}
  });
  const faults:[string,number][]=[['pkglock-create-sync',1],['pkglock-dirsync',1],['work-root-mkdir',1],['work-root-sync',1],
    ['work-mkdir',1],['work-dirsync',1],['work-file-sync',1],['ledger-write-sync',1],['ledger-rename',1],['ledger-dirsync',2],
    ['attempt-create-sync',1],['attempt-dirsync',1],['attempt-write',1],['attempt-rename',1],['attempt-rename-dirsync',1],
    ['attempt-rename-dirsync',2],['attempt-rename-dirsync',3],['ledger-dirsync',3],['attempt-unlink',1],['ledger-rename',4]];
  for(const [point,nth] of faults)test(`S14: ${point} occurrence ${nth}`,async t=>{
    const f=fixture(t,['npm:qa-one']);let seen=0,hit=false;
    const d=driver(f,[GOOD],p=>{if(p===point&&++seen===nth){hit=true;throw new Error(PRIVATE);}});
    await refused(d.run);assert.equal(hit,true,`unmapped required hook ${point}/${nth}`);assert.equal(seen,nth);
    const beforeSpawn=['pkglock-create-sync','pkglock-dirsync','work-root-mkdir','work-root-sync','work-mkdir','work-dirsync',
      'work-file-sync','ledger-write-sync','ledger-rename','ledger-dirsync','attempt-create-sync','attempt-dirsync'].includes(point)&&nth<=2;
    assert.equal(d.requests.length,beforeSpawn?0:1);
    if(point==='pkglock-create-sync'||point==='pkglock-dirsync') {if(fs.existsSync(f.name('lock.json')))await blocked(f);
      assert.ok(!fs.existsSync(f.name('package-work')));assert.ok(!fs.existsSync(f.name('package-ledger.json')));}
    else {assert.deepEqual(d.events.slice(d.events.lastIndexOf(point)+1),[],'no mutation follows failed publication');
      await blocked(f);} unchanged(f);
  });
  test('S15: removed gate + failed sync retains special exclusion and durable outcome',async t=>{
    const f=fixture(t),d=driver(f,[GOOD],p=>{if(p==='attempt-unlink-dirsync')throw new Error(PRIVATE);});
    await refused(d.run);assert.equal(d.requests.length,1);assert.ok(d.events.includes('attempt-unlink-dirsync'));assert.ok(!fs.existsSync(f.name('package-attempt.json')));
    assert.equal(ledger(f).attempts[0].outcome?.code,'installed');assert.equal(ledger(f).runs[0].state,'open');await blocked(f);unchanged(f);
  });
  test('S16: visible closed ledger with failed sync still retains special lock',async t=>{
    const f=fixture(t,['npm:qa-one']);let n=0;const d=driver(f,[GOOD],p=>{if(p==='ledger-dirsync'&&++n===4)throw new Error(PRIVATE);});
    await refused(d.run);assert.equal(n,4);assert.equal(ledger(f).runs[0].state,'closed');assert.ok(!fs.existsSync(f.name('package-attempt.json')));await blocked(f);unchanged(f);
  });
  for(const point of ['pkglock-release','pkglock-release-sync'])test(`S17: final cleanup / ${point}`,async t=>{
    const f=fixture(t,['npm:qa-one']);let old:Buffer|undefined,hit=false;
    const d=driver(f,[GOOD],p=>{if(p==='pkglock-release')old=fs.readFileSync(f.name('lock.json'));if(p===point){hit=true;throw new Error(PRIVATE);}});
    await refused(d.run);assert.equal(hit,true);assert.equal(ledger(f).runs[0].state,'closed');
    if(point==='pkglock-release')await blocked(f);
    else {assert.ok(!fs.existsSync(f.name('lock.json')));assert.equal(inspectRestore(f.state,f.common).class,'applied');
      assert.equal(rollbackRestore(f.state,f.tx,f.common).removed,2);
      assert.ok(old);fs.writeFileSync(f.name('lock.json'),old,{flag:'wx',mode:0o600});await blocked(f);}
  });
  test('S18: maximum closed history never prevents rollback; work/runtime/audit survive',async t=>{
    const f=fixture(t,many(32));seedHistory(f,1024,32);const audit=fs.readFileSync(f.name('package-ledger.json'));
    const runtime=path.join(f.agent,'runtime-sentinel');fs.writeFileSync(runtime,'package runtime');
    assert.equal(inspectRestore(f.state,f.common).class,'applied');assert.equal(rollbackRestore(f.state,f.tx,f.common).removed,2);
    assert.equal(rollbackRestore(f.state,f.tx,f.common).removed,0);assert.equal(fs.readFileSync(runtime,'utf8'),'package runtime');
    assert.deepEqual(fs.readFileSync(f.name('package-ledger.json')),audit);assert.ok(fs.statSync(f.name('package-work')).isDirectory());
  });
  for(const kind of ['missing-ledger','open-no-lock','wrong-source','wrong-index','wrong-parent','symlink-ledger','hardlink-ledger',
    'unsafe-ledger','ledger-temp','open-with-valid-temp','old-child-replaced','attempt-temp','unknown-entry'] as const)
    test(`S19: unsafe/dangling/context-invalid history ${kind}`,async t=>{
      const f=fixture(t),l=seedHistory(f,1,1);
      if(kind==='missing-ledger')fs.unlinkSync(f.name('package-ledger.json'));
      if(kind==='open-with-valid-temp')fs.writeFileSync(f.name(`package-ledger.json.tmp-${'a'.repeat(16)}`),ledgerBytes(l),{mode:0o600});
      if(kind==='open-no-lock'||kind==='open-with-valid-temp')l.runs[0].state='open';
      if(kind==='wrong-source')l.attempts[0].source='npm:not-approved';
      if(kind==='wrong-index')l.attempts[0].index=1;
      if(kind==='wrong-parent')l.workParent={...l.workParent,ino:'99999999'};
      if(['open-no-lock','open-with-valid-temp','wrong-source','wrong-index','wrong-parent'].includes(kind))fs.writeFileSync(f.name('package-ledger.json'),ledgerBytes(l));
      if(kind==='old-child-replaced') {const p=path.join(f.name('package-work'),l.attempts[0].work.name);
        fs.renameSync(p,path.join(f.root,'displaced-history-child'));fs.mkdirSync(p,{mode:0o700});}
      if(kind==='unsafe-ledger')fs.chmodSync(f.name('package-ledger.json'),0o644);
      if(kind==='ledger-temp')fs.writeFileSync(f.name(`package-ledger.json.tmp-${'a'.repeat(16)}`),'{}',{mode:0o600});
      if(kind==='symlink-ledger'||kind==='hardlink-ledger') {const other=path.join(f.root,'ledger-copy');fs.renameSync(f.name('package-ledger.json'),other);
        if(kind==='symlink-ledger')fs.symlinkSync(other,f.name('package-ledger.json'));else fs.linkSync(other,f.name('package-ledger.json'));}
      if(kind==='attempt-temp')fs.writeFileSync(f.name(`package-attempt.json.tmp-${'a'.repeat(16)}`),'{}',{mode:0o600});
      if(kind==='unknown-entry')fs.writeFileSync(f.name('unknown'),'private',{mode:0o600});
      const before=nonLockState(f),d=driver(f);await refused(d.run);assert.equal(d.requests.length,0);assert.deepEqual(nonLockState(f),before);unchanged(f);
    });
  test('S19: historical child metadata is checked without reading cache contents',async t=>{
    const f=fixture(t,['npm:qa-one']),l=seedHistory(f,1,1),cache=path.join(f.name('package-work'),l.attempts[0].work.name,'cache');
    fs.mkdirSync(cache,{mode:0o700});fs.writeFileSync(path.join(cache,'private-sentinel'),PRIVATE,{mode:0o600});
    const open=fs.openSync,list=fs.opendirSync;
    const a=t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{
      assert.ok(!String(args[0]).startsWith(cache),'no historical cache body read');return Reflect.apply(open,fs,args);});
    const b=t.mock.method(fs,'opendirSync',(...args:Parameters<typeof fs.opendirSync>)=>{
      assert.ok(!String(args[0]).startsWith(cache),'no historical cache traversal');return Reflect.apply(list,fs,args);});
    try {const result=await driver(f).run();assert.equal(result.status,'completed');assert.equal(ledger(f).nextSeq,2);unchanged(f);}
    finally {a.mock.restore();b.mock.restore();}
    assert.equal(fs.readFileSync(path.join(cache,'private-sentinel'),'utf8'),PRIVATE);
  });
  test('S20: public result has no private paths/values; executor exceptions are fixed and unresolved',async t=>{
    const f=fixture(t,['npm:qa-one']),d=driver(f);const result=await d.run();
    assert.deepEqual(Object.keys(result).sort(),['attempted','failed','installed','status','tx']);
    assert.ok(!JSON.stringify(result).includes(f.root));assert.ok(!JSON.stringify(result).includes('qa-one'));
    const g=fixture(t,['npm:qa-one']),bad=driver(g);bad.opts.deps!.packageExecutor=()=>{throw new Error(PRIVATE);};
    await refused(bad.run,'package-spawn-unresolved');await blocked(g);unchanged(g);
  });
  test('S20: verifier exception cannot leak or authorize work',async t=>{
    const f=fixture(t),d=driver(f);d.opts.verifyLockedPackageIntent=()=>{throw new Error(PRIVATE);};
    await refused(d.run);assert.equal(d.requests.length,0);assert.ok(!fs.existsSync(f.name('package-ledger.json')));
    assert.ok(!fs.existsSync(f.name('package-work')));unchanged(f);
  });
  test('S02/S04: zero declarations is a validated no-op, no audit/work/run allocation',async t=>{
    const f=fixture(t,[]),d=driver(f),before=snapshot(f.root);const r=await d.run();
    assert.deepEqual(r,{tx:f.tx,status:'completed',attempted:0,installed:0,failed:null});assert.equal(d.requests.length,0);
    assert.deepEqual(snapshot(f.root),before);assert.deepEqual(fs.readdirSync(f.state),['journal.json']);
  });
});
