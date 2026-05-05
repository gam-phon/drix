// Module-level cache for optimization runs, keyed by source alias. Lives
// outside React so analysis state (results, in-flight progress, errors)
// survives the OptimizationView unmounting when the user switches tabs.

import type { Column, FormatAdapter } from "../../types";
import { type AnalyzeProgress, type Suggestion, analyzeParquet } from "./optimize";
import type { ParquetFileInfo } from "./types";

export type OptimizeEntry = {
  status: "idle" | "running" | "done" | "error";
  suggestions: Suggestion[] | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  progress: AnalyzeProgress | null;
};

const IDLE: OptimizeEntry = {
  status: "idle",
  suggestions: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  progress: null,
};

const cache = new Map<string, OptimizeEntry>();
const subscribers = new Map<string, Set<() => void>>();

function notify(alias: string) {
  const subs = subscribers.get(alias);
  if (!subs) return;
  for (const cb of subs) cb();
}

function set(alias: string, patch: Partial<OptimizeEntry>) {
  const prev = cache.get(alias) ?? IDLE;
  cache.set(alias, { ...prev, ...patch });
  notify(alias);
}

export function getOptimizeEntry(alias: string): OptimizeEntry {
  return cache.get(alias) ?? IDLE;
}

export function subscribeOptimize(alias: string, cb: () => void): () => void {
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

export async function startOptimize(
  adapter: FormatAdapter,
  alias: string,
  columns: Column[],
  info: ParquetFileInfo,
): Promise<void> {
  const cur = cache.get(alias);
  if (cur?.status === "running") return; // already in-flight for this alias
  set(alias, {
    status: "running",
    suggestions: null,
    error: null,
    startedAt: performance.now(),
    finishedAt: null,
    progress: { done: 0, total: columns.length, phase: "columns" },
  });
  try {
    const suggestions = await analyzeParquet(adapter, alias, columns, info, (p) => {
      set(alias, { progress: p });
    });
    set(alias, {
      status: "done",
      suggestions,
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

export function resetOptimize(alias: string) {
  cache.delete(alias);
  notify(alias);
}
