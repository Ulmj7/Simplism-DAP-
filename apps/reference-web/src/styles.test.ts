/// <reference types="node" />
import { expect, it } from "vitest";
import { resolve, join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
const root = resolve("apps/reference-web/src");
it("the approved brand has one token source and no scattered hex colours", () => {
 const tokens=readFileSync(join(root,"styles/tokens.css"),"utf8");
 for(const [name,value] of [["bg","F1F2F4"],["accent","812F74"],["ink","000000"]]) expect(tokens).toContain(`--dap-${name}: ${String.fromCharCode(35)}${value}`);
 for(const file of readdirSync(root,{recursive:true}) as string[]) {
  if(!/\.(ts|css)$/.test(file) || file==="styles/tokens.css") continue;
  expect(readFileSync(join(root,file),"utf8"),file).not.toMatch(/#[0-9a-f]{3,8}\b/i);
 }
 const html=readFileSync(join(root,"../index.html"),"utf8");expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);expect(html).not.toContain("<style>");expect(html).toContain("styles/tokens.css");
});
it("layout and accessibility CSS supplies constrained, responsive, accent-focus controls without motion",()=>{
 const css=readFileSync(join(root,"styles/app.css"),"utf8");
 expect(css).toContain("max-width: var(--page-width)");expect(css).toContain("max-width: var(--form-width)");expect(css).toContain("max-width: 767px");expect(css).toContain(":focus-visible");expect(css).toContain("min-height: var(--touch)");expect(css).not.toMatch(/transition:|animation:|gradient\(/);
});
it("guide presentation has compact/reduced-motion rules and uses only theme colours",()=>{
 const css=readFileSync(join(root,"styles/overlay.css"),"utf8");expect(css).toContain("prefers-reduced-motion: reduce");expect(css).toContain("max-width: 767px");expect(css).toContain("position: fixed");expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);expect(css).toContain("100dvh");
});
