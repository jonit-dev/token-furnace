import {
  ACTIVE_MINUTES,
  BENCH_WINDOW,
  CHECK_HOURS,
  GAIN_HOURS,
  sessionFlags,
} from "./flags";
import {
  CACHE_READ_RATE,
  CACHE_WRITE_RATE,
  MODEL_RATE,
  OUTPUT_RATE,
  SIZE_BUCKETS,
  bucketLabel,
  bucketRowLabel,
  modelRate,
} from "./pricing";
import { configChecks } from "./config-checks";
import { baseline } from "./baseline";
import { weekPoints } from "./burn";
import type {
  ActiveSession,
  HourSlot,
  RawRecent,
  RawReport,
  RawStats,
  RawWeek,
  ReportInput,
  SessionRow,
  Source,
  Totals,
  WakeCounts,
  Week,
} from "../model";

/** burn.py:527. Pure: every file, clock reading and env value arrives in the input. */
export function buildReport(input: ReportInput): RawReport | null {
  const { now, days, config } = input;
  if (!input.live.length) return null;
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const recentCut = new Date(now.getTime() - CHECK_HOURS * 3_600_000);
  const hour1Cut = new Date(now.getTime() - 3_600_000);
  const gainCuts = GAIN_HOURS.map((h) => [h, new Date(now.getTime() - h * 3_600_000)] as const);

  const bySize = new Map<string, number>();
  const turnsBySize = new Map<string, number>();
  const byProject = new Map<string, number>();
  const bySource = new Map<string, number>();
  const tools = new Map<string, number>();
  const unpriced = new Map<string, number>();
  /** key -> cost, turns, peak, hours */
  const sessions = new Map<string, [number, number, number, number]>();
  /** key -> reads, wakes */
  const signals = new Map<string, [number, WakeCounts]>();
  const paths = new Map<string, string>();
  const titles = new Map<string, string | null>();
  const timeline = new Map<number, [number, number]>();
  const hourly = new Map<number, HourSlot>();
  const contexts: number[] = [];
  const preambles: number[] = [];
  const totals = emptyTotals();
  const lastHour = new Map<Source, number>();
  const recent = new Map<Source, Map<number, number>>();
  const weekHourly = new Map<Source, Map<number, [number, number]>>();
  const active: [string, number, number, string | null, number][] = [];
  const sessions24 = new Map<string, [number, number, number, number]>();
  const signals24 = new Map<string, [number, WakeCounts]>();
  const per = new Map<Source, PerSource>();
  const weeks: Record<Source, Week | null> = { claude: input.planWeek, codex: input.codexWeek };
  const weekNow = new Map<Source, number>();

  let total = 0;
  let unpricedCost = 0;
  let preambleReread = 0;
  let allContext = 0;
  const stats7 = emptyStats();
  const last24: RawRecent = { ...emptyRecent(), sessions: 0 };
  const topRate = Math.max(...Object.values(MODEL_RATE));

  const filesBySource = new Map<Source, typeof input.sessions>();
  for (const session of input.sessions) {
    const list = filesBySource.get(session.source);
    if (list) list.push(session);
    else filesBySource.set(session.source, [session]);
  }

  for (const source of input.live) {
    for (const file of filesBySource.get(source) ?? []) {
      if (file.mtimeMs < cutoff.getTime()) continue; // untouched since before the window
      let cost = 0;
      let reads = 0;
      const wakes = emptyWakes();
      let count = 0;
      let peak = 0;
      let hourCost = 0;
      let model: string | null = null;
      let firstContext = 0;
      let firstSeen: Date | null = null;
      let lastSeen: Date | null = null;
      let lastContext = 0;
      let cCost = 0;
      let cCount = 0;
      let cPeak = 0;
      let cReads = 0;
      const cWakes = emptyWakes();
      let project = "";
      let session = "";

      for (const item of file.turns) {
        if (item.when < cutoff) continue;
        const context = item.baseIn + item.cacheRead + item.cacheWrite;
        if (!context) continue;

        const rate = modelRate(item.model);
        const raw =
          item.baseIn +
          CACHE_READ_RATE * item.cacheRead +
          CACHE_WRITE_RATE * item.cacheWrite +
          OUTPUT_RATE * item.output;
        const priced = rate ?? 1;
        const weighted = priced * raw;
        if (rate === null) {
          bump(unpriced, item.model || "unknown");
          unpricedCost += weighted;
        }

        project = item.project;
        session = item.session;
        const key = sessionKey(source, project, session);
        count += 1;
        cost += weighted;
        total += weighted;
        model = item.model || model;
        if (item.when >= hour1Cut) {
          bumpMap(lastHour, source, weighted);
          hourCost += weighted;
        }
        for (const [h, cut] of gainCuts) if (item.when >= cut) bumpGain(recent, source, h, weighted);
        const week = weeks[source];
        if (week && item.when >= week.start) bumpMap(weekNow, source, weighted);
        allContext += context;
        const isTop = rate !== null && rate >= topRate;
        stats7.turns += 1;
        if (isTop) stats7.top += weighted;
        if (source === "claude") {
          // Codex logs no cache writes, so it would read as 0%
          stats7.cache_write += item.cacheWrite;
          stats7.cache_input += context;
        }
        if (context > peak) peak = context;
        bump(byProject, project, weighted);
        bump(bySource, source, weighted);
        const label = bucketLabel(context);
        bump(bySize, label, weighted);
        turnsBySize.set(label, (turnsBySize.get(label) ?? 0) + 1);
        for (const name of item.tools) if (name) bump(tools, name);
        const hour = hourStart(item.when);
        const slot = timeline.get(hour) ?? (timeline.set(hour, [0, 0]), timeline.get(hour)!);
        slot[context >= 300_000 ? 1 : 0] += weighted;
        // Benchmark: the same turn if auto-compact had kept context at BENCH_WINDOW.
        const trimmed = Math.max(item.cacheRead - Math.max(context - BENCH_WINDOW, 0), 0);
        const hourSlot = hourly.get(hour) ?? emptySlot();
        const benchTurn = weighted - priced * (CACHE_READ_RATE * (item.cacheRead - trimmed));
        hourSlot.bench += benchTurn;
        if (!hourly.has(hour)) hourly.set(hour, hourSlot);
        if (week && item.when >= week.start) {
          const per2 = weekHourly.get(source) ?? new Map<number, [number, number]>();
          if (!weekHourly.has(source)) weekHourly.set(source, per2);
          const bucket = per2.get(hour) ?? [0, 0];
          bucket[0] += weighted;
          bucket[1] += benchTurn;
          per2.set(hour, bucket);
        }
        hourSlot.ctx.push(context);
        hourSlot.reads += item.reads;
        hourSlot.calls += item.tools.length;
        contexts.push(context);
        totals.tool_calls += item.tools.length;
        totals.reads += item.reads;
        reads += item.reads;
        for (const wake of item.wakes) wakes[wake] += 1;
        for (const wake of item.wakes) totals[wake] += 1;

        const p = perSource(per, source);
        p.total += weighted;
        p.turns += 1;
        if (context >= 300_000) p.over += weighted;
        p.sessions.add(key);
        p.contexts.push(context);
        p.stats7.turns += 1;
        if (isTop) p.stats7.top += weighted;
        p.totals.tool_calls += item.tools.length;
        p.totals.reads += item.reads;
        for (const wake of item.wakes) p.totals[wake] += 1;
        if (source === "claude") {
          p.stats7.cache_write += item.cacheWrite;
          p.stats7.cache_input += context;
        }

        if (item.when >= recentCut) {
          cCost += weighted;
          cCount += 1;
          if (context > cPeak) cPeak = context;
          cReads += item.reads;
          for (const wake of item.wakes) cWakes[wake] += 1;
          last24.total += weighted;
          if (context >= 300_000) last24.over += weighted;
          last24.turns += 1;
          last24.contexts.push(context);
          last24.tool_calls += item.tools.length;
          last24.reads += item.reads;
          for (const wake of item.wakes) last24.wakes[wake] += 1;
          if (isTop) last24.top += weighted;
          if (source === "claude") {
            last24.cache_write += item.cacheWrite;
            last24.cache_input += context;
          }
          const p24 = p.recent;
          p24.total += weighted;
          if (context >= 300_000) p24.over += weighted;
          p24.turns += 1;
          p24.contexts.push(context);
          p24.tool_calls += item.tools.length;
          p24.reads += item.reads;
          for (const wake of item.wakes) p24.wakes[wake] += 1;
          if (isTop) p24.top += weighted;
          if (source === "claude") {
            p24.cache_write += item.cacheWrite;
            p24.cache_input += context;
          }
        }

        if (count === 1) {
          firstContext = context;
          firstSeen = item.when;
        }
        lastSeen = item.when;
        lastContext = context;
      }

      if (!count) continue;
      const key = sessionKey(source, project, session);
      // The first turn is the always-resident prefix: instructions, memory, skill
      // catalog, tool schemas. Every later turn re-reads it.
      preambleReread += firstContext * count;
      preambles.push(firstContext);
      const hours = firstSeen && lastSeen ? (lastSeen.getTime() - firstSeen.getTime()) / 3_600_000 : 0;
      sessions.set(key, [cost, count, peak, hours]);
      signals.set(key, [reads, wakes]);
      if (cCount) {
        sessions24.set(key, [cCost, cCount, cPeak, hours]);
        signals24.set(key, [cReads, cWakes]);
        if (firstSeen && firstSeen >= recentCut) last24.preambles.push(firstContext);
        const p = perSource(per, source);
        p.recent.sessions += 1;
        if (firstSeen && firstSeen >= recentCut) p.recent.preambles.push(firstContext);
      }
      const p = perSource(per, source);
      p.preambles.push(firstContext);
      if (hours > p.hours_all) p.hours_all = hours;
      if (hours > p.hours24) p.hours24 = hours;
      paths.set(key, file.path);
      if (source === "claude") titles.set(key, file.title);
      const idle = lastSeen ? (now.getTime() - lastSeen.getTime()) / 60_000 : 0;
      if (idle <= ACTIVE_MINUTES) active.push([key, lastContext, idle, model, hourCost]);
    }
  }

  if (!total) return null;

  const share = (value: number): number => (100 * value) / total;
  const byCost = (a: [string, [number, number, number, number]], b: [string, [number, number, number, number]]) => b[1][0] - a[1][0];
  const top = [...sessions.entries()].sort(byCost).slice(0, 10);

  const buckets: RawReport["buckets"] = [];
  for (const [low, high] of SIZE_BUCKETS) {
    const label = bucketRowLabel(low, high);
    if (bySize.get(label)) {
      buckets.push([label, low, share(bySize.get(label)!), turnsBySize.get(label)!]);
    }
  }
  preambles.sort((a, b) => a - b);
  last24.sessions = sessions24.size;
  const share24 = (value: number): number => (last24.total ? (100 * value) / last24.total : 0);
  const flags24 = (key: string): string[] => {
    const row = sessions24.get(key);
    if (!row) return [];
    const [, turns, cPeak, hours] = row;
    const [cReads, cWakes] = signals24.get(key)!;
    return sessionFlags(turns, cPeak, hours, cReads, cWakes);
  };
  const sessionRow = (
    key: string,
    [cost, count, peak, hours]: [number, number, number, number],
    shareOf: (value: number) => number,
  ): SessionRow => {
    const [source, project, session] = splitKey(key);
    return {
      source: source as Source,
      project: project || "?",
      id: (session || "?").slice(0, 8),
      title: titles.get(key) ?? null,
      path: paths.get(key) ?? null,
      share: shareOf(cost),
      turns: count,
      peak,
      hours,
      flags: flags24(key),
    };
  };

  const report: RawReport = {
    days,
    total,
    turns: [...sessions.values()].reduce((sum, row) => sum + row[1], 0),
    session_count: sessions.size,
    sources: [...bySource.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, value]) => [name as Source, share(value)]),
    buckets,
    over_300k: buckets.filter((b) => b[1] >= 300).reduce((sum, b) => sum + b[2], 0),
    preamble: preambles.length
      ? [preambles[preambles.length >> 1], preambles[Math.trunc(preambles.length * 0.9)], (100 * preambleReread) / allContext]
      : null,
    projects: [...byProject.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, value]) => [name, share(value)]),
    sessions: top.map(([key, row]) => sessionRow(key, row, share)),
    recent_sessions: [...sessions24.entries()]
      .sort(byCost)
      .slice(0, 10)
      .map(([key, row]) => sessionRow(key, row, share24)),
    recent: last24,
    tools: mostCommon(tools, 6),
    config: configChecks(input.live, config),
    unpriced: unpriced.size ? [share(unpricedCost), mostCommon(unpriced, 5)] : null,
    active: active
      .sort((a, b) => b[4] - a[4])
      .map(([key, context, idle, model, rate]): ActiveSession => {
        const [source, project, session] = splitKey(key);
        const src = source as Source;
        const sessionData = sessions.get(key)!;
        const hourSpend = lastHour.get(src) ?? 0;
        return {
          source: src,
          project: project || "?",
          id: (session || "?").slice(0, 8),
          title: titles.get(key) ?? null,
          share: share(sessionData[0]),
          turns: sessionData[1],
          peak: sessionData[2],
          hours: sessionData[3],
          context,
          idle,
          flags: flags24(key),
          model,
          rate,
          rateShare: hourSpend ? (100 * rate) / hourSpend : 0,
        };
      }),
    timeline: [...timeline.entries()].sort((a, b) => a[0] - b[0]).map(([hour, slot]) => [new Date(hour), slot]),
    hourly: [...hourly.entries()].sort((a, b) => a[0] - b[0]).map(([hour, slot]) => [new Date(hour), slot]),
    bench_total: [...hourly.values()].reduce((sum, slot) => sum + slot.bench, 0),
    budget: input.weeklyBudget ? input.weeklyBudget * 1e6 : null,
    stats7,
    per_source: {},
    baseline: [],
    burns: {},
  };

  for (const src of input.live) {
    const p = per.get(src);
    if (!p || !p.total) continue;
    const ctx = [...p.contexts].sort((a, b) => a - b);
    const pre = [...p.preambles].sort((a, b) => a - b);
    report.per_source[src] = {
      recent: p.recent,
      stats7: p.stats7,
      totals: p.totals,
      turns: p.turns,
      total: p.total,
      over_300k: p.over,
      session_count: p.sessions.size,
      hours24: p.hours24,
      hours_all: p.hours_all,
      contexts: ctx,
      preambles: pre,
      preamble: pre.length ? [pre[pre.length >> 1], pre[Math.trunc(pre.length * 0.9)]] : null,
    };
  }
  report.baseline = baseline(report, config);

  for (const src of input.live) {
    const spend = bySource.get(src);
    if (!spend) continue;
    const week = weeks[src];
    const spent = weekNow.get(src) ?? 0;
    const burn: RawReport["burns"][Source] = { rate: lastHour.get(src) ?? 0, total: spend, week: null };
    if (week && week.used >= 1 && spent) {
      // Calibrate: this week's local spend is `used` percent of the plan's week.
      const limit = (spent * 100) / week.used;
      const hoursLeft = Math.max((week.resets.getTime() - now.getTime()) / 3_600_000, 1);
      const weekRecent = recent.get(src) ?? new Map<number, number>();
      const gains: Record<string, number> = {};
      for (const h of GAIN_HOURS) gains[h] = ((weekRecent.get(h) ?? 0) * 100) / limit;
      // Quota points per hour over the last 24 h. A week younger than that has spent only its
      // own points, so divide by the time since the week began.
      const age = Math.max((now.getTime() - week.start.getTime()) / 3_600_000, 1);
      const rate24 = age < CHECK_HOURS ? week.used / age : gains[CHECK_HOURS] / CHECK_HOURS;
      const left = 100 - week.used;
      const toEmpty = rate24 > 0 ? left / rate24 : null;
      const dry = toEmpty ? new Date(now.getTime() + toEmpty * 3_600_000) : null;
      const rawWeek: RawWeek = {
        resets: week.resets,
        hours_left: hoursLeft,
        used: week.used,
        ideal: Math.max(limit - spent, 0) / hoursLeft,
        limit,
        start: week.start,
        rate_pct: (burn.rate * 100) / limit,
        ideal_pct: Math.max(left, 0) / hoursLeft,
        burndown: weekPoints(weekHourly.get(src) ?? new Map(), week.start, now, limit),
        projection: {
          rate_pct: rate24,
          hours_to_empty: toEmpty,
          runs_out: dry && dry < week.resets ? dry : null,
        },
        gains,
      };
      burn.week = rawWeek;
    }
    report.burns[src] = burn;
  }
  return report;
}

function emptyWakes(): WakeCounts {
  return { human: 0, teammate: 0, task: 0, peer: 0 };
}

function emptyTotals(): Totals {
  return { tool_calls: 0, reads: 0, human: 0, teammate: 0, task: 0, peer: 0 };
}

function emptyStats(): RawStats {
  return { cache_write: 0, cache_input: 0, turns: 0, top: 0 };
}

function emptyRecent(): RawRecent {
  return {
    total: 0,
    over: 0,
    turns: 0,
    contexts: [],
    tool_calls: 0,
    reads: 0,
    wakes: emptyWakes(),
    preambles: [],
    cache_write: 0,
    cache_input: 0,
    top: 0,
    sessions: 0,
  };
}

function emptySlot(): HourSlot {
  return { bench: 0, ctx: [], reads: 0, calls: 0 };
}

interface PerSource {
  recent: RawRecent;
  stats7: RawStats;
  totals: Totals;
  contexts: number[];
  preambles: number[];
  turns: number;
  total: number;
  over: number;
  sessions: Set<string>;
  hours24: number;
  hours_all: number;
}

function perSource(per: Map<Source, PerSource>, src: Source): PerSource {
  let p = per.get(src);
  if (!p) {
    p = {
      recent: emptyRecent(),
      stats7: emptyStats(),
      totals: emptyTotals(),
      contexts: [],
      preambles: [],
      turns: 0,
      total: 0,
      over: 0,
      sessions: new Set(),
      hours24: 0,
      hours_all: 0,
    };
    per.set(src, p);
  }
  return p;
}

/** The hour a turn falls in, as an epoch. burn.py:644 */
function hourStart(when: Date): number {
  return Math.floor(when.getTime() / 3_600_000) * 3_600_000;
}

/** Session identity: the source, project and session id Python used as a tuple key. */
function sessionKey(source: Source, project: string, session: string): string {
  return JSON.stringify([source, project, session]);
}

function splitKey(key: string): [Source, string, string] {
  const [source, project, session] = JSON.parse(key) as [Source, string, string];
  return [source, project, session];
}

function bump(map: Map<string, number>, key: string, value = 1): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function bumpMap(map: Map<Source, number>, key: Source, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function bumpGain(map: Map<Source, Map<number, number>>, key: Source, hours: number, value: number): void {
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }
  inner.set(hours, (inner.get(hours) ?? 0) + value);
}

/** Counter.most_common(n): by count down, insertion order for ties. */
function mostCommon(map: Map<string, number>, n: number): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}