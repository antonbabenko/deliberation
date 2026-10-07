"use strict";
const core=require('./analyze.js');
const {safeProvenance}=require('./config-history.js');
const UNKNOWN='unknown';
/** @param {any} args */
function validateFilters(args={}) {
  if(args.configId!==undefined&&args.configId!==UNKNOWN&&!/^[a-f0-9]{64}$/.test(args.configId))return {error:'invalid-configId'};
  if(args.activationId!==undefined&&!/^[a-f0-9-]{36}$/.test(args.activationId))return {error:'invalid-activationId'};
  if(args.groupBy!==undefined&&args.groupBy!=='config')return {error:'invalid-groupBy'};
  if(args.since!==undefined&&!core.parseWindowMs(args.since).ok)return {error:'invalid-since'};
  return {};
}
/** @param {any} r */
const provenanceOf=r=>safeProvenance(r?.provenance||r);
/** @param {any} r */
const identity=r=>provenanceOf(r)?.configId||(/^[a-f0-9]{64}$/.test(r?.configId)?r.configId:UNKNOWN);
/** @param {any[]} events @param {any[]} records @param {any[]} runs @param {any} cfg @param {any} meta */
function analyzeConfigs(events,records,runs,cfg,meta={}) {
  const grouped=meta.groupBy==='config'||!!meta.configId||!!meta.activationId;
  const now=meta.nowMs??Date.now(),from=meta.windowMs?now-meta.windowMs:-Infinity;
  /** @param {number} t */
  const inTime=t=>(!meta.windowMs&&!grouped)||Number.isFinite(t)&&t>=from&&t<=now;
  /** @param {any} r */
  const matches=r=>(!meta.configId||identity(r)===meta.configId)&&(!meta.activationId||(provenanceOf(r)?.activationId||r.activationId)===meta.activationId);
  const chosenRuns=runs.filter(r=>inTime(r.startedAt)&&matches(r));
  const chosenRecords=records.filter(r=>inTime(r.provenance?.startedAt??Date.parse(r.createdAt))&&matches(r));
  /** @type {Map<string,number>} */ const origins=new Map(/** @type {any} */ ([...runs.map(r=>[r.runId,r.startedAt]),...records.map(r=>[r.runId,r.provenance?.startedAt??Date.parse(r.createdAt)])]));
  const chosenEvents=events.filter(e=>matches(e)&&inTime(e.runStartedAt??origins.get(e.runId)??e.at));
  /** @type {any} */ const result=core.buildAnalysis(chosenEvents,chosenRecords,cfg,{...meta,cohortSelected:true,configuredOnly:grouped?false:meta.configuredOnly});
  result.meta.timeBoundary='run start in closed [from, now]; legacy sessions without a recorded start use record time, uncorrelated events use event time';
  /** @type {Map<string,any>} */const groups=new Map();
  const allEvidence=[...(meta.history||[]),...runs,...records,...events];
  for(const r of allEvidence) {
    const id=identity(r);if(groups.has(id))continue;
    const p=provenanceOf(r);groups.set(id,{configId:id,label:id===UNKNOWN?'Unknown / legacy config':`Config ${id.slice(0,12)}`,snapshot:p?.snapshot||null,firstSeenAt:p?.firstSeenAt||r.startedAt||r.at||null});
  }
  for(const g of groups.values()) {
    if(g.configId===UNKNOWN)continue;
    let length=12;
    while(length<64&&[...groups.keys()].some(id=>id!==g.configId&&id.startsWith(g.configId.slice(0,length))))length++;
    g.label=`Config ${g.configId.slice(0,length)}`;
  }
  const groupsOut=[];
  for(const g of groups.values()) {
    const rs=chosenRuns.filter(r=>identity(r)===g.configId),es=chosenEvents.filter(e=>identity(e)===g.configId),recs=chosenRecords.filter(r=>identity(r)===g.configId);
    const terminal=rs.filter(r=>r.endedAt!=null&&r.status!=='running'),fresh=terminal.filter(r=>!r.legacy&&!r.reused);
    const elapsed=fresh.map(r=>r.endedAt-r.startedAt).filter(n=>n>=0).sort((a,b)=>a-b);
    const evidence=[...rs,...recs];
    const activations=new Map();
    for(const r of evidence){const p=provenanceOf(r);if(p)activations.set(p.activationId,{activationId:p.activationId,runtimeId:p.runtimeId,activatedAt:p.activatedAt,firstRunAt:r.startedAt??p.startedAt});}
    const partitions=new Map();
    for(const e of es.filter(e=>e.event==='provider_result')) {
      const key=JSON.stringify([e.tool||'unknown',e.expert||null,e.provider,e.model,e.settings?.reasoningEffort??e.reasoningEffort,e.settings?.temperature??null,e.context||'unknown']);
      const list=partitions.get(key)||[];list.push(e);partitions.set(key,list);
    }
    // Recommendations only compare peers of the same tool/expert/context cohort.
    // Mixed overrides are shown as distinct partitions, never a config quality ranking.
    const detail=core.buildAnalysis(es,recs,cfg,{...meta,windowMs:null,configuredOnly:false});
    const workloads=new Map();
    for(const e of es.filter(e=>e.event==='provider_result'&&!e.cached)) {
      const key=JSON.stringify([e.tool||'unknown',e.expert||null,e.context||'unknown']);
      const list=workloads.get(key)||[];list.push(e);workloads.set(key,list);
    }
    const recordedConfig=g.snapshot?{providers:g.snapshot.activeProviders,openrouter:{...g.snapshot.openrouter,models:g.snapshot.models,defaults:g.snapshot.defaults}}:{};
    const recommendations=[];
    for(const [workload,ev] of workloads) {
      const settingsByProvider=new Map();
      for(const e of ev){const values=settingsByProvider.get(e.provider)||new Set();values.add(JSON.stringify([e.model,e.settings?.reasoningEffort??e.reasoningEffort,e.settings?.temperature??null]));settingsByProvider.set(e.provider,values);}
      if([...settingsByProvider.values()].some(v=>v.size>1))continue;
      // Agreement remains independent: sessions may span other override cohorts.
      recommendations.push(...core.recommend(core.aggregateByModel(ev),[],recordedConfig).map(r=>({...r,configId:g.configId,workload})));
    }
    const timings=rs.map(r=>r.startedAt).filter(Number.isFinite);
    groupsOut.push({...g,activations:[...activations.values()],usagePeriod:timings.length?{from:Math.min(...timings),to:Math.max(...timings)}:null,
      sessionEvidenceCount:recs.length,runCount:rs.length,legacyRuns:rs.filter(r=>r.legacy).length,liveRuns:rs.length-terminal.length,terminalRuns:terminal.length,freshQualityRuns:fresh.length,
      successRuns:fresh.filter(r=>!r.errors&&!['error','unresolved','abandoned'].includes(r.status)).length,
      errorRuns:fresh.filter(r=>r.errors||r.status==='error').length,timeoutAttempts:es.filter(e=>!e.cached&&e.errorKind==='timeout').length,
      elapsed:{p50:elapsed.length?core.percentile(elapsed,50):null,p95:elapsed.length?core.percentile(elapsed,95):null,samples:elapsed.length},
      measuredTokens:rs.reduce((n,r)=>n+(r.tokens||0),0),tokenCoverageRuns:rs.filter(r=>r.tokenCoverage>0).length,
      reusedResults:Math.max(es.filter(e=>e.cached).length,rs.reduce((n,r)=>n+(r.reused||0),0)),retries:rs.reduce((n,r)=>n+(r.retries||0),0),attempts:es.filter(e=>!e.cached&&e.event==='provider_result').length,
      consensus:{runs:terminal.filter(r=>r.workflow?.startsWith('consensus')).length,converged:terminal.filter(r=>r.status==='converged').length,rounds:terminal.reduce((n,r)=>n+(r.rounds||0),0)},
      stats:detail.stats,agreement:detail.agreement,partitions:[...partitions.entries()].map(([key,ev])=>({key,stats:core.aggregateByModel(ev)})),recommendations,
      warnings:[...(rs.length<5?['Small sample: fewer than five whole runs.']:[]),...(rs.some(r=>r.legacy)?['Session-only runs count as evidence; elapsed/outcome quality uses journals only. Legacy sessions without a recorded start use record time.']:[]),'Workload and override partitions are descriptive; no causal config-quality comparison.']});
  }
  /** @type {any} */const out={...result,configs:groupsOut.filter(g=>(!meta.configId||g.configId===meta.configId)),configOptions:[...groups.values()],cohortRuns:chosenRuns};
  out.meta={...result.meta,groupBy:meta.groupBy||null,currentModelFilter:grouped?'ignored for historical groups':'current configuration',
    unknownConfigEvents:chosenEvents.filter(e=>identity(e)===UNKNOWN).length,uncorrelatedEvents:chosenEvents.filter(e=>!e.runId).length,
    reusedResults:chosenEvents.filter(e=>e.cached).length,journalTruncated:!!meta.truncated?.runs,warnings:[...result.meta.warnings,'Journal/session retention may leave gaps; CLI token usage is unknown, never zero.']};
  if(grouped){out.recommendations=[];out.outliers=[];out.compare=[];}
  return out;
}
module.exports={validateFilters,analyzeConfigs};
