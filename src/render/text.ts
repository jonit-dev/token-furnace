/**
 * The terminal output: burn.py's print_doctor and print_text, same strings. burn.py:1028, 1142
 *
 * Both read the raw report, because they use burn.py's own key names (session_count, bench_total,
 * recent_sessions). `%f` goes through core/analyze/format so the numbers round like Python's.
 */

import { burnGoal } from "../core/analyze/burn";
import { fixed, int0 } from "../core/analyze/format";
import { BENCH_WINDOW, CHECK_HOURS } from "../core/analyze/flags";
import { topIssues } from "../core/analyze/issues";
import { CACHE_READ_RATE, CACHE_WRITE_RATE } from "../core/analyze/pricing";
import type { RawBurn, RawReport, Source } from "../core/model";

/** Python's %-8s and friends. */
const end = (text: string, width: number): string => text.padEnd(width);
const start = (text: string, width: number): string => text.padStart(width);

/** The doctor verdict: each leak with its share and fix, then the baseline gaps. */
export function printDoctor(report: RawReport, htmlPath: string | null): string {
  const out: string[] = [];
  const issues = topIssues(report);
  out.push(
    `TOKEN FURNACE: last ${report.days} days, ${fixed(report.total / 1e6)}M weighted tokens, ` +
      `${int0(report.session_count)} sessions`,
  );
  for (const [source, burn] of Object.entries(report.burns) as [Source, RawBurn][]) {
    const [goal, basis] = burnGoal(report, source);
    out.push(
      `Burn (${source}): ${fixed(burn.rate / 1e6, 1)}M in the last hour, ` +
        `goal ${fixed(goal / 1e6, 1)}M/h (${basis})`,
    );
  }
  for (const s of report.active) {
    const flags = s.flags.length ? `; ${s.flags.map((f) => f.split(":")[0]).join(", ")}` : "";
    out.push(
      `Active: ${(s.title || "(untitled)").slice(0, 40)} (${s.source} ${s.id}, ${s.model || "?"}) ` +
        `burning ${fixed(s.rate / 1e6, 1)}M/h (${fixed(s.rateShare)}% of the hour), ` +
        `context ${fixed(s.context / 1000)}k, ${int0(s.turns)} turns, ${fixed(s.hours)}h old, ` +
        `idle ${fixed(s.idle)}m${flags}`,
    );
  }
  out.push(
    issues.length
      ? `Verdict: ${issues.length} leak${issues.length === 1 ? "" : "s"} found in the last ` +
          `${CHECK_HOURS} h, largest first.\n`
      : `Verdict: healthy. No common token leaks in the last ${CHECK_HOURS} h.`,
  );
  issues.forEach((issue, i) => {
    const where =
      issue.share === null ? "config" : `${fixed(issue.share)}% of spend, ${issue.hits.length} sessions`;
    out.push(`${i + 1}. [P${issue.priority}] ${issue.title} (${where})`);
    out.push(`   Fix: ${issue.fix}`);
    for (const [session, flag] of [...issue.hits]
      .sort((a, b) => b[0].share - a[0].share)
      .slice(0, 2)) {
      out.push(`   e.g. ${(session.title || session.id).slice(0, 40)}: ${flag.split(".")[0]}`);
    }
  });
  out.push(
    `\nBenchmark: the same turns at a ${fixed(BENCH_WINDOW / 1000)}k compaction window would cost ` +
      `about ${fixed(report.bench_total / 1e6)}M ` +
      `(${fixed(100 * (1 - report.bench_total / report.total))}% less). Estimate: trims cached ` +
      `context only.`,
  );
  const gaps = report.baseline.filter((row) => !row.ok);
  if (gaps.length) {
    out.push(`\nBaseline gaps (last ${CHECK_HOURS} h -> recommended):`);
    for (const row of gaps) {
      out.push(`  ${end(row.level, 8)} ${end(row.name, 28)} ${end(row.now_24h, 18)} ${row.target}`);
    }
  }
  if (htmlPath) {
    out.push(`\nReport: ${htmlPath}`);
    out.push('Open it and press "Copy for Claude" on a leak to hand over the fix with evidence.');
  }
  return `${out.join("\n")}\n`;
}

/** The full text report: the old burn.py default output. */
export function printText(report: RawReport): string {
  const out: string[] = [];
  out.push(
    `=== ${report.days}-day burn: ${fixed(report.total / 1e6)}M weighted tokens, ` +
      `${int0(report.session_count)} sessions, ${int0(report.turns)} turns ===`,
  );
  if (report.sources.length > 1) {
    out.push(`  ${report.sources.map(([name, pct]) => `${name} ${fixed(pct)}%`).join("   ")}`);
  }

  out.push("\nSPEND BY CONTEXT SIZE OF THE TURN   <- the main lever");
  for (const [label, , pct, turns] of report.buckets) {
    out.push(`  ${end(label, 12)} ${start(fixed(pct, 1), 6)}%   ${start(int0(turns), 6)} turns`);
  }
  out.push(
    `  --> ${fixed(report.over_300k)}% of spend is on turns carrying more than 300k of context`,
  );

  if (report.preamble) {
    out.push("\nALWAYS-RESIDENT PREAMBLE (instructions, memory, skill catalog, tool schemas)");
    out.push(
      `  p50=${fixed(report.preamble[0] / 1000)}k  p90=${fixed(report.preamble[1] / 1000)}k per ` +
        `session  ->  ${fixed(report.preamble[2])}% of every token read`,
    );
    out.push(
      `  Prune it once, then leave it stable: reads bill at ${fixed(CACHE_READ_RATE, 1)}x but ` +
        `rewrites at ${fixed(CACHE_WRITE_RATE, 2)}x.`,
    );
  }

  out.push("\nTOP PROJECTS");
  for (const [name, pct] of report.projects) {
    out.push(`  ${start(fixed(pct, 1), 6)}%  ${name.slice(-58)}`);
  }

  out.push("\nTOP SESSIONS (the long ones are where the budget goes)");
  for (const s of report.sessions) {
    out.push(
      `  ${start(fixed(s.share, 1), 5)}%  turns=${end(int0(s.turns), 5)} ` +
        `peak=${start(fixed(s.peak / 1000), 4)}k  ${start(fixed(s.hours, 1), 4)}h  ` +
        `${end(s.source, 6)} ${s.project.slice(-36)} ${s.id}  ${(s.title || "").slice(0, 50)}`,
    );
  }

  out.push("\nTOOL CALLS");
  for (const [name, value] of report.tools) {
    out.push(`  ${end(name, 28)} ${int0(value)}`);
  }

  out.push(`\nLEAK CHECKS (top sessions of the last ${CHECK_HOURS} h; each flag names its fix)`);
  const flagged = report.recent_sessions.filter((s) => s.flags.length);
  for (const s of flagged) {
    out.push(`  ${start(fixed(s.share, 1), 5)}%  ${s.source} ${s.id}  ${s.title || ""}`);
    for (const flag of s.flags) out.push(`          - ${flag}`);
  }
  if (!flagged.length) out.push("  none");

  out.push("\nCONFIG CHECKS");
  for (const line of report.config) out.push(`  - ${line}`);

  out.push(`\nBASELINE (last ${CHECK_HOURS} h, ${report.days}-day value, recommended)`);
  for (const row of report.baseline) {
    out.push(
      `  ${end(row.level, 8)} ${end(row.name, 28)} ${end(row.now_24h, 18)} ` +
        `${end(row.value_7d ?? "", 8)} ${row.target}`,
    );
  }

  if (report.unpriced) {
    out.push(
      `\nUNPRICED MODELS (counted at 1.0x -- ${fixed(report.unpriced[0])}% of reported spend)`,
    );
    for (const [name, value] of report.unpriced[1]) {
      out.push(`  ${end(name, 28)} ${int0(value)} turns`);
    }
    out.push("  Add a ratio to MODEL_RATE to price these correctly.");
  }
  return `${out.join("\n")}\n`;
}