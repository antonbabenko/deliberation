"use strict";
/** Compose cancellation without requiring AbortSignal.any (Node 18.17+).
 * Explicit disposal releases listeners when the operation settles first.
 * @param {AbortSignal[]} signals */
function combineSignals(signals) {
  const controller=new AbortController();
  /** @type {Array<()=>void>} */const cleanup=[];
  const dispose=()=>{for(const remove of cleanup.splice(0))remove();};
  for(const signal of signals) {
    const abort=()=>{controller.abort(signal.reason);dispose();};
    if(signal.aborted){abort();break;}
    signal.addEventListener('abort',abort,{once:true});
    cleanup.push(()=>signal.removeEventListener('abort',abort));
  }
  return {signal:controller.signal,dispose};
}
module.exports={combineSignals};
