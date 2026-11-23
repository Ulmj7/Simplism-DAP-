import type { EngineSnapshot } from "@dap/walkthrough";
import { h } from "./dom.js";
import { copy } from "./copy.js";
import { button } from "./ui/pieces.js";
export type ResultKind="completed"|"cancelled"|"blocked"|"temporarily-unavailable";
export function resultKind(snapshot:EngineSnapshot):ResultKind|null {
 if(snapshot.status==="COMPLETED")return "completed";if(snapshot.status==="CANCELLED")return "cancelled";
 if(snapshot.status!=="FAILED")return null;return snapshot.failure==="verification_failed"||snapshot.failure==="max_attempts"?"blocked":"temporarily-unavailable";
}
let serial=0;
export function createStatusDialog(doc:Document,fallback:()=>HTMLElement|null) {
 let dialog:HTMLDialogElement|null=null;let message:HTMLElement|null=null;let returnTo:HTMLElement|null=null;
 const close=(restore=true)=>{if(!dialog)return;try{if(dialog.open&&typeof dialog.close==="function")dialog.close();}catch{/* fallback */}dialog.remove();dialog=null;message=null;if(restore)(returnTo?.isConnected?returnTo:fallback())?.focus();};
 return {isOpen:()=>dialog!==null,close,updateText(text:string){if(message)message.textContent=text;},
 show(kind:ResultKind,text:string,options:{returnTo:HTMLElement|null;retry:()=>void;onDismiss?:()=>void}) {
  close(false);returnTo=options.returnTo;const c=copy.result;
  dialog=h("dialog",{class:"dap-result",role:"dialog","aria-modal":"true","data-ai-ignore":true}) as HTMLDialogElement;
  const title=h("h2",{id:`dap-result-title-${++serial}`},kind==="temporarily-unavailable"?c.unavailable:c[kind]);message=h("p",{id:`dap-result-message-${serial}`},kind==="completed"?text:kind==="cancelled"?c.cancelledText:kind==="blocked"?c.blockedText:c.unavailableText);
  dialog.setAttribute("aria-labelledby",title.id);dialog.setAttribute("aria-describedby",message.id);
  const actions=h("div",{class:"result-actions"});
  if(kind==="blocked"){const retry=button(c.retry,true);retry.addEventListener("click",()=>{close();options.retry();});actions.append(retry);}
  const dismiss=()=>{close();options.onDismiss?.();};
  const done=button(kind==="completed"?c.done:c.close,kind!=="blocked");done.addEventListener("click",dismiss);actions.append(done);dialog.append(title,message,actions);
  for(const node of [dialog,...Array.from(dialog.querySelectorAll<HTMLElement>("*"))])node.setAttribute("data-ai-ignore","");
  dialog.addEventListener("cancel",event=>{event.preventDefault();dismiss();});
  dialog.addEventListener("keydown",event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();dismiss();}if(event.key==="Tab"&&dialog){const controls=Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"));const first=controls[0]!,last=controls[controls.length-1]!;if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first.focus();}}});
  doc.body.append(dialog);if(typeof dialog.showModal==="function"){try{dialog.showModal();}catch{dialog.setAttribute("open","");}}else dialog.setAttribute("open","");
  actions.querySelector<HTMLButtonElement>("button")?.focus();
 },destroy(){close(false);returnTo=null;}};
}
