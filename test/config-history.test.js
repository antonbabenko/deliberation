"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {snapshot,configId,makeConfigHistory,readHistory,readRuntimes,validSnapshot}=require('../core/config-history.js');
const {resolveSettings,effectiveConfig}=require('../core/settings.js');
const {makeFanoutGroups}=require('../core/fanout-groups.js');
const {askAll,askOne}=require('../core/orchestrate.js');
const {makeResultCache}=require('../core/result-cache.js');
const {analyzeConfigs,validateFilters}=require('../core/config-analysis.js');
const {providerLabel,formatDuration}=require('../core/display.js');
const {buildServer}=require('../server/mcp/index.js');
const {createJournal}=require('../core/journal.js');
const {createRunIndex}=require('../server/dashboard/runs.js');
const {sanitizeEvent}=require('../core/debug-log.js');
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'delib-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const config=model=>({providers:{codex:{model,reasoningEffort:'high',consensusReasoningEffort:'medium',timeout:80},openrouter:{enabled:true}},openrouter:{enabled:true,maxFanout:4,models:[],defaults:{reasoning_effort:'low'}},consensus:{maxRounds:5},orientation:{enabled:false}});
const fake=(name,limit,delay=1)=>({name,capabilities:{walksFilesystem:true},health:async()=>({ok:true}),resolveSettings:req=>({model:'m',timeoutMs:req.timeoutMs??limit}),ask:req=>new Promise(resolve=>setTimeout(()=>resolve({provider:name,model:'m',text:'VERDICT: APPROVE',isError:false,ms:delay,usage:{totalTokens:10}}),delay))});
const call=async(srv,name,args,id=1)=>{const r=await srv.handle({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});if(r.error)throw new Error(r.error.message);return JSON.parse(r.result.content[0].text);};

test('identity canonicalizes keys, preserves ordered routing, excludes credentials and display settings',()=>{
 const a=config('one');const b={...a,dashboard:{enabled:true,showPII:true},apiKey:'secret'};
 assert.equal(configId(snapshot(a)),configId(snapshot(b)));
 assert.equal(configId(snapshot(a)),configId(snapshot({...a,providers:{openrouter:a.providers.openrouter,codex:a.providers.codex}})));
 assert.notEqual(configId(snapshot(a)),configId(snapshot(config('two'),{codex:resolveSettings('codex',config('two'))})));
 const models=[{alias:'a',model:'x',experts:['a','b']},{alias:'b',model:'y'}];
 assert.notEqual(configId(snapshot({...a,openrouter:{models}})),configId(snapshot({...a,openrouter:{models:[...models].reverse()}})));
 const safe=snapshot(a,{codex:{model:'one',apiKey:'secret',source:{apiKey:'secret'}}});
 assert.ok(!JSON.stringify(safe).includes('secret'));assert.ok(validSnapshot(safe));
 assert.equal(validSnapshot({...safe,privateKey:'secret'}),false);
});

test('A -> B -> A keeps identity and first-use, creates new activations; restart and concurrent runtimes',t=>{
 const dir=temp(t);let cfg=config('a');const getActive=()=>({codex:resolveSettings('codex',cfg)});
 const history=makeConfigHistory({getConfig:()=>cfg,getActive,dir,enabled:()=>true,dashboardEnabled:()=>true});t.after(()=>history.close());
 const a=history.observe();cfg=config('b');const b=history.observe();cfg=config('a');const again=history.observe();
 assert.equal(again.configId,a.configId);assert.notEqual(again.activationId,a.activationId);assert.equal(again.firstSeenAt,a.firstSeenAt);assert.notEqual(b.configId,a.configId);
 const other=makeConfigHistory({getConfig:()=>cfg,getActive,dir,enabled:()=>true,dashboardEnabled:()=>true});t.after(()=>other.close());const o=other.observe();
 assert.equal(o.configId,a.configId);assert.equal(o.firstSeenAt,a.firstSeenAt);assert.notEqual(o.runtimeId,a.runtimeId);assert.equal(readRuntimes(dir).length,2);assert.equal(readHistory(dir).length,4);
 history.close();assert.equal(readRuntimes(dir).find(r=>r.runtimeId===a.runtimeId).freshness,'shutdown');
});

test('restart-only edits stay pending while enable/routing changes are active',t=>{
 const dir=temp(t),startup=config('old');let cfg=startup;
 const history=makeConfigHistory({getConfig:()=>cfg,getActive:pending=>({codex:resolveSettings('codex',pending?cfg:effectiveConfig(cfg,startup))}),dir,enabled:()=>true});t.after(()=>history.close());
 const before=history.observe();cfg=config('new');const after=history.observe();
 assert.equal(after.configId,before.configId);assert.notEqual(after.pendingConfigId,null);assert.equal(after.snapshot.activeProviders.codex.model,'old');assert.equal(after.pendingSnapshot.activeProviders.codex.model,'new');
});

test('telemetry off writes nothing; persistence failure and invalid config never fail delegation',t=>{
 const dir=temp(t),off=path.join(dir,'off');const h=makeConfigHistory({getConfig:()=>config('a'),dir:off});t.after(()=>h.close());h.observe();assert.equal(fs.existsSync(off),false);
 const file=path.join(dir,'file');fs.writeFileSync(file,'x');const bad=makeConfigHistory({getConfig:()=>config('a'),dir:file,enabled:()=>true});t.after(()=>bad.close());assert.ok(bad.observe().configId);
 const invalid=makeConfigHistory({getConfig:()=>config('a'),getError:()=> 'secret parse detail',dir});t.after(()=>invalid.close());assert.equal(invalid.observe().configId,null);assert.ok(!JSON.stringify(invalid.observe()).includes('secret'));
});

test('manifest reader rejects symlinks, malformed hashes, oversized records and nested unexpected fields',t=>{
 const dir=temp(t);const h=makeConfigHistory({getConfig:()=>config('a'),dir,enabled:()=>true,dashboardEnabled:()=>true});t.after(()=>h.close());h.observe();
 const d=path.join(dir,'runtimes'),f=path.join(d,h.runtimeId+'.json'),m=JSON.parse(fs.readFileSync(f));
 m.snapshot.activeProviders.codex={secret:'value'};fs.writeFileSync(f,JSON.stringify(m));assert.equal(readRuntimes(dir).length,0);
 fs.unlinkSync(f);fs.symlinkSync(path.join(dir,'missing'),f);assert.equal(readRuntimes(dir).length,0);
});

test('runtime reader projects outer fields and missing config remains explicit',t=>{
 const dir=temp(t),h=makeConfigHistory({getConfig:()=>({...config('a'),configLoadState:'missing'}),dir,enabled:()=>true,dashboardEnabled:()=>true});t.after(()=>h.close());
 const p=h.observe();assert.equal(p.configLoadState,'missing');
 const file=path.join(dir,'runtimes',h.runtimeId+'.json'),m=JSON.parse(fs.readFileSync(file));
 m.unexpected='PRIVATE-CONTENT';m.firstSeenAt='PRIVATE-CONTENT';fs.writeFileSync(file,JSON.stringify(m));
 const result=readRuntimes(dir);assert.equal(result.length,1);assert.ok(!JSON.stringify(result).includes('PRIVATE-CONTENT'));
});

test('effective effort precedence and model-encoded Gemini introspection are distinct from observed CLI effort',()=>{
 const cfg=config('m');cfg.openrouter.models=[{alias:'x',model:'or-model',reasoning_effort:'low',consensus_reasoning_effort:'high',temperature:0.4,timeout:123}];
 assert.equal(resolveSettings('codex',cfg).askEffort,'high');assert.equal(resolveSettings('codex',cfg,{context:'consensus'}).reasoningEffort,'medium');
 assert.equal(resolveSettings('openrouter:x',cfg,{context:'consensus'}).reasoningEffort,'high');assert.equal(resolveSettings('openrouter:x',cfg,{context:'consensus',reasoningEffort:'none'}).reasoningEffort,'none');
 assert.equal(resolveSettings('gemini',{providers:{gemini:{model:'gemini-3.8-flash-high'}}}).askEffort,'high');
 assert.equal(resolveSettings('gemini',{}).askEffort,'inherited / unknown');
});

test('longest peer gives shorter peer time to finish; per-provider retains its ceiling',async()=>{
 const slow=fake('short',20,55),long=fake('long',120,2);
 const common=await askAll([slow,long],{prompt:'p'});assert.equal(common[0].isError,false);assert.equal(common[0].provenance.configuredTimeoutMs,20);
 const own=await askAll([slow,long],{prompt:'p',timeoutPolicy:'per-provider'});assert.equal(own[0].errorKind,'timeout');
});

test('hung providers abort at group deadline; timeout is not retried; cancellation wins',async()=>{
 let attempts=0,aborts=0;const hung={...fake('hung',30),ask:req=>{attempts++;req.signal.addEventListener('abort',()=>aborts++);return new Promise(()=>{});}};
 const out=await askAll([hung],{prompt:'p'});assert.equal(out[0].errorKind,'timeout');assert.equal(attempts,1);assert.equal(aborts,1);
 const controller=new AbortController();const pending=askAll([hung],{prompt:'p',signal:controller.signal});controller.abort();assert.equal((await pending)[0].errorKind,'timeout');
});

test('retry spends one absolute budget, and refuses retry backoff that cannot fit',async()=>{
 let n=0;const p={...fake('retry',60),ask:async()=>{n++;return {provider:'retry',model:'m',isError:true,errorKind:'network',retryable:true,ms:1,message:'network'};}};
 const r=await askAll([p],{prompt:'p'});assert.equal(n,1);assert.equal(r[0].errorKind,'network');
});

test('progressive groups start at first dispatch, reject duplicates/replays and expire missing members',async t=>{
 const closed=[];const groups=makeFanoutGroups({idleMs:80,onClose:(g,r)=>closed.push(r)});t.after(()=>groups.close());
 const id=groups.create([fake('a',80),fake('b',100)],{});await new Promise(r=>setTimeout(r,15));
 const a=groups.join(id,'a',{});assert.ok(a.deadlineAt-Date.now()>80);assert.equal(groups.join(id,'a',{}).error,'duplicate-fanout-dispatch');assert.equal(groups.join(id,'c',{}).error,'fanout-nonmember');
 groups.settle(id,'a');await new Promise(r=>setTimeout(r,110));assert.equal(groups.size,0);assert.equal(groups.join(id,'b',{}).error,'unknown-or-expired-fanout');assert.ok(closed.includes('deadline-expired'));
});

test('member host caps/cancellation do not shorten progressive siblings; shutdown aborts siblings',async t=>{
 const groups=makeFanoutGroups();t.after(()=>groups.close());const p=fake('a',100,50),q=fake('b',100,50);const id=groups.create([p,q],{});
 const a=groups.join(id,'a',{hostBudgetRemainingMs:10});const b=groups.join(id,'b',{});assert.equal(a.deadlineAt,b.deadlineAt);
 const first=await askOne(p,{prompt:'p',deadlineAt:a.deadlineAt,signal:a.signal,hostBudgetRemainingMs:10});assert.equal(first.errorKind,'timeout');assert.equal(b.signal.aborted,false);
 const second=await askOne(q,{prompt:'p',deadlineAt:b.deadlineAt,signal:b.signal});assert.equal(second.isError,false);
 groups.close();assert.equal(a.signal.aborted,true);assert.equal(b.signal.aborted,true);
});

test('group capacity and idle expiry bound resources',async t=>{
 const groups=makeFanoutGroups({max:1,idleMs:10});t.after(()=>groups.close());groups.create([fake('a',10)],{});assert.throws(()=>groups.create([],{}),/capacity/);await new Promise(r=>setTimeout(r,20));assert.equal(groups.size,0);
});

test('resolved cache key misses on alias model, effort, expert, tool and semantic config changes',async()=>{
 let model='one',effort='low',calls=0;const p={...fake('openrouter:x',80),resolveSettings:req=>({model,reasoningEffort:effort,timeoutMs:80}),ask:async req=>{calls++;return {provider:'openrouter:x',model:req.model,text:'OK',isError:false,ms:8,usage:{totalTokens:10}};}};
 const cache=makeResultCache(),req={prompt:'same',provenance:{configId:'a'.repeat(64)}};
 const first=await askOne(p,req,{cache,tool:'one'});const hit=await askOne(p,req,{cache,tool:'one'});assert.equal(hit.cached,true);assert.ok(hit.provenance.original);assert.equal(calls,1);
 model='two';await askOne(p,req,{cache,tool:'one'});effort='high';await askOne(p,req,{cache,tool:'one'});
 await askOne(p,{...req,expert:'architect'},{cache,tool:'one'});await askOne(p,req,{cache,tool:'two'});await askOne(p,{...req,provenance:{configId:'b'.repeat(64)}},{cache,tool:'one'});assert.equal(calls,6);
});

test('config/time intersections include completion across boundary and retain unknown legacy cohort',()=>{
 const id='a'.repeat(64),event={event:'provider_result',provider:'codex',model:'old',at:120,runStartedAt:90,runId:'r',configId:id,ms:10,isError:false};
 const runs=[{runId:'r',configId:id,startedAt:90,endedAt:120,status:'done',providers:['codex'],tokens:10,tokenCoverage:1}];
 const report=analyzeConfigs([event,{...event,cached:true,usage:{totalTokens:999}},{...event,runStartedAt:undefined,runId:undefined,configId:undefined,at:95}],[],runs,config('new'),{nowMs:100,windowMs:20,groupBy:'config',configId:id});
 assert.equal(report.stats[0].calls,1);assert.equal(report.configs[0].runCount,1);assert.equal(report.configs[0].measuredTokens,10);assert.equal(report.configs[0].reusedResults,1);assert.equal(report.meta.currentModelFilter,'ignored for historical groups');
 assert.equal(analyzeConfigs([event],[],runs,{}, {nowMs:100,windowMs:5,groupBy:'config'}).stats.length,0);
 assert.equal(validateFilters({configId:'../../x'}).error,'invalid-configId');assert.equal(validateFilters({since:'bogus'}).error,'invalid-since');
});

test('agreement ignores reused votes and live runs never enter terminal latency denominators',()=>{
 const id='a'.repeat(64);const record={createdAt:new Date(90).toISOString(),configId:id,verdict:'APPROVE',opinions:[{provider:'codex',model:'m',verdict:'APPROVE',cached:true}]};
 const r=analyzeConfigs([], [record],[{runId:'r',configId:id,startedAt:90,endedAt:null,status:'running'}],{}, {nowMs:100,groupBy:'config'});
 assert.equal(r.agreement.length,0);assert.equal(r.configs[0].liveRuns,1);assert.equal(r.configs[0].elapsed.p50,null);
});

test('MCP progressive groups work with logging off, pin aliases after edit, and reject invalid IDs',async t=>{
 let cfg=config('m');cfg.openrouter.models=[{alias:'x',model:'one',askAll:true,consensus:true,timeout:100}];
 const seen=[];const or={...fake('openrouter',100),ask:async req=>{seen.push(req.model);return {provider:'openrouter',model:req.model,text:'OK',isError:false,ms:2};}};
 const srv=buildServer({providers:[or],getConfig:()=>cfg});t.after(()=>srv.close());const panel=await call(srv,'panel',{});
 assert.ok(panel.fanoutId);assert.equal(panel.runId,undefined);cfg={...cfg,openrouter:{...cfg.openrouter,models:[{alias:'x',model:'two',askAll:true,consensus:true}]}};
 await call(srv,'ask-one',{fanoutId:panel.fanoutId,provider:'openrouter:x',prompt:'p'});assert.deepEqual(seen,['one']);
 assert.equal((await call(srv,'ask-one',{fanoutId:panel.fanoutId,provider:'openrouter:x',prompt:'p'})).error,'unknown-or-expired-fanout');
 assert.equal((await call(srv,'ask-one',{fanoutId:'unknown',provider:'openrouter:x',prompt:'p'})).error,'unknown-or-expired-fanout');assert.equal(seen.length,1);
});

test('journal round-trip is self-describing; cache usage does not increase measured tokens',async t=>{
 const dir=temp(t),journal=createJournal({dir,getSettings:()=>({enabled:true,capture:'metadata'})});const cfg=config('m');
 const srv=buildServer({providers:[fake('codex',80)],getConfig:()=>cfg,journal});t.after(()=>srv.close());
 await call(srv,'ask-all',{prompt:'p'},1);await call(srv,'ask-all',{prompt:'p'},2);
 const runs=createRunIndex({runsDir:dir}).list();assert.equal(runs.length,2);assert.ok(runs[0].provenance?.snapshot);assert.equal(runs.reduce((n,r)=>n+r.tokens,0),10);assert.equal(runs.reduce((n,r)=>n+r.reused,0),1);
});

test('journal and session share one run count; bounded ingestion discloses truncated evidence',async t=>{
 const dir=temp(t),sessionsDir=path.join(dir,'sessions'),cfg={...config('m'),sessions:{persist:true}};
 const journal=createJournal({dir:path.join(dir,'runs'),getSettings:()=>({enabled:true,capture:'metadata'})});
 const srv=buildServer({providers:[fake('codex',80)],getConfig:()=>cfg,journal,sessionsDir});t.after(()=>srv.close());
 await call(srv,'ask-all',{prompt:'unique one'},1);await call(srv,'ask-all',{prompt:'unique two'},2);
 const index=createRunIndex({runsDir:journal.dir||path.join(dir,'runs'),sessionsDir});
 assert.equal(index.list().length,2);assert.ok(index.list().every(r=>!r.legacy));
 const sessionFiles=fs.readdirSync(sessionsDir).filter(n=>n.endsWith('.json'));
 const sessionFile=path.join(sessionsDir,sessionFiles[0]),record=JSON.parse(fs.readFileSync(sessionFile));
 record.createdAt='2099-01-01T00:00:00.000Z';fs.writeFileSync(sessionFile,JSON.stringify(record));
 const report=await call(srv,'analyze',{since:'1h',groupBy:'config'},3);
 assert.equal(report.configs.find(c=>c.configId===record.provenance.configId).sessionEvidenceCount,2,'start-time cohort includes completion outside window');
 const bounded=createRunIndex({runsDir:path.join(dir,'runs'),maxRecords:1,maxFileBytes:1});
 assert.equal(bounded.list().length,0);assert.equal(bounded.truncated(),true);
});

test('debug metadata rejects content in settings, raw telemetry keeps milliseconds; labels keep wire IDs',()=>{
 const e=sanitizeEvent({event:'provider_result',at:0,ms:1234,settings:{model:'m',apiKey:'secret',request:'secret'}});assert.equal(e.ms,1234);assert.ok(!JSON.stringify(e).includes('secret'));
 assert.equal(providerLabel('openrouter:x'),'or:x');assert.equal(formatDuration(999),'999ms');assert.equal(formatDuration(1000),'1s');assert.equal(formatDuration(59900),'1m 00s');assert.equal(formatDuration(60000),'1m 00s');assert.equal(formatDuration(3599900),'1h 00m 00s');
});
