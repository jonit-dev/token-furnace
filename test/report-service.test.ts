/**
 * The service over a fixture directory: the real wiring must read the same files as the test
 * harness, and a second scan must not parse a file that did not change.
 */

import { appendFileSync, mkdirSync, realpathSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { compose, type App } from "../src/compose";
import { MemorySessionRepository } from "../src/repo/memory-repo";
import { buildFull, saveUsageReading } from "./fixtures/build";
import { fixedNow, harnessEnv, planWeek, tsReport } from "./harness";

const now = fixedNow();

function fixtureApp(): App {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tf-service-"));
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
  it("parses a changed file once and leaves the rest alone", async () => {
    const app = fixtureApp();
    const seen = parseLog(app);
    await app.reports.refresh();
    expect(seen).toHaveLength(4); // three Claude sessions and one Codex rollout
    await app.reports.refresh();
    expect(seen).toHaveLength(4); // nothing changed since the last scan
    appendFileSync(seen[0], `${JSON.stringify({ type: "user", message: { content: "again" } })}\n`);
    await app.reports.refresh();
    expect(seen).toHaveLength(5); // only the file that grew is reparsed
  });

  it("drops a file that is gone from disk", async () => {
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
  it("keeps lifetime agent peaks outside a one-day report window", async () => {
    const app = fixtureApp();
    await app.reports.refresh();
    const template = app.repo.all().flatMap(file => file.turns)[0];
    const at = new Date(now.getTime() - 10 * 86_400_000);
    for (let i = 0; i < 10; i++) app.repo.save({
      source: "claude", path: `/old-${i}.jsonl`, mtimeMs: at.getTime(), title: null,
      turns: [{ ...template, source: "claude", session: `old-${i}`, when: at, baseIn: 1 }],
    }, 1);
    const report = app.reports.getReport(1, "all", { weeklyBudget: null, now })!;
    expect(report.agentActivity?.peakLifetime).toBe(10);
    expect(report.agentActivity?.peak7d).toBeLessThan(10);
    expect(report.agentActivity?.timeline.at(-1)?.[1]).toBe(report.active.length);
    expect(report.agentActivity).toEqual(app.reports.getReport(7, "all", { weeklyBudget: null, now })!.agentActivity);
  });

  it("reads the same files as the test harness, and the same cached plan week", async () => {
    const app = fixtureApp();
    await app.reports.refresh();
    const root = String(app.env.CLAUDE_CONFIG_DIR);
    const week = planWeek(root, now);
    expect(app.reports.getReport(7, "all", { weeklyBudget: null, planWeek: week, now })).toEqual(
      tsReport(app.env, now, 7, null, "all"),
    );
    expect(app.reports.getReport(7, "claude", { weeklyBudget: null, planWeek: week, now })).toEqual(
      tsReport(app.env, now, 7, null, "claude"),
    );
  });

  it("the days cutoff the service hands the repository reads the same report as every turn", async () => {
    const app = fixtureApp();
    await app.reports.refresh();
    const root = String(app.env.CLAUDE_CONFIG_DIR);
    saveUsageReading(root, now); // the plan week starts before a 1-day window: the quirky baseline
    const opts = { weeklyBudget: null, planWeek: planWeek(root, now), now };
    const realAll = app.repo.all.bind(app.repo);
    let sawCutoff: Date | undefined;
    for (const [days, source] of [
      [7, "all"],
      [1, "all"],
      [30, "all"],
      [7, "claude"],
      [7, "codex"],
    ] as const) {
      app.repo.all = () => realAll(); // ignore the cutoff: buildReport sees every turn
      const baseline = app.reports.getRaw(days, source, opts);
      app.repo.all = (cutoff?: Date) => {
        sawCutoff = cutoff;
        return realAll(cutoff);
      };
      expect(app.reports.getRaw(days, source, opts)).toEqual(baseline);
    }
    expect(sawCutoff).toBeInstanceOf(Date);
    app.repo.all = realAll;
  });

  it("has no report when no agent is installed, and the plan week is opt-in", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "tf-service-empty-"));
    const app = compose({ ...harnessEnv(root, now), CLAUDE_CONFIG_DIR: join(root, "none") });
    await app.reports.refresh();
    expect(app.reports.getRaw(7, "all", { weeklyBudget: null, now })).toBeNull();
    expect(app.reports.live("all")).toEqual([]);

    const withData = fixtureApp();
    await withData.reports.refresh();
    const root2 = String(withData.env.CLAUDE_CONFIG_DIR);
    saveUsageReading(root2, now);
    const opts = { weeklyBudget: null, now };
    expect(withData.reports.getReport(7, "claude", opts)?.burns.claude?.weekBurndown).toBeNull();
    expect(
      withData.reports.getReport(7, "claude", { ...opts, planWeek: planWeek(root2, now) })
        ?.burns.claude?.weekBurndown,
    ).not.toBeNull();
  });

  it("counts the leak the fixture plants, from both agents", async () => {
    const app = fixtureApp();
    await app.reports.refresh();
    const report = app.reports.getReport(7, "all", { weeklyBudget: null, now })!;
    expect(report.issues.map((i) => i.title)).toContain("Sessions compact too late");
    expect(Object.keys(report.burns).sort()).toEqual(["claude", "codex"]);
    expect(report.turns).toBeGreaterThan(300);
  });
});

const UUID = "01a127e3-70f6-7dd3-9dfb-7504ffeb687d";

/** A codex-only fixture whose rollout filename carries a full UUID, plus an optional native index. */
function codexNativeApp(indexLines: string[] | null): { app: App; index: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tf-native-"));
  const rollout = join(root, "codex", "sessions", "2026", "10", "10", `rollout-2026-10-10T12-00-00-${UUID}.jsonl`);
  mkdirSync(dirname(rollout), { recursive: true });
  writeFileSync(rollout, [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/srv/api", id: UUID } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the thing" }] } }),
    JSON.stringify({ type: "event_msg", timestamp: new Date(now.getTime() - 5 * 60_000).toISOString(), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10 } } } }),
  ].join("\n") + "\n");
  const index = join(root, "codex", "session_index.jsonl");
  if (indexLines) writeFileSync(index, indexLines.join("\n") + "\n");
  const env = { ...harnessEnv(root, now), TOKEN_FURNACE_NOW: now.toISOString(), TOKEN_FURNACE_NO_CACHE: "1" };
  return { app: compose(env), index };
}

describe("native Codex session names", () => {
  it("prefers a native thread name keyed by the full rollout UUID", async () => {
    const { app } = codexNativeApp([JSON.stringify({ id: UUID, thread_name: "Native planner" })]);
    await app.reports.refresh();
    const report = app.reports.getReport(7, "codex", { weeklyBudget: null, now })!;
    expect(report.active[0].title).toBe("Native planner");
    expect(report.topSessions[0].title).toBe("Native planner");
    expect(report.active[0].id).toBe("01a127e3");
  });

  it("falls back to the prompt when the native index is missing", async () => {
    const { app } = codexNativeApp(null);
    await app.reports.refresh();
    expect(app.reports.getReport(7, "codex", { weeklyBudget: null, now })!.active[0].title).toBe("fix the thing");
  });

  it("observes an append-only index rename without reparsing a transcript", async () => {
    const { app, index } = codexNativeApp([JSON.stringify({ id: UUID, thread_name: "First name" })]);
    const seen = parseLog(app);
    await app.reports.refresh();
    expect(seen).toHaveLength(1);
    expect(app.reports.getReport(7, "codex", { weeklyBudget: null, now })!.active[0].title).toBe("First name");
    appendFileSync(index, JSON.stringify({ id: UUID, thread_name: "Second name" }) + "\n");
    await app.reports.refresh();
    expect(seen).toHaveLength(1); // only the index changed, so no transcript is reparsed
    expect(app.reports.getReport(7, "codex", { weeklyBudget: null, now })!.active[0].title).toBe("Second name");
  });

  it("tolerates malformed lines and picks the latest nonempty name", async () => {
    const { app } = codexNativeApp([
      "not json",
      JSON.stringify({ id: UUID, thread_name: "Keep me" }),
      JSON.stringify({ id: UUID, thread_name: "" }),
    ]);
    await app.reports.refresh();
    expect(app.reports.getReport(7, "codex", { weeklyBudget: null, now })!.active[0].title).toBe("Keep me");
  });

  it("never applies a name for an unknown session that shares an eight-character prefix", async () => {
    const { app } = codexNativeApp([JSON.stringify({ id: "01a127e3-dead-beef-dead-beefdeadbeef", thread_name: "Wrong session" })]);
    await app.reports.refresh();
    expect(app.reports.getReport(7, "codex", { weeklyBudget: null, now })!.active[0].title).toBe("fix the thing");
  });
});

describe("per-install limit floors", () => {
  it("honors independent floors and the legacy default slot without sharing calibration", async () => {
    const { readFileSync, rmSync } = await import("node:fs");
    const { buildClaudeInstall } = await import("./fixtures/build");
    const home = mkdtempSync(join(realpathSync(tmpdir()), "tf-install-limits-"));
    buildClaudeInstall(home, ".claude", { now });
    buildClaudeInstall(home, ".cc-work", { now });
    const env = { HOME: home, XDG_CACHE_HOME: join(home, ".cache"), TOKEN_FURNACE_WORKERS: "0" };
    const app = compose(env);
    try {
      await app.reports.refresh();
      const path = join(env.XDG_CACHE_HOME, "token-furnace", "limits.json");
      const week = { start: new Date(now.getTime() - 4 * 86_400_000), resets: new Date(now.getTime() + 3 * 86_400_000), used: 50 };
      writeFileSync(path, JSON.stringify({ claude: 30_000, "claude:cc-work": 70_000 }));
      const report = app.reports.getReport(7, "all", { now, weeklyBudget: null,
        planWeeks: { claude: week, "claude:cc-work": { ...week, used: 100 } } })!;
      expect(report.burns.claude?.limit).toBe(30_000);
      expect(report.burns["claude:cc-work"]?.limit).toBe(70_000);
      expect(report.burns["claude:cc-work"]?.used).toBe(100);
      app.reports.getReport(7, "all", { now, weeklyBudget: null,
        planWeeks: { claude: { ...week, used: 1 }, "claude:cc-work": { ...week, used: 100 } } });
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved.claude).toBeGreaterThan(30_000);
      expect(saved["claude:cc-work"]).toBe(70_000);
      writeFileSync(path, JSON.stringify({ claude: 30_000 }));
      const legacy = app.reports.getReport(7, "all", { now, weeklyBudget: null,
        planWeeks: { claude: week, "claude:cc-work": week } })!;
      expect(legacy.burns.claude?.limit).toBe(30_000);
      expect(legacy.burns["claude:cc-work"]?.limit).toBeLessThan(30_000);
    } finally {
      (app.repo as { close?: () => void }).close?.();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

it.each(["claude", "codex"])("omits a legacy %s burn with no spend while keeping provider metadata", async (idle) => {
  const { rmSync } = await import("node:fs");
  const app = fixtureApp();
  try {
    await app.reports.refresh();
    for (const session of app.repo.all().filter((row) => row.source === idle)) app.repo.save({ ...session,
      turns: session.turns.map((turn) => ({ ...turn, when: new Date(now.getTime() - 10 * 86_400_000) })),
    }, 1);
    const active = idle === "claude" ? "codex" : "claude";
    const report = app.reports.getReport(1, "all", { now, weeklyBudget: null })!;
    expect(Object.keys(report.burns)).toEqual([active]);
    expect(report.burn).toEqual(report.burns[active]);
    expect(report.providers.map((provider) => provider.id).sort()).toEqual(["claude", "codex"]);
  } finally {
    (app.repo as { close?: () => void }).close?.();
    rmSync(app.env.HOME!, { recursive: true, force: true });
  }
});

it("does not treat a settings-only default Claude directory as a live source", async () => {
  const { rmSync } = await import("node:fs");
  const app = fixtureApp();
  try {
    rmSync(join(app.env.CLAUDE_CONFIG_DIR!, "projects"), { recursive: true });
    expect(app.reports.live("all")).toEqual(["codex"]);
    await app.reports.refresh();
    expect(app.reports.getReport(7, "claude", { now, weeklyBudget: null })).toBeNull();
  } finally {
    (app.repo as { close?: () => void }).close?.();
    rmSync(app.env.HOME!, { recursive: true, force: true });
  }
});
