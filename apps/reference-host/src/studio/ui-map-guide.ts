import { createHash } from "node:crypto";
import type { UiTarget } from "@dap/browser-runtime";
import type { DiscoveredUiMap } from "./discover-ui-map.js";

type StepKind = "menu" | "tab" | "link" | "target";
export interface MapGuideStep {
  kind: StepKind;
  page: string;
  target: string;
  after?: string;
  href?: string;
}
export type MapGuideResult = { kind: "route"; steps: MapGuideStep[] } | { kind: "unmapped" | "clarify" };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const uiTargetDigest = ({ page, section, role, name, marker }: UiTarget) => hash(JSON.stringify([page, section, role, name, marker]));
const stopWords = new Set(["хаана", "яаж", "хэрхэн", "вэ", "бэ", "байна", "байдаг", "надад", "how", "where", "what", "the", "do", "can", "please", "is", "to"]);
const actionTerms = [
  /^(?:шинэ|үүсгэ|нэмэх|create|add|new)/u,
  /^(?:засах|өөрчлөх|edit|update)/u,
  /^(?:хадгала|save)/u,
  /^(?:устга|delete|remove)/u,
];
const equivalents = [
  ...actionTerms,
  /^(?:нэхэмжлэх|invoice)/u,
  /^(?:тайлан|report)/u,
  /^(?:тохиргоо|setting)/u,
];
const terms = (text: string) => [...new Set(text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{2,32}/gu) ?? [])]
  .filter(word => !stopWords.has(word)).slice(0, 24);
function match(word: string, query: string[]): number {
  if (query.includes(word)) return 4;
  if (word.length >= 4 && query.some(item => item.length >= 4 && (item.startsWith(word) || word.startsWith(item)))) return 3;
  return equivalents.some(group => group.test(word) && query.some(item => group.test(item))) ? 2 : 0;
}
function relevance(target: UiTarget, query: string[]): number {
  const name = terms(target.name);
  if (actionTerms.some(group => query.some(word => group.test(word)) && !name.some(word => group.test(word)))) return 0;
  const values = name.map(word => match(word, query));
  const matched = values.filter(Boolean).length;
  if (!matched) return 0;
  const section = terms(target.section.join(" "))
    .filter(word => match(word, query) > 0 && match(word, name) === 0).length;
  return values.reduce((total, score) => total + score, 0) * 10 + (matched === name.length ? 6 : 0) + section * 7;
}

export function planMapGuide(map: DiscoveredUiMap, query: string, page: string, controls: readonly string[], maxTransitions = 8): MapGuideResult {
  const question = terms(query);
  if (!question.length) return { kind: "unmapped" };
  const live = new Set(controls);
  const states = new Map(map.states.map(state => {
    const targets = new Map<string, UiTarget[]>();
    for (const target of state.targets) {
      const id = uiTargetDigest(target);
      const same = targets.get(id) ?? [];
      same.push(target);
      targets.set(id, same);
    }
    return [state.id, { page: hash(state.page), targets }] as const;
  }));

  let bestOverlap = 0;
  let starts: string[] = [];
  for (const [id, state] of states) {
    if (state.page !== page) continue;
    const overlap = [...state.targets.keys()].filter(target => live.has(target)).length;
    if (!overlap) continue;
    const score = overlap / (state.targets.size + live.size - overlap);
    if (score > bestOverlap) { bestOverlap = score; starts = [id]; }
    else if (score === bestOverlap) starts.push(id);
  }
  if (!starts.length) return { kind: "unmapped" };

  const edges = new Map<string, Array<{ to: string; step: MapGuideStep }>>();
  for (const edge of map.transitions) {
    if (edge.status !== "observed" || !edge.to) continue;
    const from = states.get(edge.from);
    const to = states.get(edge.to);
    const target = uiTargetDigest(edge.action.target);
    if (!from || !to || from.targets.get(target)?.length !== 1) continue;
    if (edge.action.kind === "link" && (!edge.action.href || to.page === from.page)) continue;
    const step = { kind: edge.action.kind, page: from.page, target, after: to.page,
      ...(edge.action.href ? { href: hash(edge.action.href) } : {}) };
    const outgoing = edges.get(edge.from) ?? [];
    outgoing.push({ to: edge.to, step });
    edges.set(edge.from, outgoing);
  }

  function fromStart(start: string): MapGuideResult {
    const queue: Array<{ state: string; steps: MapGuideStep[] }> = [{ state: start, steps: [] }];
    const visited = new Set([start]);
    let bestScore = 0;
    const best = new Map<string, MapGuideStep[]>();
    for (const { state: id, steps } of queue) {
      const state = states.get(id)!;
      for (const [target, matches] of state.targets) {
        if (id === start && !live.has(target)) continue;
        const score = relevance(matches[0]!, question);
        if (!score || score < bestScore) continue;
        if (score > bestScore) { best.clear(); bestScore = score; }
        // An indistinguishable target stays in the running so a lower-ranked control cannot replace it.
        if (matches.length !== 1) { best.set(target, []); continue; }
        if (!best.has(target)) best.set(target, [...steps, { kind: "target", page: state.page, target }]);
      }
      if (steps.length >= maxTransitions) continue;
      for (const edge of edges.get(id) ?? []) {
        if (visited.has(edge.to) || (id === start && !live.has(edge.step.target))) continue;
        visited.add(edge.to);
        queue.push({ state: edge.to, steps: [...steps, edge.step] });
      }
    }
    if (!best.size) return { kind: "unmapped" };
    const steps = best.values().next().value;
    return best.size === 1 && steps?.length ? { kind: "route", steps } : { kind: "clarify" };
  }

  const answer = fromStart(starts[0]!);
  return starts.slice(1).some(start => JSON.stringify(fromStart(start)) !== JSON.stringify(answer))
    ? { kind: "clarify" } : answer;
}
