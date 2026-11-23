/** Presentation only. The legacy text form remains available; content form is a non-modal region. */
import { ATTR_IGNORE } from "../privacy/privacy.js";
import type { TargetHandle } from "./targets.js";
import { placeCard } from "./placement.js";
export interface OverlayCallbacks {readonly onAck?:()=>void;readonly onCancel?:()=>void}
export interface OverlayContent {readonly title:string;readonly text:string;readonly progress?:string;readonly hint?:string;readonly status?:string;readonly ack?:boolean;readonly ackDisabled?:boolean;readonly ackLabel?:string;readonly cancelLabel?:string;readonly escapeHint?:string}
export interface Overlay {show(target:TargetHandle|null,content:string|OverlayContent,callbacks?:OverlayCallbacks):void;hide():void;isShowing():boolean;update(content:Partial<OverlayContent>):void;reposition():void}
let serial=0;
export function createOverlay(doc:Document):Overlay {
 let cleanup:(()=>void)|null=null;let card:HTMLElement|null=null;let ring:HTMLElement|null=null;let scrim:HTMLElement|null=null;let content:OverlayContent|null=null;let update:()=>void=()=>{};let place:()=>void=()=>{};
 const hide=()=>{cleanup?.();cleanup=null;card?.remove();ring?.remove();scrim?.remove();card=null;ring=null;scrim=null;content=null;place=()=>{};update=()=>{};};
 // The card is a polite live region: rewriting text that did not change can make assistive technology read it out again.
 const put=(el:HTMLElement,text:string)=>{if(el.textContent!==text)el.textContent=text;};
 const node=(tag:string,kind:string)=>{const el=doc.createElement(tag);el.setAttribute("data-ai-overlay",kind);el.setAttribute(ATTR_IGNORE,"");return el;};
 return Object.freeze({hide,isShowing:()=>card!==null,update(patch:Partial<OverlayContent>){if(content){content={...content,...patch};update();place();}},reposition:()=>place(),
 show(target:TargetHandle|null,value:string|OverlayContent,callbacks:OverlayCallbacks={}) {
  hide();const view=doc.defaultView;if(!view||!doc.body)return;const legacy=typeof value==="string";
  content=legacy?{title:"Guidance",text:value,ack:true}:value;
  if(target)target.reveal();
  if(target){ring=node("div","ring");ring.className="dap-guide-ring";ring.setAttribute("aria-hidden","true");Object.assign(ring.style,{position:"fixed",boxSizing:"border-box",pointerEvents:"none",zIndex:"2147483000",border:"var(--guide-outline)",borderRadius:"var(--radius-control)",boxShadow:"0 0 0 100vmax var(--dap-scrim)"});doc.body.append(ring);}
  else{scrim=node("div","scrim");scrim.className="dap-guide-scrim";scrim.setAttribute("aria-hidden","true");doc.body.append(scrim);}
  card=node("section","tooltip");card.className="dap-guide-card";card.setAttribute("role",legacy?"dialog":"region");card.setAttribute("aria-live","polite");card.style.position="fixed";card.style.zIndex="2147483001";
  const title=node("h2","title");title.id=`dap-guide-${++serial}`;card.setAttribute("aria-labelledby",title.id);
  const progress=node("p","progress"),message=node("p","message"),hint=node("p","hint"),status=node("p","status"),escape=node("p","escape"),controls=node("div","controls");
  status.setAttribute("role","status");const ack=node("button","ack") as HTMLButtonElement;const cancel=node("button","cancel") as HTMLButtonElement;ack.type="button";cancel.type="button";ack.className="button primary";cancel.className="button";
  ack.addEventListener("click",()=>{if(legacy)hide();callbacks.onAck?.();});cancel.addEventListener("click",()=>{if(legacy)hide();callbacks.onCancel?.();});
  controls.append(ack,cancel);if(legacy)card.append(title,message,progress,hint,status,escape,controls);else card.append(title,progress,message,hint,status,escape,controls);doc.body.append(card);
  update=()=>{if(!content)return;put(title,content.title);put(message,content.text);put(progress,content.progress??"");put(hint,content.hint??"");put(status,content.status??"");put(escape,content.escapeHint??"");put(ack,content.ackLabel??"Got it");put(cancel,content.cancelLabel??"Cancel");const hidden=content.ack!==true;if(ack.hidden!==hidden)ack.hidden=hidden;const off=content.ackDisabled===true;if(ack.disabled!==off)ack.disabled=off;};update();
  place=()=>{
   if(!card)return;
   if(target){const el=target.element;let visible=el.isConnected;for(let n:Element|null=el;n;n=n.parentElement){if(n.hasAttribute("hidden")||n.hasAttribute("inert")||n.getAttribute("aria-hidden")==="true"||view.getComputedStyle(n).display==="none")visible=false;}if(view.getComputedStyle(el).visibility==="hidden")visible=false;if(!visible){hide();return;}}
   const rect=target?.rect()??{left:view.innerWidth/2,top:0,width:0,height:0};
   if(ring)Object.assign(ring.style,{left:`${rect.left-4}px`,top:`${rect.top-4}px`,width:`${rect.width+8}px`,height:`${rect.height+8}px`});
   const scrolled=card.scrollTop; // measuring needs the card uncapped, which makes a browser clamp its scroll offset to 0
   card.style.maxHeight="";const measured=card.getBoundingClientRect();const position=placeCard({target:rect,card:{width:measured.width||320,height:measured.height||240},viewport:{width:view.innerWidth,height:view.innerHeight}});
   Object.assign(card.style,{left:`${position.left}px`,top:`${position.top}px`});card.setAttribute("data-placement",position.placement);
   if(position.maxHeight!==undefined){card.style.maxHeight=`${position.maxHeight}px`;if(scrolled)card.scrollTop=scrolled;}
   // Phones: the card must not hide the control. Instant (not smooth) so the scroll event it causes re-places once and settles.
   if(position.scrollBy&&typeof view.scrollBy==="function")view.scrollBy({top:position.scrollBy,behavior:"instant"});
  };
  // The scroll listener is capturing, so it also hears the card scrolling itself; that is not a reason to re-place it.
  const onScroll=(event:Event)=>{if(card&&event.target instanceof Node&&card.contains(event.target))return;place();};
  place();view.addEventListener("scroll",onScroll,true);view.addEventListener("resize",place);
  cleanup=()=>{view.removeEventListener("scroll",onScroll,true);view.removeEventListener("resize",place);};
 }
 });
}
