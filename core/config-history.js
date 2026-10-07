"use strict";
// Only this allowlist can enter provenance. Paths, connection credentials and
// display/retention preferences never participate in identities or manifests.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const KEYS = ['model','alias','enabled','askAll','consensus','experts','reasoningEffort','consensusReasoningEffort','reasoning_effort','consensus_reasoning_effort','temperature','timeout','timeoutMs','default','askEffort','consensusEffort','effortSource','source'];
/** @param {any} obj @param {string[]} keys */
function pick(obj, keys) {
  return Object.fromEntries(keys.flatMap(k=>{
    const v=obj?.[k];if(v===undefined)return [];
    if(['experts'].includes(k))return Array.isArray(v)&&v.every(x=>typeof x==='string')?[[k,v]]:v===null?[[k,null]]:[];
    if(k==='arbiter'&&v&&typeof v==='object')return typeof v.model==='string'?[[k,{model:v.model}]]:[];
    return v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v)?[[k,v]]:[];
  }));
}
/** @param {any} v @returns {any} */
function canonical(v) { if(Array.isArray(v)) return v.map(canonical); if(v && typeof v==='object') return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])); return v; }
/** @param {any} cfg @param {any} [active] */
function snapshot(cfg, active) {
  return canonical({version:1, providers:Object.fromEntries(['codex','gemini','grok','openrouter'].map(k=>[k,{enabled:cfg.providers?.[k]?.enabled!==false}])),
    activeProviders:Object.fromEntries(Object.entries(active||{}).filter(([k])=>['codex','gemini','grok','openrouter'].includes(k)).map(([k,v])=>[k,pick(v,KEYS)])), openrouter:pick(cfg.openrouter,['enabled','maxFanout','defaultModel','allowRawModel']),
    defaults:pick(cfg.openrouter?.defaults,KEYS), models:(cfg.openrouter?.models||[]).map((/** @type {any} */ m)=>pick(m,KEYS)),
    consensus:pick(cfg.consensus,['arbiter','blindVote','maxRounds','maxWallMs','quorumFloor','reasoningEffort']),
    timeoutPolicy:cfg.timeoutPolicy||'longest-peer',orientation:pick(cfg.orientation,['enabled','maxFiles','maxBytes'])});
}
/** @param {any} s */
function configId(s) { return crypto.createHash('sha256').update(JSON.stringify(canonical(s))).digest('hex'); }
/** @param {any} options */
function makeConfigHistory({getConfig,getActive=()=>({}),getError=()=>null,dir,enabled=()=>false,dashboardEnabled=()=>false}) {
  const runtimeId=crypto.randomUUID(), procStartedAt=Math.round(Date.now()-process.uptime()*1000);
  /** @type {any} */ let current=null;
  /** @type {Map<string,number>} */ const seen=new Map();
  const persisted=new Set();
  /** @type {any} */ let lastManifest=null;
  /** @param {boolean} [shutdown] */
  function publish(shutdown=false) {
    if(!dashboardEnabled() || !current || !dir) return;
    try { const d=path.join(dir,'runtimes');fs.mkdirSync(d,{recursive:true,mode:0o700});

      lastManifest={version:1,runtimeId,pid:process.pid,procStartedAt,...current,lastSeenAt:Date.now(),shutdown};
      writePrivate(d,runtimeId,lastManifest);
      // Bounded observed inventory; retention is not a complete process census.
      const files=fs.readdirSync(d).filter(n=>/^[a-f0-9-]+\.json$/.test(n)).map(n=>({n,at:fs.statSync(path.join(d,n)).mtimeMs})).sort((a,b)=>b.at-a.at);
      for(const f of files.slice(200)) fs.rmSync(path.join(d,f.n),{force:true});
    } catch { /* telemetry cannot fail delegation */ }
  }
  function observe() {
    const cfg=getConfig()||{},error=getError();
    if(error) return {runtimeId,configId:null,configLoadState:'invalid'};
    const active=getActive();const s=snapshot(cfg,active),id=configId(s),now=Date.now();
    if(!current || current.configId!==id) {
      if(!seen.has(id)) { const old=dir&&enabled()?readHistory(dir).find(r=>r.configId===id):null;seen.set(id,old?.firstSeenAt??now); }
      current={runtimeId,configId:id,activationId:crypto.randomUUID(),activatedAt:now,firstSeenAt:seen.get(id),snapshot:s,configLoadState:cfg.configLoadState==='missing'?'missing':'valid'};
    }
    const pending=snapshot(cfg,getActive(true));
    current={...current,configLoadState:cfg.configLoadState==='missing'?'missing':'valid',pendingConfigId:configId(pending)!==id?configId(pending):null,pendingSnapshot:configId(pending)!==id?pending:null};
    if(enabled()&&dir&&!persisted.has(current.activationId))try{writePrivate(dir,current.activationId,current);prune(dir,500);persisted.add(current.activationId);}catch{}
    publish();return {...current};
  }
  const timer=setInterval(()=>{try{observe();}catch{}},30000);timer.unref();
  return {observe,runtimeId,close(){clearInterval(timer);publish(true);},manifest:()=>lastManifest};
}
// Atomic unique records avoid shared-file compaction/append races across runtimes.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** @param {string} dir @param {string} id @param {any} record */
function writePrivate(dir,id,record) {
  if(!UUID.test(id))throw new Error('invalid history ID');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid()))throw new Error('untrusted history directory');
  fs.chmodSync(dir,0o700);
  const content=JSON.stringify(record);
  if(Buffer.byteLength(content)>65536)throw new Error('history record exceeds size limit');
  const file=path.join(dir,id+'.json'),temp=path.join(dir,id+'.'+crypto.randomUUID()+'.tmp');
  try {fs.writeFileSync(temp,content,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);} finally {fs.rmSync(temp,{force:true});}
}
/** @param {string} dir @param {number} cap */
function prune(dir,cap) {
  const files=fs.readdirSync(dir).filter(n=>UUID.test(n.slice(0,-5))&&n.endsWith('.json')).map(n=>({n,at:fs.lstatSync(path.join(dir,n)).mtimeMs})).sort((a,b)=>b.at-a.at);
  for(const f of files.slice(cap))fs.rmSync(path.join(dir,f.n),{force:true});
}
/** @param {any} s @returns {boolean} */
function validSnapshot(s) {
  if(!s||s.version!==1)return false;
  // Reprojection enforces the nested allowlist even for hand-written manifests.
  const projected=snapshot({providers:s.providers,openrouter:{...s.openrouter,defaults:s.defaults,models:s.models},consensus:s.consensus,timeoutPolicy:s.timeoutPolicy,orientation:s.orientation},s.activeProviders);
  return JSON.stringify(canonical(s))===JSON.stringify(projected);
}
/** @param {any} p */
function safeProvenance(p) {
  if(!p||!UUID.test(p.runtimeId||'')||!UUID.test(p.activationId||'')||!validSnapshot(p.snapshot)||configId(p.snapshot)!==p.configId)return null;
  return {runtimeId:p.runtimeId,activationId:p.activationId,configId:p.configId,snapshot:p.snapshot,
    firstSeenAt:Number.isFinite(p.firstSeenAt)?p.firstSeenAt:undefined,activatedAt:Number.isFinite(p.activatedAt)?p.activatedAt:undefined,
    startedAt:Number.isFinite(p.startedAt)?p.startedAt:undefined,runId:typeof p.runId==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(p.runId)?p.runId:undefined,configLoadState:p.configLoadState==='missing'?'missing':'valid'};
}
/** Content-free dispatch metadata only. @param {any} p @returns {any} */
function safeCallProvenance(p) {
  if(!p||typeof p!=='object')return null;
  return {...safeProvenance(p),...(/^[a-f0-9]{64}$/.test(p.configId)?{configId:p.configId}:{}),...pick(p,['runId','callId','attemptId','configuredTimeoutMs','limitingReason','expert','context','role','round']),
    settings:pick(p.settings,KEYS),...(p.original?{original:safeCallProvenance({...p.original,original:undefined})}: {})};
}
/** @param {string} dir @param {number} [cap] @returns {any[]} */
function readRecords(dir,cap=500) {
  try {
    const stat=fs.lstatSync(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid()))return [];
    return fs.readdirSync(dir).filter(n=>n.endsWith('.json')&&UUID.test(n.slice(0,-5))).map(n=>({n,s:fs.lstatSync(path.join(dir,n))})).filter(f=>f.s.isFile()&&!f.s.isSymbolicLink()&&f.s.size<=65536).sort((a,b)=>b.s.mtimeMs-a.s.mtimeMs).slice(0,cap).flatMap(f=>{try{
      const fd=fs.openSync(path.join(dir,f.n),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      let m;
      try {const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>65536||(process.getuid&&stat.uid!==process.getuid()))return [];m=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
      const p=safeProvenance(m);
      if(!p)return [];
      const pending=m.pendingSnapshot&&validSnapshot(m.pendingSnapshot)&&configId(m.pendingSnapshot)===m.pendingConfigId?m.pendingSnapshot:null;
      return [{...p,...pick(m,['version','pid','procStartedAt','lastSeenAt','shutdown']),pendingConfigId:pending?m.pendingConfigId:null,pendingSnapshot:pending}];
    }catch{return [];}});
  }catch{return [];}
}
/** @param {string} dir */
function readHistory(dir) {return readRecords(dir);}
/** Validate read-only ingestion; no process probes, no model calls. @param {string} dir */
function readRuntimes(dir) {
  return readRecords(path.join(dir,'runtimes'),200).filter(m=>m.version===1&&UUID.test(m.runtimeId)&&Number.isFinite(m.lastSeenAt)&&Number.isFinite(m.procStartedAt)&&(!m.pendingSnapshot||validSnapshot(m.pendingSnapshot))).map(m=>({...m,freshness:m.shutdown?'shutdown':Date.now()-m.lastSeenAt<90000?'recently observed':'stale / unknown'}));
}
module.exports={canonical,snapshot,configId,makeConfigHistory,readRuntimes,readHistory,safeProvenance,validSnapshot,safeCallProvenance};
