import { describe, expect, it } from "vitest";
import { MIN_SELECTION_SCORE, SELECTION_MARGIN, judgeProposal, parseGuidanceModelRequest, rankSummaries } from "@dap/ai";
import { DEMO_WALKTHROUGH_SUMMARIES, createCatalogView, demoCatalogView } from "./walkthrough-summaries.js";

const S = DEMO_WALKTHROUGH_SUMMARIES;
const ids = (query: string) => rankSummaries(S, query).map((r) => `${r.id}:${r.score}`);

describe("the three temporary walkthrough summaries: the one trusted source", () => {
  it("are exactly profileUpdate, findSecuritySettings and findTwoFactorSettings, each {id, title, description} and nothing else", () => {
    expect(S.map((s) => s.id)).toEqual(["profileUpdate", "findSecuritySettings", "findTwoFactorSettings"]);
    for (const summary of S) expect(Object.keys(summary).sort()).toEqual(["description", "id", "title"]);
  });
  it("are frozen, and the catalog view lists them without a way to change them", () => {
    expect(Object.isFrozen(S)).toBe(true);
    for (const summary of S) expect(Object.isFrozen(summary)).toBe(true);
    expect(demoCatalogView.list()).toEqual(S);
    expect(() => (demoCatalogView.list() as unknown[]).push({ id: "adminTakeover" })).toThrow();
    expect(demoCatalogView.list().map((s) => s.id)).not.toContain("adminTakeover");
  });
  it("satisfy the guidance request schema (plain text, bounded, valid ids)", () => {
    const parsed = parseGuidanceModelRequest({ input: { query: "q", semanticContext: { route: "", elements: [] }, walkthroughSummaries: S, sources: [] }, maxOutputChars: 1200 });
    expect(parsed.ok).toBe(true);
  });
  it("contain no executable definition: only id, title and description (checked above), and plain-text values with no markup characters", () => {
    for (const summary of S) for (const value of Object.values(summary)) expect(value).not.toMatch(/[<>&"'`]/);
  });
  it("createCatalogView lists a frozen copy of the list it was given", () => {
    const source = [{ id: "alpha", title: "A", description: "B" }];
    const view = createCatalogView(source);
    source.push({ id: "beta", title: "C", description: "D" });
    expect(view.list().map((s) => s.id)).toEqual(["alpha"]);
    expect(Object.isFrozen(view.list())).toBe(true);
  });
});

describe("tuning MIN_SELECTION_SCORE on the three demo summaries (T313): the printed table, pinned", () => {
  // Raw guard scores, in the order the guard ranks them. If a summary's wording changes, this table and the threshold must be re-tuned together.
  const TABLE: readonly (readonly [string, readonly string[]])[] = [
    ["How do I change my profile name?", ["profileUpdate:4.234401", "findSecuritySettings:0", "findTwoFactorSettings:0"]],
    ["change my display name", ["profileUpdate:3.687259", "findSecuritySettings:0", "findTwoFactorSettings:0"]],
    ["I want to change my name", ["profileUpdate:2.640553", "findSecuritySettings:0", "findTwoFactorSettings:0"]],
    ["update profile", ["profileUpdate:3.003482", "findSecuritySettings:0", "findTwoFactorSettings:0"]],
    ["How do I find two-factor authentication settings?", ["findTwoFactorSettings:5.62557", "findSecuritySettings:1.439239", "profileUpdate:0"]],
    ["Where can I enable two-factor?", ["findTwoFactorSettings:2.89193", "findSecuritySettings:0", "profileUpdate:0"]],
    ["Where is the security panel?", ["findSecuritySettings:2.640553", "findTwoFactorSettings:0", "profileUpdate:0"]],
    ["Where is the security settings page?", ["findSecuritySettings:2.859174", "findTwoFactorSettings:1.110349", "profileUpdate:0"]],
    ["Help me with settings.", ["findSecuritySettings:0.763756", "findTwoFactorSettings:0.692892", "profileUpdate:0"]],
    ["settings", ["findSecuritySettings:0.763756", "findTwoFactorSettings:0.692892", "profileUpdate:0"]],
    ["find settings", ["findSecuritySettings:1.439239", "findTwoFactorSettings:1.287675", "profileUpdate:0"]],
    ["find the page", ["findSecuritySettings:1.177054", "findTwoFactorSettings:1.01224", "profileUpdate:0"]],
    ["Start the admin walkthrough.", ["findSecuritySettings:0", "findTwoFactorSettings:0", "profileUpdate:0"]],
    ["Start a walkthrough", ["findSecuritySettings:0", "findTwoFactorSettings:0", "profileUpdate:0"]],
    ["Help", ["findSecuritySettings:0", "findTwoFactorSettings:0", "profileUpdate:0"]],
    ["guide me", ["findSecuritySettings:0", "findTwoFactorSettings:0", "profileUpdate:0"]],
    ["How do I delete my account?", ["findSecuritySettings:0", "findTwoFactorSettings:0", "profileUpdate:0"]],
    ["What is the weather today?", ["findSecuritySettings:0", "findTwoFactorSettings:0", "profileUpdate:0"]],
  ];
  it.each(TABLE)("%s", (query, expected) => { expect(ids(query)).toEqual(expected); });

  it("the threshold sits with a margin between 'no connection' (exactly 0) and the weakest real overlap (a topic word shared by two guides)", () => {
    const scores = TABLE.flatMap(([, rows]) => rows.map((row) => Number(row.split(":")[1])));
    const unrelated = scores.filter((score) => score < MIN_SELECTION_SCORE);
    const related = scores.filter((score) => score >= MIN_SELECTION_SCORE);
    expect(Math.max(...unrelated)).toBe(0); // no overlap at all scores exactly 0: nothing sits just under the threshold
    expect(Math.min(...related)).toBeGreaterThanOrEqual(MIN_SELECTION_SCORE * 1.3); // the weakest real overlap clears it with a 30% margin
    expect(MIN_SELECTION_SCORE).toBe(0.5);
  });
  it("generic words (start, walkthrough, guide, help) never carry a selection: they score exactly 0", () => {
    for (const query of ["start", "walkthrough", "guide", "help", "start the guide", "help me start a walkthrough", "Start a walkthrough guide help"]) {
      expect(rankSummaries(S, query).every((r) => r.score === 0), query).toBe(true);
    }
  });
});

describe("the three required decisions over the real host list", () => {
  const verdict = (query: string, id: string) => judgeProposal(S, query, id);
  it("'How do I change my profile name?' accepts profileUpdate", () => {
    expect(verdict("How do I change my profile name?", "profileUpdate")).toEqual({ verdict: "accepted" });
  });
  it("'Help me with settings.' is ambiguous between the two settings guides, whichever the model proposed", () => {
    for (const id of ["findSecuritySettings", "findTwoFactorSettings"]) {
      expect(verdict("Help me with settings.", id)).toEqual({ verdict: "ambiguous", candidates: ["findSecuritySettings", "findTwoFactorSettings"] });
    }
    const [first, second] = rankSummaries(S, "Help me with settings.");
    expect(first!.score).toBeLessThan(SELECTION_MARGIN * second!.score); // closer than the 20% margin
    expect(verdict("Help me with settings.", "profileUpdate")).toEqual({ verdict: "unrelated" });
  });
  it("'Start the admin walkthrough.' has no matching id; an existing id proposed for it is unrelated", () => {
    expect(verdict("Start the admin walkthrough.", "adminWalkthrough")).toEqual({ verdict: "unknown" });
    for (const summary of S) expect(verdict("Start the admin walkthrough.", summary.id)).toEqual({ verdict: "unrelated" });
  });
  it("'How do I find two-factor authentication settings?' accepts findTwoFactorSettings and 'Where is the security panel?' accepts findSecuritySettings", () => {
    expect(verdict("How do I find two-factor authentication settings?", "findTwoFactorSettings")).toEqual({ verdict: "accepted" });
    expect(verdict("Where is the security panel?", "findSecuritySettings")).toEqual({ verdict: "accepted" });
  });
  it("is deterministic for any summary order", () => {
    const reversed = [...S].reverse();
    for (const [query] of [["Help me with settings."], ["How do I change my profile name?"]] as const) expect(rankSummaries(reversed, query)).toEqual(rankSummaries(S, query));
  });
});
