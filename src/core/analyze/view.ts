import { burnGoal } from "./burn";
import { fixed, int0 } from "./format";
import { BENCH_WINDOW, CHECK_HOURS, LATE_COMPACT_PEAK, LEVELS, LONG_LIVED_HOURS } from "./flags";
import { issuePrompt, topIssues } from "./issues";
import type { Burn, RawBurn, RawReport, Report, Source } from "../model";

/** Python's datetime.isoformat() for a UTC datetime: seconds, optional microseconds, +00:00. */
function iso(when: Date): string {
  // Python's isoformat() timespec="auto": seconds, and a fraction only when it is nonzero.
  const text = when.toISOString();
  const body = text.endsWith(".000Z") ? text.slice(0, -5) : text.slice(0, -1);
  return `${body}+00:00`;
}

const median = (xs: number[]): number => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0);

/** Everything dashboard.html draws, as JSON-ready data. The page owns all markup. burn.py:1415 */
export function reportView(report: RawReport, now: Date): Report {
  const issues = topIssues(report);
  const actual = new Map(report.timeline.map(([hour, slot]) => [hour.getTime(), slot]));
  let runA = 0;
  let runB = 0;
  const burndown: [string, number, number][] = [];
  for (const [when, slot] of report.hourly) {
    const seen = actual.get(when.getTime());
    runA += seen ? seen[0] + seen[1] : 0;
    runB += slot.bench;
    burndown.push([iso(new Date(when.getTime() + 3_600_000)), runA, runB]);
  }

  const blocks = new Map<number, { ctx: number[]; reads: number; calls: number }>();
  for (const [when, slot] of report.hourly) {
    const key = when.getTime() - (when.getUTCHours() % 3) * 3_600_000;
    const block = blocks.get(key) ?? { ctx: [], reads: 0, calls: 0 };
    if (!blocks.has(key)) blocks.set(key, block);
    block.ctx.push(...slot.ctx);
    block.reads += slot.reads;
    block.calls += slot.calls;
  }
  const blockList = [...blocks.values()];
  const kpis: Report["kpis"] = [
    { name: "Median context per turn", unit: "k", target: 150_000, values: blockList.map((b) => median(b.ctx)) },
    {
      name: "Turns over 300k context",
      unit: "%",
      target: 0.1,
      values: blockList.map((b) => b.ctx.filter((c) => c >= 300_000).length / Math.max(b.ctx.length, 1)),
    },
    {
      name: "Caller reads per tool call",
      unit: "%",
      target: 0.2,
      values: blockList.map((b) => b.reads / Math.max(b.calls, 1)),
    },
  ];

  // Act now: what a live session needs this minute, before any leak report.
  const actions: string[] = [];
  for (const s of report.active) {
    const name = s.title || s.id;
    if (s.context >= LATE_COMPACT_PEAK) {
      actions.push(`Run /compact in “${name}”: its context is ${int0(s.context / 1000)}k.`);
    } else if (s.hours >= LONG_LIVED_HOURS) {
      actions.push(`Finish “${name}” and start a fresh session: it is ${fixed(s.hours)}h old.`);
    }
  }

  const burns: Partial<Record<Source, Burn>> = {};
  for (const [source, burn] of Object.entries(report.burns) as [Source, RawBurn][]) {
    const [goal, basis] = burnGoal(report, source);
    const week = burn.week;
    burns[source] = {
      rate: burn.rate,
      goal,
      basis,
      resets: week ? iso(week.resets) : null,
      hoursLeft: week ? week.hours_left : null,
      used: week ? week.used : null,
      gains: week ? week.gains : null,
      limit: week ? week.limit : null,
      ratePct: week ? week.rate_pct : null,
      idealPct: week ? week.ideal_pct : null,
      start: week ? iso(week.start) : null,
      weekBurndown: week ? week.burndown.map(([t, a, b]) => [iso(t), a, b] as [string, number, number]) : null,
      projection: week
        ? {
            ratePct: week.projection.rate_pct,
            hoursToEmpty: week.projection.hours_to_empty,
            runsOut: week.projection.runs_out ? iso(week.projection.runs_out) : null,
          }
        : null,
    };
  }

  return {
    generated: iso(now),
    days: report.days,
    total: report.total,
    sessions: report.session_count,
    turns: report.turns,
    over300k: report.over_300k,
    burns,
    burn: burns.claude ?? Object.values(burns)[0] ?? null,
    actions,
    issues: issues.map((i) => ({
      title: i.title,
      fix: i.fix,
      priority: i.priority,
      level: LEVELS[i.priority],
      source: i.source,
      share: i.share,
      sessions: i.hits.length,
      prompt: issuePrompt(i),
    })),
    active: report.active,
    burndown,
    benchWindow: BENCH_WINDOW,
    budget: report.budget,
    kpis,
    timeline: report.timeline.map(([t, [cool, hot]]) => [iso(t), cool, hot]),
    checkHours: CHECK_HOURS,
    baseline: report.baseline,
    topSessions: report.sessions,
    buckets: report.buckets.map(([label, low, share, turns]) => ({
      label,
      hot: low >= 300,
      share,
      turns,
    })),
    projects: report.projects,
    config: report.config,
    tools: report.tools,
    unpriced: report.unpriced,
  };
}