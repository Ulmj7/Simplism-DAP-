import type { EngineSnapshot, PresentationEffect, SemanticRegistry, WalkthroughCatalog } from "@dap/walkthrough";
import type { Overlay, Targets } from "@dap/walkthrough/dom";
import { copy } from "./copy.js";
import { stepProgress } from "./progress.js";
export function createPresenter({overlay,targets,registry,catalog,state,cancel,ack,complete}:{overlay:Overlay;targets:Targets;registry:SemanticRegistry;catalog:WalkthroughCatalog;state:()=>EngineSnapshot;cancel:()=>void;ack:()=>void;complete:(text:string)=>void}) {
 const apply=(effect:PresentationEffect)=>{
  if(effect.type==="clear"){overlay.hide();return;}
  const snapshot=state();if(snapshot.status==="COMPLETED"){overlay.hide();complete(effect.text);return;}
  const def=snapshot.walkthroughId===null?undefined:catalog.get(snapshot.walkthroughId);if(!def)throw new Error("Missing walkthrough");
  const handle=effect.target===undefined?null:targets.find(effect.target);if(effect.target!==undefined&&!handle)throw new Error("Unavailable target");
  const progress=stepProgress(def,effect.stepId);const c=copy.guide;
  overlay.show(handle,{title:effect.target===undefined?def.title:registry.get(effect.target)!.label,text:effect.text,...(progress.extra?{progress:c.extra}:progress.index>0?{progress:`${c.step} ${progress.index} ${c.of} ${progress.total}`}:{ }),hint:effect.expects==="ack"?"":c[effect.expects],ack:effect.expects==="ack",ackLabel:c.ack,cancelLabel:c.cancel,escapeHint:c.escape},{onCancel:cancel,onAck:ack});
 };
 return {apply,update(snapshot:EngineSnapshot){if(snapshot.status==="VERIFYING")overlay.update({status:copy.guide.checking,ackDisabled:true});else if(snapshot.status==="WAITING")overlay.update({status:"",ackDisabled:false});}};
}
