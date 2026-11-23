import type { WalkthroughDef } from "@dap/walkthrough";
/** Primary path follows next only; recover-only guides have an extra-step label, never an index beyond total. */
export function stepProgress(def:WalkthroughDef,stepId:string):{index:number;total:number;extra:boolean} {
 const seen=new Set<string>();const primary:string[]=[];let id=def.start;
 while(!seen.has(id)){seen.add(id);const step=def.steps.find(s=>s.id===id);if(!step||step.kind==="complete")break;if(step.kind==="guide")primary.push(id);id=step.next;}
 const index=primary.indexOf(stepId);return {index:index<0?0:index+1,total:primary.length,extra:!seen.has(stepId)};
}
