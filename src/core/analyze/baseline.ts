import { MAX_OVER_TARGET_SHARE } from "../context";
import { fixed, int0 } from "./format";
import { configNotes } from "./config-checks";
import { LONG_LIVED_HOURS } from "./flags";
import { contextTargetOf } from "../providers";
import type { BaselineRow, ConfigInput, ProviderId, RawPerSource, RawReport } from "../model";

/** Level of a value against an "under" target: ok up to the target, warn up to twice it. burn.py:1072 */
export function severity(ratio: number): "ok" | "warn" | "critical" {
  return ratio <= 1 ? "ok" : ratio <= 2 ? "warn" : "critical";
}

const median = (xs: number[]): number | null =>
  xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null;
const pct = (v: number): string => `${fixed(v)}%`;
const count = (v: number): string => fixed(v);
const hours = (v: number): string => `${fixed(v)}h`;
const kilo = (v: number): string => `${int0(v / 1000)}k`;
const share = (a: number, b: number): number | null => (b ? (100 * a) / b : null);

/** The lever rows for one source, from its per-source aggregates. burn.py:1077 */
function providerLevers(src: ProviderId, p: RawPerSource): BaselineRow[] {
  const { recent, stats7: stats, totals: tot } = p;
  const wakes = recent.wakes;
  const ping = (w: typeof wakes) => w.teammate + w.task + w.peer;
  const have = recent.turns > 0;

  // (name, format, 24 h value, whole-window value, target text, limit, advisory)
  const levers: [string, (v: number) => string, number | null, number, string, number, boolean][] = [
    [`Spend on turns over ${kilo(contextTargetOf(src))}`, pct, share(recent.over, recent.total), p.over_target, `under ${MAX_OVER_TARGET_SHARE * 100}%`, MAX_OVER_TARGET_SHARE * 100, false],
    ["Median context per turn", kilo, median(recent.contexts), median(p.contexts) ?? 0, `at most ${kilo(contextTargetOf(src))}`, contextTargetOf(src), false],
    ["Turns per human prompt", count, have ? recent.turns / Math.max(wakes.human, 1) : null, p.turns / Math.max(tot.human, 1), "under 50", 50, false],
    ["Caller reads per tool call", pct, have ? share(recent.reads, recent.tool_calls) : null, share(tot.reads, tot.tool_calls) ?? 0, "under 20%", 20, false],
    ["Wakeups per session", count, recent.sessions ? ping(wakes) / recent.sessions : null, ping(tot) / Math.max(p.session_count, 1), "under 20", 20, false],
    ["Longest top session", hours, p.hours24 || null, p.hours_all, `under ${LONG_LIVED_HOURS}h`, LONG_LIVED_HOURS, false],
    ["Spend on the top model", pct, share(recent.top, recent.total), share(stats.top, p.total) ?? 0, "under 60%", 60, true],
  ];
  if (stats.cache_input) {
    levers.push(["Cache rebuilds", pct, share(recent.cache_write, recent.cache_input), share(stats.cache_write, stats.cache_input) ?? 0, "under 10%", 10, false]);
  }
  if (p.preamble) {
    levers.push(["Preamble per session (p50)", kilo, median(recent.preambles), p.preamble[0], "under 40k", 40_000, false]);
  }

  const rows: BaselineRow[] = [];
  for (const [name, fmt, now, week, target, limit, advisory] of levers) {
    const ratio = now === null ? null : now / limit;
    let level: BaselineRow["level"] = ratio === null ? "ok" : severity(ratio);
    if (advisory && level !== "ok") level = "info";
    rows.push({
      name,
      now_24h: now === null ? "-" : fmt(now),
      value_7d: fmt(week),
      target,
      ok: level === "ok",
      level,
      ratio,
      advisory,
      source: src,
    });
  }
  return rows;
}

/**
 * Every lever per live provider over the last CHECK_HOURS and the whole window, against a
 * recommended target, plus the per-agent config rows. The level judges the 24 h value; a
 * lever with no 24 h data is ok. burn.py:1125
 */
export function baseline(report: RawReport, config: ConfigInput): BaselineRow[] {
  const live = report.sources.map(([name]) => name);
  const rows: BaselineRow[] = [];
  for (const src of live) {
    const p = report.per_source[src];
    if (p) rows.push(...providerLevers(src, p));
  }
  for (const note of configNotes(live, config)) {
    rows.push({
      name: note.name,
      now_24h: note.value,
      value_7d: null,
      target: note.target,
      ok: note.ok,
      level: note.level,
      ratio: note.ratio,
      advisory: false,
      source: note.source,
    });
  }
  return rows;
}
