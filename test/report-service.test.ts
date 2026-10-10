/**
 * The service over a fixture directory: the real wiring must read the same files as the test
 * harness, and a second scan must not parse a file that did not change.
 */

import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compose, type App } from "../src/compose";
import { MemorySessionRepository } from "../src/repo/memory-repo";
import { buildFull, saveUsageReading } from "./fixtures/build";
import { fixedNow, harnessEnv, planWeek, tsReport } from "./harness";

const now = fixedNow();

function fixtureApp(): App {
  const root = mkdtempSync(join(tmpdir(), "tf-service-"));
  buildFull(root, now);
  return compose({ ...harnessEnv(root, now), TOKEN_FURNACE_NOW: now.toISOString() });
}

/** Count every transcript parse, so the cache can be seen working. */
function parseLog(app: App): string[] {
  const seen: string[] = [];
  for (const source of app.sources) {
    const parse = source.parse.bind(source);
    source.parse = (path: string) => {
      seen.push(path);
      return parse(path);
    };
  }
  return seen;
}

describe("refresh", () => {
  it("parses a changed file once and leaves the rest alone", () => {
    const app = fixtureApp();
    const seen = parseLog(app);
    app.reports.refresh();
    expect(seen).toHaveLength(4); // three Claude sessions and one Codex rollout
    app.reports.refresh();
    expect(seen).toHaveLength(4); // nothing changed since the last scan
    appendFileSync(seen[0], `${JSON.stringify({ type: "user", message: { content: "again" } })}\n`);
    app.reports.refresh();
    expect(seen).toHaveLength(5); // only the file that grew is reparsed
  });

  it("drops a file that is gone from disk", () => {
    const repo = new MemorySessionRepository();
    const file = { path: "/tmp/gone.jsonl", mtimeMs: 1, size: 10 };
    repo.save({ source: "claude", path: file.path, mtimeMs: 1, title: null, turns: [] }, 10);
    expect(repo.all()).toHaveLength(1);
    expect(repo.changed([{ ...file, mtimeMs: 2 }])).toEqual([{ ...file, mtimeMs: 2 }]); // mtime moved
    expect(repo.changed([file])).toEqual([]); // unchanged: reuse the parse
    expect(repo.changed([{ ...file, size: 11 }])).toEqual([{ ...file, size: 11 }]); // it grew
    expect(repo.changed([])).toEqual([]);
    expect(repo.all()).toEqual([]); // gone from disk
  });
});

describe("getReport", () => {
  it("reads the same files as the test harness, and the same cached plan week", () => {
    const app = fixtureApp();
    app.reports.refresh();
    const root = String(app.env.CLAUDE_CONFIG_DIR);
    const week = planWeek(root, now);
    expect(app.reports.getReport(7, "all", { weeklyBudget: null, planWeek: week, now })).toEqual(
      tsReport(app.env, now, 7, null, "all"),
    );
    expect(app.reports.getReport(7, "claude", { weeklyBudget: null, planWeek: week, now })).toEqual(
      tsReport(app.env, now, 7, null, "claude"),
    );
  });

  it("has no report when no agent is installed, and the plan week is opt-in", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-service-empty-"));
    const app = compose({ ...harnessEnv(root, now), CLAUDE_CONFIG_DIR: join(root, "none") });
    app.reports.refresh();
    expect(app.reports.getRaw(7, "all", { weeklyBudget: null, now })).toBeNull();
    expect(app.reports.live("all")).toEqual([]);

    const withData = fixtureApp();
    withData.reports.refresh();
    const root2 = String(withData.env.CLAUDE_CONFIG_DIR);
    saveUsageReading(root2, now);
    const opts = { weeklyBudget: null, now };
    expect(withData.reports.getReport(7, "claude", opts)?.burns.claude?.weekBurndown).toBeNull();
    expect(
      withData.reports.getReport(7, "claude", { ...opts, planWeek: planWeek(root2, now) })
        ?.burns.claude?.weekBurndown,
    ).not.toBeNull();
  });

  it("counts the leak the fixture plants, from both agents", () => {
    const app = fixtureApp();
    app.reports.refresh();
    const report = app.reports.getReport(7, "all", { weeklyBudget: null, now })!;
    expect(report.issues.map((i) => i.title)).toContain("Sessions compact too late");
    expect(Object.keys(report.burns).sort()).toEqual(["claude", "codex"]);
    expect(report.turns).toBeGreaterThan(300);
  });
});