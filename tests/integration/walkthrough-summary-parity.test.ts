/**
 * T240 (Feature 002 x Feature 003): the three walkthrough summaries Feature 003's host shows to the model are the real Feature 002 catalog.
 *
 * Why two lists exist at all: `packages/ai` may not import `@dap/walkthrough`, the host may not import the walkthrough runtime or the reference web app
 * (tests/architecture/guidance-host-boundary.test.ts), and the walkthrough package may not import any AI code. So the host keeps ONE static, frozen list of
 * `{ id, title, description }` (apps/reference-host/src/guidance/walkthrough-summaries.ts) and THIS root test, the only place allowed to see both sides, is the REQUIRED
 * check that the list is exactly `catalog.list()` of the real definitions and the real registry the reference web app mounts. No third list exists.
 *
 * It needs no PostgreSQL and no DOM. It lives in tests/integration so that `npm test` and the M1 gate run it, and `npm run test:walkthrough:proof` runs it
 * (with the T221 end-to-end) on its own, by explicit path, in CI.
 */
import { describe, expect, it } from "vitest";
import { createWalkthroughCatalog } from "../../packages/walkthrough/src/index.js";
import { DEMO_WALKTHROUGH_SUMMARIES } from "../../apps/reference-host/src/guidance/walkthrough-summaries.js";
import { POSTCONDITION_NAMES } from "../../apps/reference-web/src/postconditions.js";
import { createDemoRegistry } from "../../apps/reference-web/src/semantic-ui.js";
import { WALKTHROUGHS } from "../../apps/reference-web/src/walkthroughs/index.js";

interface Summary { readonly id: string; readonly title: string; readonly description: string }

/** Every way `host` differs from `real`, as readable problems; an empty list means the host list is exactly the real catalog's. */
export function driftBetween(host: readonly Summary[], real: readonly Summary[]): string[] {
  const problems: string[] = [];
  const hostById = new Map(host.map((summary) => [summary.id, summary]));
  const realById = new Map(real.map((summary) => [summary.id, summary]));
  if (hostById.size !== host.length) problems.push("host list repeats an id");
  for (const summary of real) {
    const shown = hostById.get(summary.id);
    if (shown === undefined) { problems.push(`real guide ${summary.id} is missing from the host list`); continue; }
    if (shown.title !== summary.title) problems.push(`${summary.id}: title differs`);
    if (shown.description !== summary.description) problems.push(`${summary.id}: description differs`);
    const keys = Object.keys(shown).sort().join(",");
    if (keys !== "description,id,title") problems.push(`${summary.id}: host summary has keys ${keys}`);
  }
  for (const summary of host) if (!realById.has(summary.id)) problems.push(`host guide ${summary.id} does not exist in the real catalog`);
  return problems;
}

const realCatalog = () => createWalkthroughCatalog(createDemoRegistry(), POSTCONDITION_NAMES, WALKTHROUGHS);
const real = (): readonly Summary[] => realCatalog().list();

describe("the host's walkthrough summaries are exactly the real Feature 002 catalog", () => {
  it("the real catalog the reference web app mounts has the three shipped guides", () => {
    expect(real().map((summary) => summary.id).sort()).toEqual(["findSecuritySettings", "findTwoFactorSettings", "profileUpdate"]);
    for (const summary of real()) expect(Object.keys(summary).sort()).toEqual(["description", "id", "title"]); // the catalog itself exposes no steps
  });

  it("every host summary matches a real guide (same id, title and description) and no real guide is omitted", () => {
    expect(driftBetween(DEMO_WALKTHROUGH_SUMMARIES, real())).toEqual([]);
    expect([...DEMO_WALKTHROUGH_SUMMARIES].map((s) => s.id).sort()).toEqual(real().map((s) => s.id).sort());
  });

  it("a host summary is exactly the real one, field for field", () => {
    for (const summary of real()) expect(DEMO_WALKTHROUGH_SUMMARIES.find((s) => s.id === summary.id)).toEqual(summary);
  });
});

describe("the parity check can fail: deliberately drifted copies are caught", () => {
  // Built from the real catalog, so these cases stay valid whatever the host list currently says: each starts from a perfect copy and breaks one thing.
  const host = () => real().map((summary) => ({ ...summary }));
  const ids = () => real().map((summary) => summary.id);
  it("a changed title", () => {
    const drifted = host(); drifted[0] = { ...drifted[0]!, title: `${drifted[0]!.title}!` };
    expect(driftBetween(drifted, real())).toEqual([`${drifted[0]!.id}: title differs`]);
  });
  it("a changed description", () => {
    const drifted = host(); drifted[1] = { ...drifted[1]!, description: "Something else." };
    expect(driftBetween(drifted, real())).toEqual([`${drifted[1]!.id}: description differs`]);
  });
  it("an omitted guide", () => {
    const drifted = host().slice(1);
    expect(driftBetween(drifted, real())).toEqual([`real guide ${ids()[0]!} is missing from the host list`]);
  });
  it("an invented guide (the host offering something that does not exist)", () => {
    const drifted = [...host(), { id: "adminTakeover", title: "Admin", description: "Take over." }];
    expect(driftBetween(drifted, real())).toEqual(["host guide adminTakeover does not exist in the real catalog"]);
  });
  it("a renamed id is both an omission and an invention", () => {
    const drifted = host(); drifted[2] = { ...drifted[2]!, id: "findTwoFactor" };
    expect(driftBetween(drifted, real())).toEqual([`real guide ${ids()[2]!} is missing from the host list`, "host guide findTwoFactor does not exist in the real catalog"]);
  });
  it("an extra key (a step list smuggled into a summary) and a repeated id", () => {
    const withSteps = host().map((summary, index) => (index === 0 ? { ...summary, steps: ["a"] } : summary));
    expect(driftBetween(withSteps, real())).toEqual([`${ids()[0]!}: host summary has keys description,id,steps,title`]);
    expect(driftBetween([...host(), host()[0]!], real())).toContain("host list repeats an id");
  });
  it("a catalog change on the real side with the host list left alone", () => {
    const [first, ...rest] = real();
    const changedReal = [{ ...first!, title: "Update your profile (renamed)" }, ...rest];
    expect(driftBetween(host(), changedReal)).toEqual([`${first!.id}: title differs`]);
  });
});
