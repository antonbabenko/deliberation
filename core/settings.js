"use strict";
/** Resolve once, before cache/dispatch/introspection. Request overrides are separate from the baseline.
 * @param {string} name @param {any} cfg @param {any} [req] @param {any} [env] */
function resolveSettings(name,cfg={},req={},env=process.env) {
  const c=cfg.providers?.[name]||{},d=cfg.openrouter?.defaults||{};
  const alias=name.startsWith('openrouter:')?cfg.openrouter?.models?.find((/** @type {any} */ m)=>m.alias===name.slice(11)):null;
  const base=name.startsWith('openrouter:')?'openrouter':name;
  const provider=cfg.providers?.[base]||{};
  const ask=alias?.reasoning_effort??(base==='openrouter'?d.reasoning_effort:c.reasoningEffort)??(base==='grok'?env.GROK_REASONING_EFFORT||'high':null);
  const consensus=alias?.consensus_reasoning_effort??(base==='openrouter'?d.consensus_reasoning_effort:c.consensusReasoningEffort)??ask;
  const defaultModel=cfg.openrouter?.models?.find((/** @type {any} */m)=>m.alias===cfg.openrouter?.defaultModel)?.model??cfg.openrouter?.defaultModel;
  const model=alias?.model??c.model??(base==='codex'?'CLI inherited / unknown':base==='gemini'?env.GEMINI_DEFAULT_MODEL||'auto-gemini-3':base==='grok'?env.GROK_DEFAULT_MODEL||'grok-4.6':req.model||defaultModel||'');
  const fused=base==='gemini'&&/^gemini-/.test(model)?model.match(/(?:^|-)(low|medium|high)(?:$|-)/)?.[1]:null;
  const effort=base==='gemini'?fused:ask;
  return {model:req.model??model, reasoningEffort:req.reasoningEffort??(req.context==='consensus'?consensus:effort)??undefined,
    askEffort:effort??'inherited / unknown',consensusEffort:(base==='gemini'?fused:consensus)??'inherited / unknown',
    effortSource:base==='gemini'?(fused?'model pin':'CLI inherited / unknown'):alias||c.reasoningEffort||c.consensusReasoningEffort||base==='openrouter'?'config/default resolution':base==='grok'?'environment / built-in':'CLI inherited / unknown',
    temperature:req.temperature??alias?.temperature??(base==='openrouter'?d.temperature:undefined),
    timeoutMs:req.timeoutMs??alias?.timeout??provider.timeout??cfg.providers?.defaults?.timeout??(base==='openrouter'?d.timeout:undefined)??(base==='codex'?600000:base==='gemini'?300000:180000)};
}
/** @param {any} cfg @param {any} startup */
function effectiveConfig(cfg,startup) {
  return {...cfg,providers:Object.fromEntries(Object.entries({...startup.providers,...cfg.providers}).map(([name,c])=>[name,{...(startup.providers?.[name]||{}),enabled:/** @type {any} */ (c)?.enabled}]))};
}
module.exports={resolveSettings,effectiveConfig};
