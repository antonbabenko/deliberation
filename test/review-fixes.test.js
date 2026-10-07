"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {getEventListeners}=require('node:events');
const {buildServer,makeLineReader}=require('../server/mcp/index.js');
const {askOne}=require('../core/orchestrate.js');
const {makeResultCache}=require('../core/result-cache.js');
const {createJournal}=require('../core/journal.js');
const {readEvents}=require('../server/dashboard/runs.js');
const {analyzeConfigs}=require('../core/config-analysis.js');
const {resolveSettings}=require('../core/settings.js');
const {combineSignals}=require('../core/signals.js');
const cfg={providers:{codex:{enabled:true},grok:{enabled:true}},openrouter:{models:[]}};
const provider=(name,limit=400,delay=1)=>({name,capabilities:{walksFilesystem:true},health:async()=>({ok:true}),resolveSettings:req=>({model:'fixture',timeoutMs:req.timeoutMs??limit}),ask:async req=>{await new Promise(r=>setTimeout(r,delay));return {provider:name,model:'fixture',text:'answer',isError:false,ms:delay};}});
const message=(id,name,args)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
const parse=r=>{assert.equal(r.error,undefined);return JSON.parse(r.result.content[0].text);};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'delib-review-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,journal:createJournal({dir,getSettings:()=>({enabled:true,capture:'metadata'})})};}

test('fanoutId-only members preserve one run start, peer roles and configured caps without AbortSignal.any',async t=>{
 const {dir,journal}=fixture(t),any=AbortSignal.any;AbortSignal.any=undefined;t.after(()=>{AbortSignal.any=any;});
 const srv=buildServer({providers:[provider('codex',400),provider('grok',100)],getConfig:()=>cfg,journal});t.after(()=>srv.close());
 const panel=parse(await srv.handle(message(1,'panel',{})));
 const outputs=await Promise.all(panel.providers.map((p,i)=>srv.handle(message(i+2,'ask-one',{fanoutId:panel.fanoutId,provider:p,prompt:'group'}))));
 assert.ok(outputs.every(r=>!parse(r).result.isError));
 const events=readEvents(path.join(dir,panel.runId+'.jsonl')).events;
 assert.deepEqual(events.filter(e=>e.kind==='run_start').map(e=>e.workflow),['fanout']);
 assert.equal(events.filter(e=>e.kind==='run_end').length,1);
 for(const start of events.filter(e=>e.kind==='call_start')){
  assert.equal(start.role,'peer');assert.equal(start.configuredTimeoutMs,start.provider==='codex'?400:100);
  assert.equal(start.limitingReason,'longest-peer / outer budget');
 }
});

test('same-chunk cancellation reaches a pending MCP call and siblings dispatch together',async t=>{
 const srv=buildServer({providers:[provider('codex',400,300),provider('grok',100,200)],getConfig:()=>cfg});t.after(()=>srv.close());
 const outputs=[],read=makeLineReader(srv,r=>outputs.push(r));
 await read(JSON.stringify(message(1,'ask-one',{provider:'codex',prompt:'cancel'}))+'\n'+JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}})+'\n');
 assert.equal(parse(outputs[0]).result.isError,true);assert.match(parse(outputs[0]).result.message,/cancelled/i);
 const panel=parse(await srv.handle(message(2,'panel',{})));
 await read(panel.providers.map((p,i)=>JSON.stringify(message(i+3,'ask-one',{fanoutId:panel.fanoutId,provider:p,prompt:'parallel'}))).join('\n')+'\n');
 assert.equal(outputs.length,3);assert.ok(outputs.filter(r=>r.id>=3).every(r=>!parse(r).result.isError));
});

test('line reader initializes before dispatch and delivers responses while a call is pending',async()=>{
 let initialized=false,release;const waiting=new Promise(r=>{release=r;}),seen=[];
 const srv={handle:async m=>{if(m.method==='initialize'){initialized=true;return {id:m.id,result:{}};}if(m.method===undefined){release();return;}assert.ok(initialized);seen.push(m.id);await waiting;return {id:m.id,result:{}};}};
 const read=makeLineReader(srv,r=>seen.push(`response:${r.id}`));
 const pending=read(JSON.stringify({id:1,method:'initialize'})+'\n'+JSON.stringify(message(2,'x',{}))+'\n');
 await new Promise(r=>setImmediate(r));assert.ok(seen.includes(2));await read(JSON.stringify({id:99,result:{}})+'\n');await pending;assert.ok(seen.includes('response:2'));
});

test('returned provenance is allowlisted and cache results share debug/journal call IDs',async t=>{
 const {dir,journal}=fixture(t),rawCfg={...cfg,debug:{path:'PRIVATE_SENTINEL'},openrouter:{models:[],apiBase:'PRIVATE_ENDPOINT'}};
 const srv=buildServer({providers:[provider('codex')],getConfig:()=>rawCfg,journal});t.after(()=>srv.close());
 const one=parse(await srv.handle(message(1,'ask-all',{prompt:'reuse'}))),two=parse(await srv.handle(message(2,'ask-all',{prompt:'reuse'})));
 assert.ok(!JSON.stringify([one,two]).includes('PRIVATE_'));assert.ok(JSON.stringify(two).includes('"cached":true'));
 for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl'))){const events=readEvents(path.join(dir,file)).events;const start=events.find(e=>e.kind==='call_start'),end=events.find(e=>e.kind==='call_end');assert.equal(start.callId,end.callId);assert.equal(end.provenance.callId,start.callId);}
 const cache=makeResultCache(),logs=[],p=provider('codex'),req={prompt:'direct',provenance:{config:'PRIVATE_SENTINEL'}};
 const a=await askOne(p,req,{cache,logger:{logEvent:e=>logs.push(e)}}),b=await askOne(p,req,{cache,logger:{logEvent:e=>logs.push(e)}});
 assert.ok(a.provenance.callId);assert.notEqual(a.provenance.callId,b.provenance.callId);assert.equal(b.provenance.callId,logs.at(-1).callId);assert.ok(!JSON.stringify(b).includes('PRIVATE_'));
});

test('legacy session evidence counts without synthetic elapsed or quality samples',()=>{
 const legacy={runId:'old',legacy:true,startedAt:90,endedAt:90,status:'done',tokens:0};
 const r=analyzeConfigs([],[],[legacy],{}, {groupBy:'config',configId:'unknown',nowMs:100,windowMs:20});
 assert.equal(r.cohortRuns.length,1);assert.equal(r.configs[0].runCount,1);assert.equal(r.configs[0].legacyRuns,1);assert.equal(r.configs[0].elapsed.samples,0);assert.equal(r.configs[0].freshQualityRuns,0);assert.match(r.meta.timeBoundary,/record time/);
});

test('Gemini effort metadata follows the fused model for ask and consensus, independent of ignored overrides',()=>{
 const c={providers:{gemini:{model:'gemini-3.8-flash-high',consensusReasoningEffort:'medium'}}};
 for(const context of ['ask','consensus']){const s=resolveSettings('gemini',c,{context,reasoningEffort:'low',model:'ignored'});assert.equal(s.model,'gemini-3.8-flash-high');assert.equal(s.reasoningEffort,'high');assert.equal(s.consensusEffort,'high');}
 assert.equal(resolveSettings('gemini',{providers:{gemini:{model:'auto-gemini-3'}}},{reasoningEffort:'high'}).reasoningEffort,undefined);
});

test('composed cancellation releases listeners on settle and preserves preexisting abort',()=>{
 const a=new AbortController(),b=new AbortController(),joined=combineSignals([a.signal,b.signal]);
 assert.equal(getEventListeners(a.signal,'abort').length,1);joined.dispose();assert.equal(getEventListeners(a.signal,'abort').length,0);assert.equal(getEventListeners(b.signal,'abort').length,0);
 a.abort('stop');const cancelled=combineSignals([a.signal,b.signal]);assert.equal(cancelled.signal.aborted,true);assert.equal(cancelled.signal.reason,'stop');assert.equal(getEventListeners(b.signal,'abort').length,0);
});

test('progressive Gemini provenance retains the actual model pin despite unsupported request overrides',async t=>{
 const c={...cfg,providers:{gemini:{model:'gemini-3.8-flash-high',consensusReasoningEffort:'medium'}}};
 let pin;
 const gemini=require('../core/providers/antigravity.js').makeAntigravityProvider({model:c.providers.gemini.model,bridge:{buildAgyArgs:args=>{pin=args.model;return [];},runGemini:async()=>({response:'answer'})}});
 const srv=buildServer({providers:[gemini],getConfig:()=>c});t.after(()=>srv.close());
 const panel=parse(await srv.handle(message(1,'panel',{})));
 const out=parse(await srv.handle(message(2,'ask-one',{provider:'gemini',fanoutId:panel.fanoutId,prompt:'pin',model:'ignored',reasoningEffort:'low'})));
 assert.equal(pin,'gemini-3.8-flash-high');assert.equal(out.result.model,pin);assert.equal(out.result.provenance.settings.model,pin);assert.equal(out.result.provenance.settings.reasoningEffort,'high');
});

test('cancellation during rate-limit backoff does not create another attempt',async()=>{
 const controller=new AbortController(),events=[],logs=[];let calls=0;
 const p={...provider('grok'),ask:async()=>{calls++;setImmediate(()=>controller.abort());return {provider:'grok',model:'fixture',ms:1,isError:true,errorKind:'rate-limit',retryable:true,retryAfterMs:50};}};
 await askOne(p,{prompt:'retry',signal:controller.signal},{logger:{logEvent:e=>logs.push(e)},trace:{journal:{emit:(_id,kind,e)=>events.push({kind,...e})},runId:'retry'}});
 assert.equal(calls,1);assert.equal(events.filter(e=>e.kind==='call_start').length,1);assert.equal(logs.filter(e=>e.event==='provider_result').length,1);
});
