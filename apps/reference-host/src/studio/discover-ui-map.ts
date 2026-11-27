import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { UiTarget } from "@dap/browser-runtime";
import type { DiscoveryBrowser, DiscoveryObservation } from "./discovery-browser.js";
import type { DiscoveryAction } from "./discovery-dom.js";
import { secretNameHit } from "./element-privacy.js";

export interface UiMapState {
  id: string;
  page: string;
  targets: UiTarget[];
  truncated: boolean;
}
type TransitionStatus = "observed" | "access-required" | "unreadable" | "no-change" | "limited";
interface Transition {
  from: string;
  action: DiscoveryAction;
  status: TransitionStatus;
  to?: string;
}
export interface DiscoveredUiMap {
  start: string;
  states: UiMapState[];
  transitions: Transition[];
  limited: boolean;
}
type Sample = { state: UiMapState; actions: DiscoveryAction[] } | { access: "access-required" | "unreadable" };
type Observed = Extract<Sample, { state: UiMapState }>;
type Hop = { action: DiscoveryAction; to: string };
type PendingScreen = { from: string; actions: DiscoveryAction[]; path: Hop[]; next: number };
export interface UiMapCheckpoint {
  startPath: string;
  focus: boolean;
  map: DiscoveredUiMap;
  pending: PendingScreen[];
}

const maxStates = 30;
const maxTransitions = 80;
const maxDepth = 16;
const maxGraphBytes = 7_000_000;
const runTimeout = 120_000;

function toSample(observation: DiscoveryObservation, allowText: (text: string) => boolean): Sample {
  if ("access" in observation) return observation;
  const { page, truncated, expanded } = observation;
  const safe = (text: string) => allowText(text) && !secretNameHit(text);
  const safeTarget = (target: UiTarget) => [target.page, target.name, ...target.section, target.marker ?? ""].every(safe);
  const targets = observation.targets.filter(safeTarget);
  const actions = observation.actions.filter(action => safeTarget(action.target) && (!action.href || safe(action.href)));
  const id = createHash("sha256").update(JSON.stringify([page, targets, expanded, actions])).digest("hex").slice(0, 24);
  return { state: { id, page, targets, truncated }, actions };
}

async function stable(observe: () => Promise<Sample>, previous?: string): Promise<Sample> {
  let last: string | undefined;
  let unchanged: Observed | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const observation = await observe().catch(() => undefined);
    if (observation && "access" in observation) return observation;
    if (observation) {
      if (last === observation.state.id && observation.state.id !== previous &&
          (observation.state.targets.length || attempt >= 6)) return observation;
      if (last === observation.state.id) unchanged = observation;
    }
    last = observation?.state.id;
    await sleep(175);
  }
  return unchanged ?? { access: "unreadable" };
}

export async function discoverUiMap(
  browser: DiscoveryBrowser,
  startPath: string,
  cancelled: AbortSignal,
  allowText: (text: string) => boolean,
  options?: { focus: boolean; resume?: UiMapCheckpoint },
): Promise<{ map: DiscoveredUiMap; checkpoint?: UiMapCheckpoint } | { access: "access-required" | "unreadable" }> {
  const deadline = Date.now() + runTimeout;
  const shouldStop = () => cancelled.aborted || Date.now() >= deadline;
  const observe = async () => toSample(await browser.observe(), allowText);
  const initial = await stable(observe);
  if ("access" in initial) return initial;
  const initialId = initial.state.id;
  if (options?.resume && options.resume.map.start !== initialId) return { access: "unreadable" };
  const map: DiscoveredUiMap = options?.resume?.map ??
    { start: initialId, states: [initial.state], transitions: [], limited: initial.state.truncated };
  const known = new Set(map.states.map(state => state.id));
  const queue: PendingScreen[] = options?.resume?.pending ?? [{ from: initialId, actions: initial.actions, path: [], next: 0 }];
  const initialStates = map.states.length;
  const initialTransitions = map.transitions.length;
  let graphBytes = Buffer.byteLength(JSON.stringify(map));
  let current = initialId;

  async function follow(action: DiscoveryAction, from: string): Promise<Sample | undefined> {
    if (!await browser.perform(action).catch(() => false)) return undefined;
    return stable(observe, from);
  }

  async function restore(path: Hop[]): Promise<string> {
    if (!await browser.navigate(startPath).then(() => true, () => false)) return "";
    const root = await stable(observe);
    if (!("state" in root) || root.state.id !== initialId) return "";
    let id = root.state.id;
    for (const hop of path) {
      if (shouldStop()) return "";
      const next = await follow(hop.action, id);
      if (!next || !("state" in next) || next.state.id !== hop.to) return "";
      id = next.state.id;
    }
    return id;
  }

  function record(transition: Transition) {
    map.transitions.push(transition);
    graphBytes += Buffer.byteLength(JSON.stringify(transition)) + 1;
  }

  while (queue.length) {
    const item = queue[0]!;
    const { path, from } = item;
    if (path.length >= maxDepth && item.actions.length) {
      map.limited = true;
      for (const action of item.actions.slice(item.next)) record({ from, action, status: "limited" });
      queue.shift();
      continue;
    }
    while (item.next < item.actions.length) {
      if (graphBytes >= maxGraphBytes) {
        map.limited = true;
        return { map };
      }
      if (shouldStop() || map.transitions.length - initialTransitions >= maxTransitions || map.states.length - initialStates >= maxStates) {
        return { map, checkpoint: { startPath, focus: options?.focus ?? false, map, pending: queue } };
      }
      const action = item.actions[item.next++]!;
      if (current !== from) current = await restore(path);
      const next = current === from ? await follow(action, from) : undefined;
      if (!next || "access" in next) {
        record({ from, action, status: next?.access ?? "unreadable" });
        current = "";
        continue;
      }
      const to = next.state.id;
      current = to;
      if (to === from) {
        record({ from, action, status: "no-change" });
        continue;
      }
      record({ from, action, status: "observed", to });
      if (known.has(to)) continue;
      known.add(to);
      map.states.push(next.state);
      graphBytes += Buffer.byteLength(JSON.stringify(next.state)) + 1;
      map.limited ||= next.state.truncated;
      queue.push({ from: to, actions: next.actions, path: [...path, { action, to }], next: 0 });
    }
    queue.shift();
  }
  return { map };
}
