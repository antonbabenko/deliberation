"use strict";
const {randomUUID}=require('node:crypto');
/** Ephemeral progressive groups, independent of telemetry. @param {any} [opts] */
function makeFanoutGroups({max=1000,idleMs=600000,onClose=()=>{}}={}) {
  /** @type {Map<string,any>} */ const groups=new Map();
  /** @param {any} g @param {string} reason */
  function close(g,reason) {
    if(!groups.delete(g.id))return;
    clearTimeout(g.timer);
    for(const m of g.members.values())m.controller?.abort();
    try{onClose(g,reason);}catch{}
  }
  return {
    /** @param {any[]} providers @param {any} context */
    create(providers,context) {
      if(groups.size>=max)throw new Error('fanout capacity reached');
      const id=randomUUID();
      /** @type {any} */
      const g={id,providers,context,deadlineAt:null,members:new Map(providers.map(p=>[p.name,{state:'pending'}])),timer:null};
      g.timer=setTimeout(()=>close(g,'idle-expired'),idleMs);g.timer.unref();groups.set(id,g);return id;
    },
    /** Reservation is synchronous: concurrent duplicate joins cannot dispatch twice.
     * @param {string} id @param {string} name @param {any} req */
    join(id,name,req) {
      const g=groups.get(id);
      if(!g)return {error:'unknown-or-expired-fanout'};
      const member=g.members.get(name);
      if(!member)return {error:'fanout-nonmember'};
      if(member.state!=='pending')return {error:'duplicate-fanout-dispatch'};
      if(g.deadlineAt!==null&&Date.now()>=g.deadlineAt){close(g,'deadline-expired');return {error:'expired-fanout'};}
      if(g.deadlineAt===null) {
        clearTimeout(g.timer);
        // Every SELECTED peer counts, dispatched or not: the longest one sets the shared ceiling.
        const limits=g.providers.map((/** @type {any} */p)=>p.resolveSettings?.({prompt:'',context:'ask'})?.timeoutMs??600000);
        const longest=Math.max(1,...limits),sharedAt=Date.now()+longest,outerAt=g.context.sharedDeadlineAt??Infinity;
        g.deadlineAt=Math.min(sharedAt,outerAt);
        g.deadlineOrigin=outerAt<=sharedAt?'outer':'shared';
        g.sharedBy=g.providers.filter((/** @type {any} */_p,/** @type {number} */i)=>limits[i]===longest).map((/** @type {any} */p)=>p.name);
        g.sharedLimitMs=longest;
        g.timer=setTimeout(()=>close(g,'deadline-expired'),Math.max(0,g.deadlineAt-Date.now()));g.timer.unref();
      }
      member.state='running';member.controller=new AbortController();
      return {group:g,provider:g.providers.find((/** @type {any} */ p)=>p.name===name),signal:member.controller.signal,deadlineAt:g.deadlineAt,deadlineOrigin:g.deadlineOrigin,sharedBy:g.sharedBy,sharedLimitMs:g.sharedLimitMs};
    },
    /** @param {string} id @param {string} name */
    settle(id,name){const g=groups.get(id);if(!g)return;g.members.get(name).state='settled';if([...g.members.values()].every(m=>m.state==='settled'))close(g,'complete');},
    close(){for(const g of [...groups.values()])close(g,'shutdown');},
    get size(){return groups.size;},
  };
}
module.exports={makeFanoutGroups};
