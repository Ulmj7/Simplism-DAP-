/** QA U1+U2 finding 2: the header "Guides" link must take the user to the Guides card (scrolled into view, heading focused), from the Dashboard and from other pages. */
import {afterEach,expect,it,vi} from "vitest";
import {mountApp} from "./main.js";
import type {MountedApp} from "./main.js";
import {copy} from "./copy.js";
const apps:MountedApp[]=[];afterEach(()=>{apps.splice(0).forEach(a=>a.destroy());document.body.replaceChildren();vi.useRealTimers();vi.restoreAllMocks();});
function mount(route:string){vi.useFakeTimers();window.history.replaceState(null,"",`#/${route}`);const root=document.createElement("div");document.body.append(root);const app=mountApp(root,{trustedEventsOnly:false});apps.push(app);return root;}
const link=(root:ParentNode)=>Array.from(root.querySelectorAll<HTMLAnchorElement>("header a")).find(a=>a.textContent===copy.guide.link)!;
const scrolled=()=>{const spy=vi.fn();Element.prototype.scrollIntoView=spy as unknown as Element["scrollIntoView"];return spy;};
it("on the Dashboard the Guides link scrolls the Guides card into view and focuses its heading",()=>{
 const root=mount("dashboard");const spy=scrolled();link(root).click();
 expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.contexts[0]).toBe(root.querySelector("#guides"));
 expect(document.activeElement).toBe(root.querySelector("#guides h2"));expect(window.location.hash).toBe("#/dashboard");
});
it("from another page it opens the Dashboard and then reveals the Guides card",async()=>{
 const root=mount("settings");const spy=scrolled();link(root).click();await vi.advanceTimersByTimeAsync(5);
 expect(window.location.hash).toBe("#/dashboard");expect(root.querySelector("#guides")).not.toBeNull();
 expect(spy).toHaveBeenCalledTimes(1);expect(document.activeElement).toBe(root.querySelector("#guides h2"));
});
it("does not hijack a modified click (open in new tab) and a later plain Dashboard visit does not scroll",async()=>{
 const root=mount("settings");const spy=scrolled();const event=new MouseEvent("click",{bubbles:true,cancelable:true,ctrlKey:true});link(root).dispatchEvent(event);
 expect(event.defaultPrevented).toBe(false);expect(spy).not.toHaveBeenCalled();
 window.location.hash="#/dashboard";await vi.advanceTimersByTimeAsync(5);expect(spy).not.toHaveBeenCalled();
});
