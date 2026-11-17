"use strict";
const { useGeminiApi, DEFAULT_GEMINI_API_MODEL } = require("./providers/gemini.js");
/** Resolve once, before cache/dispatch/introspection. Request overrides are separate from the baseline.
 * @param {string} name @param {any} cfg @param {any} [req] @param {any} [env] */
function resolveSettings(name,cfg={},req={},env=process.env) {
  const c=cfg.providers?.[name]||{},d=cfg.openrouter?.defaults||{};
  // Pinned delegates are named `<provider>:<alias>` (openrouter, ollama, lmstudio).
  const sep=name.indexOf(':');
  const alias=sep>0?cfg.openrouter?.models?.find((/** @type {any} */ m)=>m.alias===name.slice(sep+1)):null;
  const base=sep>0?name.slice(0,sep):name;
  const provider=cfg.providers?.[base]||{};
  // Gemini over the API key: an API model id and a per-call effort, unlike agy's fused ids.
  const geminiApi=base==='gemini'&&useGeminiApi(c.transport,env);
  const agy=base==='gemini'&&!geminiApi;
  const preset=base==='openrouter'?(req.preset??alias?.preset??provider.preset??cfg.openrouter?.preset??d.preset):undefined;
  const ask=alias?.reasoning_effort??(base==='openrouter'?d.reasoning_effort:c.reasoningEffort)??(base==='grok'?env.GROK_REASONING_EFFORT||'high':null);
  const consensus=alias?.consensus_reasoning_effort??(base==='openrouter'?d.consensus_reasoning_effort:c.consensusReasoningEffort)??ask;
  const defaultModel=cfg.openrouter?.models?.find((/** @type {any} */m)=>m.alias===cfg.openrouter?.defaultModel)?.model??cfg.openrouter?.defaultModel;
  const model=geminiApi?(c.apiModel||DEFAULT_GEMINI_API_MODEL):alias?.model??c.model??(base==='codex'?'CLI inherited / unknown':base==='gemini'?env.GEMINI_DEFAULT_MODEL||'auto-gemini-3':base==='grok'?env.GROK_DEFAULT_MODEL||'grok-4.6':req.model||defaultModel||'');
  const fused=agy&&/^gemini-/.test(model)?model.match(/(?:^|-)(low|medium|high)(?:$|-)/)?.[1]:null;
  const effort=agy?fused:ask;
  return {model:base==='gemini'?model:req.model??model, preset, reasoningEffort:agy?(fused??undefined):req.reasoningEffort??(req.context==='consensus'?consensus:effort)??undefined,
    askEffort:effort??'inherited / unknown',consensusEffort:(agy?fused:consensus)??'inherited / unknown',
    effortSource:agy?(fused?'model pin':'CLI inherited / unknown'):alias||c.reasoningEffort||c.consensusReasoningEffort||base==='openrouter'?'config/default resolution':base==='grok'?'environment / built-in':geminiApi?'request / API default':'CLI inherited / unknown',
    temperature:req.temperature??alias?.temperature??(base==='openrouter'?d.temperature:undefined),
    timeoutMs:req.timeoutMs??alias?.timeout??provider.timeout??cfg.providers?.defaults?.timeout??(base==='openrouter'?d.timeout:undefined)??(base==='codex'?600000:base==='gemini'?300000:180000)};
}
/** @param {any} cfg @param {any} startup */
function effectiveConfig(cfg,startup) {
  return {...cfg,providers:Object.fromEntries(Object.entries({...startup.providers,...cfg.providers}).map(([name,c])=>[name,{...(startup.providers?.[name]||{}),enabled:/** @type {any} */ (c)?.enabled}]))};
}
module.exports={resolveSettings,effectiveConfig};
