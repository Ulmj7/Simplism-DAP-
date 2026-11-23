import {afterEach,expect,it,vi} from "vitest";
import {placeCard} from "./placement.js";
import {createAvailabilityFeed} from "./availability.js";
import {createTargets} from "./targets.js";
import {createOverlay} from "./overlay.js";
import {createSemanticRegistry} from "../semantic/registry.js";
const registry=createSemanticRegistry({routes:["profile"],elements:[{id:"profile.name",route:"profile",role:"textbox",label:"Name",description:"Display name",privacy:"public",operations:["highlight","input"]}]});
function input(){const el=document.createElement("input");el.setAttribute("data-ai-id","profile.name");return el;}
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const stop of cleanup.splice(0))stop();document.body.replaceChildren();});
it.each([
 [{left:100,top:100,width:100,height:30},{width:200,height:100},"below"],
 [{left:100,top:700,width:100,height:30},{width:200,height:100},"above"],
 [{left:100,top:200,width:100,height:400},{width:200,height:400},"beside"],
 [{left:1000,top:200,width:100,height:400},{width:200,height:400},"beside"],
] as const)("pure placement chooses room on a side",(target,card,placement)=>{const result=placeCard({target,card,viewport:{width:1200,height:800}});expect(result.placement).toBe(placement);expect(result.left).toBeGreaterThanOrEqual(8);expect(result.top).toBeGreaterThanOrEqual(8);if(placement==="below")expect(result.top).toBeGreaterThanOrEqual(target.top+target.height);if(placement==="above")expect(result.top+card.height).toBeLessThanOrEqual(target.top);if(placement==="beside")expect(result.left+card.width<=target.left||result.left>=target.left+target.width).toBe(true);});
it("clamps and docks compact cards away from the target",()=>{
 for(const top of [20,700]){const p=placeCard({target:{left:0,top,width:300,height:44},card:{width:336,height:240},viewport:{width:390,height:844}});expect(p.left).toBe(8);expect(p.placement).toBe(top===20?"bottom":"top");expect(p.top+240).toBeLessThanOrEqual(836);}
 const p=placeCard({target:{left:2000,top:2000,width:1,height:1},card:{width:300,height:100},viewport:{width:900,height:600}});expect(p.left).toBeLessThanOrEqual(592);expect(p.top).toBeLessThanOrEqual(492);
});
it("availability emits only registered changes, refreshes after render, and unsubscribes",async()=>{
 const root=document.createElement("div");document.body.append(root);const events:unknown[]=[];const targets=createTargets(root,registry);const feed=createAvailabilityFeed({registry,targets,dispatch:e=>events.push(e)});cleanup.push(feed.destroy);
 expect(events).toEqual([]);const unknown=document.createElement("button");unknown.setAttribute("data-ai-id","unregistered.id");root.append(input(),unknown);feed.refresh();feed.refresh();expect(events).toEqual([{type:"targetAvailable",id:"profile.name"}]);
 root.querySelector("input")!.remove();await Promise.resolve();expect(events).toEqual([{type:"targetAvailable",id:"profile.name"},{type:"targetGone",id:"profile.name"}]);feed.destroy();root.replaceChildren(input());await Promise.resolve();expect(events).toHaveLength(2);
});
it("content overlays remain nonmodal, value-free, verifying-aware and detach cleanly",()=>{
 const root=document.createElement("div");root.replaceChildren(input());document.body.append(root);const target=createTargets(root,registry).find("profile.name")!;target.element.getBoundingClientRect=()=>({left:10,top:10,width:100,height:44,right:110,bottom:54} as DOMRect);
 const overlay=createOverlay(document);cleanup.push(overlay.hide);const cancel=vi.fn();overlay.show(target,{title:"Name",text:"<img src=x>",progress:"Step 1 of 2",hint:"Type here.",ack:false},{onCancel:cancel});
 const card=document.querySelector('[data-ai-overlay="tooltip"]')!;expect(card.getAttribute("role")).toBe("region");expect(card.hasAttribute("aria-modal")).toBe(false);expect(card.querySelector("img")).toBeNull();expect(card.textContent).toContain("Step 1 of 2");expect(card.querySelector<HTMLButtonElement>('[data-ai-overlay="ack"]')!.hidden).toBe(true);
 for(const el of Array.from(document.querySelectorAll("[data-ai-overlay]")))expect(el.hasAttribute("data-ai-ignore")).toBe(true);
 overlay.update({ack:true,ackDisabled:true,status:"Checking…"});expect(card.querySelector<HTMLButtonElement>('[data-ai-overlay="ack"]')!.disabled).toBe(true);expect(card.textContent).toContain("Checking…");
 window.dispatchEvent(new Event("scroll"));window.dispatchEvent(new Event("resize"));target.element.remove();overlay.reposition();expect(document.querySelectorAll("[data-ai-overlay]")).toHaveLength(0);
});
// QA U1+U2 finding 1: on a phone-sized viewport the real card (about 290 px tall) must never cover the highlighted control.
// `scrollBy` is the vertical scroll (px) the overlay applies to bring the target into the free band; the target then sits at top - scrollBy.
const PHONES=[[320,568],[360,640],[375,667],[390,844],[414,896],[667,375],[640,360],[568,320]] as const;
it.each(PHONES)("mobile card never covers the target at %ix%i (real card height, any target position)",(width,height)=>{
 const card={width:336,height:290};const target={width:Math.min(300,width-40),height:44};
 for(let top=0;top<=height-target.height;top+=7){
  const p=placeCard({target:{left:20,top,...target},card,viewport:{width,height}});
  const cardH=Math.min(card.height,p.maxHeight??card.height);const shifted=top-(p.scrollBy??0);
  expect(cardH,`card height at top=${top}`).toBeGreaterThan(0);
  expect(shifted,`target stays on screen at top=${top}`).toBeGreaterThanOrEqual(0);expect(shifted+target.height,`target stays on screen at top=${top}`).toBeLessThanOrEqual(height);
  const ring=[shifted-4,shifted+target.height+4];const overlaps=ring[0]!<p.top+cardH&&p.top<ring[1]!;expect(overlaps,`card [${p.top},${p.top+cardH}] vs highlight ring [${ring[0]},${ring[1]}] at top=${top}`).toBe(false);
 }
});
it("mobile placement scrolls only when the card would cover the target, and shrinks the card when the screen is too short",()=>{
 const clear=placeCard({target:{left:20,top:400,width:300,height:44},card:{width:336,height:290},viewport:{width:390,height:844}});expect(clear.scrollBy??0).toBe(0);
 const covered=placeCard({target:{left:41,top:262,width:238,height:44},card:{width:336,height:290},viewport:{width:320,height:568}});expect(covered.scrollBy).not.toBe(0);
 const short=placeCard({target:{left:20,top:150,width:300,height:44},card:{width:336,height:290},viewport:{width:640,height:360}});expect(short.maxHeight).toBeLessThan(290);
});
it("the overlay applies the scroll and caps the card height it was told to",()=>{
 const view=window as unknown as {innerWidth:number;innerHeight:number;scrollBy:unknown};const saved={w:view.innerWidth,h:view.innerHeight,s:view.scrollBy};
 Object.defineProperty(window,"innerWidth",{configurable:true,value:320});Object.defineProperty(window,"innerHeight",{configurable:true,value:568});const scrollBy=vi.fn();view.scrollBy=scrollBy;
 const proto=HTMLElement.prototype.getBoundingClientRect;HTMLElement.prototype.getBoundingClientRect=function(this:HTMLElement){return (this.getAttribute("data-ai-overlay")==="tooltip"?{left:8,top:0,width:304,height:290,right:312,bottom:290}:{left:41,top:262,width:238,height:44,right:279,bottom:306}) as DOMRect;};
 try{
  const root=document.createElement("div");root.replaceChildren(input());document.body.append(root);const target=createTargets(root,registry).find("profile.name")!;
  const overlay=createOverlay(document);cleanup.push(overlay.hide);overlay.show(target,{title:"Name",text:"Type here."});
  expect(scrollBy).toHaveBeenCalled();const arg=scrollBy.mock.calls[0]![0] as {top:number};expect(arg.top).not.toBe(0);
 }finally{HTMLElement.prototype.getBoundingClientRect=proto;Object.defineProperty(window,"innerWidth",{configurable:true,value:saved.w});Object.defineProperty(window,"innerHeight",{configurable:true,value:saved.h});view.scrollBy=saved.s;}
});
// jsdom has no layout, so model the one browser rule this depends on: a capped card scrolls, and an uncapped one cannot (scrollTop clamps to 0).
function shortPhone(run:(card:HTMLElement,scrollTopOf:()=>number,measures:()=>number)=>void){
 let top=0,measured=0; // the card's scroll offset; a browser clamps it to 0 the moment layout runs with the card uncapped
 const view=window as unknown as {innerWidth:number;innerHeight:number};const saved={w:view.innerWidth,h:view.innerHeight};
 Object.defineProperty(window,"innerWidth",{configurable:true,value:568});Object.defineProperty(window,"innerHeight",{configurable:true,value:320});
 const proto=HTMLElement.prototype.getBoundingClientRect;
 HTMLElement.prototype.getBoundingClientRect=function(this:HTMLElement){if(this.getAttribute("data-ai-overlay")==="tooltip"){measured++;if(this.style.maxHeight==="")top=0;}return (this.getAttribute("data-ai-overlay")==="tooltip"?{left:8,top:0,width:552,height:parseInt(this.style.maxHeight||"290",10),right:560,bottom:290}:{left:41,top:8,width:238,height:44,right:279,bottom:52}) as DOMRect;};
 try{
  const root=document.createElement("div");root.replaceChildren(input());document.body.append(root);const target=createTargets(root,registry).find("profile.name")!;
  const overlay=createOverlay(document);cleanup.push(overlay.hide);overlay.show(target,{title:"Name",text:"Type here.",ack:true});
  const card=document.querySelector<HTMLElement>("[data-ai-overlay=tooltip]")!;
  Object.defineProperty(card,"scrollTop",{configurable:true,get:()=>top,set:(n:number)=>{top=card.style.maxHeight===""?0:Math.max(0,Math.min(n,50));}});
  run(card,()=>top,()=>measured);
 }finally{HTMLElement.prototype.getBoundingClientRect=proto;Object.defineProperty(window,"innerWidth",{configurable:true,value:saved.w});Object.defineProperty(window,"innerHeight",{configurable:true,value:saved.h});}
}
it("a capped card stays scrollable: scrolling inside it does not re-place it and reset its position",()=>{
 shortPhone((card,scrollTopOf,measures)=>{
  expect(card.style.maxHeight).toBe("240px");card.scrollTop=50;expect(scrollTopOf()).toBe(50);
  const before=measures();card.dispatchEvent(new Event("scroll"));
  expect(measures()).toBe(before); // the card's own scroll is not a reason to re-place it (and would loop: restoring the offset scrolls the card again)
  expect(scrollTopOf()).toBe(50);expect(card.style.maxHeight).toBe("240px");
 });
});
it("re-placing a capped card (page scroll, resize, status update) keeps how far the card was scrolled",()=>{
 shortPhone((card,scrollTopOf)=>{
  card.scrollTop=50;
  window.dispatchEvent(new Event("resize"));expect(scrollTopOf()).toBe(50);
  window.dispatchEvent(new Event("scroll"));expect(scrollTopOf()).toBe(50);
  expect(card.style.maxHeight).toBe("240px");
 });
});
