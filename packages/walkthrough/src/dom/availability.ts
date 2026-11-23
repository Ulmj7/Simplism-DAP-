import type { SemanticRegistry } from "../semantic/types.js";
import type { SemanticEvent } from "../engine/events.js";
import type { Targets } from "./targets.js";
/** Trusted DOM availability changes only; no element or value reaches the runtime. */
export function createAvailabilityFeed({registry,targets,dispatch}:{registry:SemanticRegistry;targets:Targets;dispatch:(event:SemanticEvent)=>void}) {
 const last=new Map<string,boolean>();let destroyed=false;let refreshing=false;
 const refresh=()=>{if(destroyed||refreshing)return;refreshing=true;try{for(const def of registry.list()) {const available=targets.find(def.id)!==null;const previous=last.get(def.id);last.set(def.id,available);if(previous!==undefined&&previous!==available) {try{dispatch({type:available?"targetAvailable":"targetGone",id:def.id});}catch{/* subscriber failure */}}}}finally{refreshing=false;}};
 refresh();const stop=targets.observe(refresh);
 return {refresh,destroy(){if(destroyed)return;destroyed=true;stop();last.clear();}};
}
