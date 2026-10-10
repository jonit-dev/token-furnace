/**
 * Parity harness: the same fixture directory through Python and through TypeScript, with the two
 * Report values deep-compared. The Python side is the oracle, so this is the proof that the port
 * changes no result. burn.py stays until PRD-003.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFull } from "./fixtures/build";
import {
  compare,
  fixedNow,
  harnessEnv,
  normalizeTimes,
  pythonReport,
  tsReport,
} from "./harness";

describe("parity with burn.py", () => {
  const now = fixedNow();
  const root = mkdtempSync(join(tmpdir(), "tf-parity-"));
  const env = () => harnessEnv(root, now);

  beforeAll(() => {
    buildFull(root, now);
  });

  const cases: [name: string, source: string, budget: number | null][] = [
    ["--source all", "all", null],
    ["claude", "claude", null],
    ["codex", "codex", null],
    ["all with --weekly-budget", "all", 50],
    ["claude with --weekly-budget", "claude", 50],
  ];

  for (const [name, source, budget] of cases) {
    it(`matches Python for ${name}`, () => {
      const python = pythonReport(env(), 7, budget, source) as Record<string, unknown> | null;
      const typescript = tsReport(env(), now, 7, budget, source);
      // generated is the clock each side read; it is the only field we ignore.
      if (python) delete python.generated;
      if (typescript) delete (typescript as { generated?: string }).generated;
      const diffs = compare(normalizeTimes(typescript), normalizeTimes(python));
      expect(diffs, diffs.slice(0, 20).join("\n")).toEqual([]);
    }, 60_000);
  }

  it("covers every leak and every config check, so parity reaches each branch", () => {
    const report = tsReport(env(), now, 7, null, "all")!;
    const flags = report.topSessions.flatMap((s) => s.flags.map((f: string) => f.split(":")[0]));
    expect(new Set(flags)).toEqual(
      new Set(["late compaction", "caller reads", "wakeups", "loop", "long-lived"]),
    );
    // 5 Claude settings + MEMORY.md + 4 Codex settings, every one over its target.
    expect(report.config).toHaveLength(10);
    const titles = report.issues.map((i) => i.title);
    for (const want of [
      "Sessions compact too late",
      "The caller reads files and logs itself",
      "Too many wakeups",
      "Autonomous loops run without a budget",
      "Sessions stay open too long",
      "Config: autoCompactWindow",
      "Config: subagent fan-out cap",
      "Config: subagent nesting depth",
      "Config: subagent model",
      "Config: tool-call concurrency",
      "Config: subagent reasoning effort",
      "Config: auto-compact token limit",
      "Config: memory index too long",
    ]) {
      expect(titles, `missing issue ${want}`).toContain(want);
    }
    // Both agents are over their fan-out cap, so that title appears once per agent.
    expect(titles.filter((t) => t === "Config: subagent fan-out cap")).toHaveLength(2);
    expect(report.burns.claude).not.toBeNull();
    expect(report.burns.codex).not.toBeNull();
    expect(report.burns.claude!.weekBurndown).not.toBeNull();
    expect(report.unpriced).toBeNull();
  });
});