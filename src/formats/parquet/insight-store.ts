// Module-level cache for insight analyses, keyed by source alias. Lives
// outside React so analysis state (results, in-flight progress, errors)
// survives the InsightView unmounting when the user switches tabs. Same
// pattern as optimize-store.ts.

import type { Column, FormatAdapter } from "../../types";
import { type ColumnStat, type InsightProgress, analyzeInsight } from "./insight";

export type InsightEntry = {
  status: "idle" | "running" | "done" | "error";
  stats: ColumnStat[] | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  progress: InsightProgress | null;
};

const IDLE: InsightEntry = {
  status: "idle",
  stats: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  progress: null,
};

const cache = new Map<string, InsightEntry>();
const subscribers = new Map<string, Set<() => void>>();

function notify(alias: string) {
  const subs = subscribers.get(alias);
  if (!subs) return;
  for (const cb of subs) cb();
}

function set(alias: string, patch: Partial<InsightEntry>) {
  const prev = cache.get(alias) ?? IDLE;
  cache.set(alias, { ...prev, ...patch });
  notify(alias);
}

export function getInsightEntry(alias: string): InsightEntry {
  return cache.get(alias) ?? IDLE;
}

export function subscribeInsight(alias: string, cb: () => void): () => void {
  let subs = subscribers.get(alias);
  if (!subs) {
    subs = new Set();
    subscribers.set(alias, subs);
  }
  subs.add(cb);
  return () => {
    const s = subscribers.get(alias);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subscribers.delete(alias);
  };
}

export async function startInsight(
  adapter: FormatAdapter,
  alias: string,
  columns: Column[],
): Promise<void> {
  const cur = cache.get(alias);
  if (cur?.status === "running") return;
  set(alias, {
    status: "running",
    stats: null,
    error: null,
    startedAt: performance.now(),
    finishedAt: null,
    progress: { done: 0, total: columns.length, phase: "columns" },
  });
  try {
    const stats = await analyzeInsight(adapter, alias, columns, (p) => {
      set(alias, { progress: p });
    });
    set(alias, {
      status: "done",
      stats,
      finishedAt: performance.now(),
    });
  } catch (e) {
    set(alias, {
      status: "error",
      error: (e as Error).message,
      finishedAt: performance.now(),
    });
  }
}

export function resetInsight(alias: string) {
  cache.delete(alias);
  notify(alias);
}
