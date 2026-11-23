import type { StoredUsage } from "./store.js";

export function completionRate(started: number, completed: number): number | null {
  return started > 0 && Number.isFinite(started) && Number.isFinite(completed)
    ? Math.min(100, Math.max(0, Math.round(completed / started * 100))) : null;
}

export function usageReport(rows: readonly StoredUsage[], builtIn: readonly { id: string; title: string }[]) {
  const titles = new Map(builtIn.map(({ id, title }) => [id, title]));
  const totals = { started: 0, completed: 0, cancelled: 0 };
  const guides = rows.map(({ id, title, started, completed, cancelled }) => {
    totals.started += started;
    totals.completed += completed;
    totals.cancelled += cancelled;
    return { id, title: titles.get(id) ?? title ?? id, started, completed, cancelled, completionRate: completionRate(started, completed) };
  }).sort((a, b) => b.started - a.started || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return { totals: { ...totals, completionRate: completionRate(totals.started, totals.completed) }, guides };
}
