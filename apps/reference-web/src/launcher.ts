import type { WalkthroughRuntime } from "@dap/walkthrough";
import { h } from "./dom.js";
import { copy } from "./copy.js";
import { button,card,statusMessage } from "./ui/pieces.js";
export type GuideApi=Pick<WalkthroughRuntime,"startWalkthrough"|"catalog"|"context"|"cancel"|"getState"|"subscribe">;
export function guideApi(runtime:WalkthroughRuntime):GuideApi{return Object.freeze({startWalkthrough:runtime.startWalkthrough,catalog:runtime.catalog,context:runtime.context,cancel:runtime.cancel,getState:runtime.getState,subscribe:runtime.subscribe});}
export function createLauncher(runtime:GuideApi,start:(id:string,source:HTMLElement)=>void,hidden:readonly string[]=[]) {
 const status=statusMessage();const buttons:{launch:HTMLButtonElement;title:string}[]=[];
 const element=h("section",{id:"guides",class:"guides-card card","data-ai-ignore":true},h("h2",{tabindex:"-1"},copy.dashboard.guides),h("p",{},copy.dashboard.guidesText));
 const list=h("div",{class:"guide-list"});for(const summary of runtime.catalog.list()) {
  if(hidden.includes(summary.id))continue;
  const launch=button(copy.guide.start,true);launch.setAttribute("aria-label",`${copy.guide.start}: ${summary.title}`);launch.addEventListener("click",()=>start(summary.id,launch));buttons.push({launch,title:summary.title});list.append(card(h("h3",{},summary.title),h("p",{},summary.description),launch));
 }
 element.append(list,status);
 return {element,/** Bring the catalog into view and move focus to its heading (the header Guides link). */reveal(){element.scrollIntoView({block:"start"});element.querySelector<HTMLElement>("h2")?.focus({preventScroll:true});},update(){const active=["RESOLVING","PRESENTING","WAITING","VERIFYING"].includes(runtime.getState().status);for(const {launch,title} of buttons){const label=active?copy.guide.active:copy.guide.start;launch.disabled=active;launch.textContent=label;launch.setAttribute("aria-label",`${label}: ${title}`);}},refused(){status.textContent=copy.guide.refused;}};
}
