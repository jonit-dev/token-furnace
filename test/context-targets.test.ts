import { describe, expect, it } from "vitest";
import { CONTEXT_TARGET } from "../src/core/context";
import { buildReport } from "../src/core/analyze/report";
import { reportView } from "../src/core/analyze/view";
import { configNotes } from "../src/core/analyze/config-checks";
import type { ReportInput, Source } from "../src/core/model";

const now = new Date("2026-10-10T12:00:00Z");
function report(turns: [Source, number][]) {
  const input: ReportInput = {
    now, days: 7, weeklyBudget: null, planWeek: null, codexWeek: null,
    live: [...new Set(turns.map(([source]) => source))],
    config: { claudeBase: "", claudeHome: "", settings: JSON.stringify({ autoCompactWindow: CONTEXT_TARGET.claude }),
      codexConfig: `model_auto_compact_token_limit = ${CONTEXT_TARGET.codex}`, env: {}, memoryIndexes: [] },
    sessions: turns.map(([source, context], index) => ({
      source, path: `/fixture/${source}-${index}.jsonl`, mtimeMs: now.getTime(), title: `${source} ${index}`,
      turns: [{ source, project: "demo", session: `${source}-${index}`, model: "gpt-5.5", when: now,
        baseIn: 0, cacheRead: context, cacheWrite: 0, output: 0, tools: [], reads: 0, wakes: ["human"] }],
    })),
  };
  return buildReport(input)!;
}

describe("shared provider context targets", () => {
  it.each(["claude", "codex"] as Source[])("uses %s target consistently at the boundary", (source) => {
    const target = CONTEXT_TARGET[source];
    for (const size of [target - 1, target, target + 1]) {
      const raw = report([[source, size]]);
      const view = reportView(raw, now);
      const above = size > target;
      expect(raw.over_target).toBeCloseTo(above ? 100 : 0);
      expect(view.timeline[0][above ? 2 : 1]).toBe(raw.total);
      expect(view.kpis.find((k) => k.name === "Turns over provider context target")?.values).toEqual([above ? 1 : 0]);
      expect(view.kpis.find((k) => k.name.includes("median context"))?.target).toBe(target);
      expect(view.baseline.find((r) => r.source === source && r.name === "Median context per turn")?.target).toBe(`at most ${target / 1000}k`);
      expect(raw.sessions[0].flags.some((flag) => flag.startsWith("late compaction:"))).toBe(above);
      expect(view.actions.some((action) => action.includes("/compact"))).toBe(above);
      expect(raw.bench_total).toBeLessThanOrEqual(raw.total);
      if (!above) expect(raw.bench_total).toBe(raw.total);
      else expect(raw.bench_total).toBeLessThan(raw.total);
      expect(view.buckets[0].aboveTargetShare).toBeCloseTo(above ? 100 : 0);
    }
  });

  it("compares mixed-provider turns with their own targets in spend and benchmarks", () => {
    const raw = report([["claude", 350000], ["codex", 350000]]);
    const view = reportView(raw, now);
    expect(view.overTarget).toBe(50);
    expect(view.timeline[0][1]).toBe(view.timeline[0][2]);
    expect(view.buckets[0].aboveTargetShare).toBe(50);
    expect(view.contextTargets).toEqual({ claude: 400000, codex: 300000 });
    expect(raw.bench_total).toBeCloseTo(raw.total * (650000 / 700000));
    expect(configNotes(["claude", "codex"], {
      claudeBase: "", claudeHome: "", settings: '{"autoCompactWindow":400000}',
      codexConfig: 'model_auto_compact_token_limit = 300000', env: {}, memoryIndexes: [],
    }).filter((note) => note.name === "autoCompactWindow" || note.name === "Auto-compact token limit").every((note) => note.ok)).toBe(true);
  });
});
