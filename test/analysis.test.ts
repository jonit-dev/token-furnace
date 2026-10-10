/**
 * The port of scripts/test_burn.py: every assert in that file has a matching assert here, so the
 * checks survive the deletion of the Python in PRD-003.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { severity } from "../src/core/analyze/baseline";
import {
  claudeSubagentCap,
  codexSubagentCap,
  configChecks,
  configNotes,
} from "../src/core/analyze/config-checks";
import type { ConfigInput, Report } from "../src/core/model";
import { CodexSource } from "../src/sources/codex";
import { assistant, buildCodexWeek, user } from "./fixtures/build";
import { fixedNow, harnessEnv, readConfig, tsReport } from "./harness";

const HOUR = 3_600_000;
const MINUTE = 60_000;

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tf-analysis-"));
}

function write(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n");
}

describe("check_severity", () => {
  it("is ok up to the target and warn up to twice it", () => {
    expect([0.9, 1.0, 1.5, 2.0, 3].map(severity)).toEqual(["ok", "ok", "warn", "warn", "critical"]);
  });
});

describe("check_last_24h", () => {
  /** An old peak-900k session must not flag or fail the checks once a recent one is healthy. */
  it("judges the last 24 h, not the whole window", () => {
    const root = tempRoot();
    const now = fixedNow();
    for (const [name, age, context] of [
      ["old", 3 * 24 * HOUR, 900_000],
      ["new", 2 * HOUR, 100_000],
    ] as [string, number, number][]) {
      // The recent session writes cache every turn and jumps 100k once (a pasted dump).
      const lines = [user(new Date(now.getTime() - age), "go")];
      for (let i = 0; i < 20; i++) {
        lines.push(
          assistant(
            new Date(now.getTime() - age + i * MINUTE),
            context + (name === "new" && i >= 10 ? 100_000 : 0),
            [],
            name === "new" ? 20_000 : 0,
          ),
        );
      }
      write(join(root, "projects", "demo", `${name}-session.jsonl`), lines);
    }
    const report: Report = tsReport(harnessEnv(root, now), now, 7, null, "claude")!;
    expect(report.issues.some((i) => i.title.includes("compact too late"))).toBe(false);

    const by = Object.fromEntries(report.baseline.map((row) => [row.name, row]));
    expect(by["Spend on turns over 300k"].ok).toBe(true);
    expect(by["Spend on turns over 300k"].now_24h).toBe("0%");
    expect(by["Spend on turns over 300k"].value_7d).not.toBe("0%");
    expect(by["Cache rebuilds"].level).toBe("warn"); // ~14% against 10%
    const top = by["Spend on the top model"]; // advisory: opus only, so never worse than info
    expect([top.advisory, top.level, top.ok]).toEqual([true, "info", false]);
  });
});

describe("check_config_notes", () => {
  /** Config readers pull from Claude settings/.env and Codex config.toml, judged per agent. */
  let config: ConfigInput;

  const put = (settings: string) => {
    writeFileSync(join(tempRootSettings(), "settings.json"), settings);
    config = { ...config, settings };
  };

  let root = "";
  const tempRootSettings = () => root;

  beforeEach(() => {
    root = tempRoot();
    config = {
      claudeBase: root,
      claudeHome: root,
      settings: null,
      codexConfig: null,
      memoryIndexes: [],
      env: {},
    };
  });

  it("reads the subagent cap from settings.json .env, then the process env", () => {
    put("{}");
    expect(claudeSubagentCap(config)).toEqual([null, null]);
    put(JSON.stringify({ env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "3" } }));
    expect(claudeSubagentCap(config)).toEqual([3, "settings"]);
    put(JSON.stringify({ env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "20" } })); // over the cap
    const notes = Object.fromEntries(configNotes(["claude"], config).map((n) => [n.name, n]));
    expect(notes["Max concurrent subagents"].value).toBe("20");
    expect(notes["Max concurrent subagents"].ok).toBe(false);
    expect(notes["Subagent model"].ok).toBe(false); // unset
    expect(configNotes(["claude"], config).every((n) => n.source === "claude")).toBe(true);
  });

  it("reads Codex config.toml, under [agents] or as a dotted key", () => {
    for (const [text, want] of [
      ["[agents]\nmax_concurrent_threads_per_session = 5", 5],
      ["agents.max_concurrent_threads_per_session = 2", 2],
    ] as [string, number][]) {
      writeFileSync(join(root, "config.toml"), text);
      config = { ...config, codexConfig: text };
      expect(codexSubagentCap(config)[0]).toBe(want);
    }
    const text =
      "[agents]\nmax_concurrent_threads_per_session = 3\nmax_depth = 1\n" +
      'default_subagent_reasoning_effort = "low"\n' +
      "model_auto_compact_token_limit = 160000";
    writeFileSync(join(root, "config.toml"), text);
    config = { ...config, codexConfig: text };
    const codex = Object.fromEntries(configNotes(["codex"], config).map((n) => [n.name, n]));
    expect(configNotes(["codex"], config).every((n) => n.source === "codex")).toBe(true);
    expect(codex["Max concurrent subagents"].value).toBe("3");
    expect(codex["Max concurrent subagents"].ok).toBe(true);
    expect(codex["Agent nesting depth"].ok).toBe(true);
    expect(codex["Subagent reasoning effort"].ok).toBe(true);
    expect(codex["Auto-compact token limit"].ok).toBe(true);
  });
});

describe("check_weekly_quota", () => {
  /** With a weekly reading: %/h matches tokens/h, and the weekly burndown ends at the reading. */
  it("calibrates the week and projects one run-out", () => {
    const root = tempRoot();
    const now = fixedNow();
    write(
      join(root, "token-furnace", "usage.json"),
      [JSON.stringify({
        fetched: now.getTime() / 1000,
        seven_day: { utilization: 40, resets_at: now.getTime() / 1000 + 3 * 86_400 },
      })],
    );
    const whens = [
      ...Array.from({ length: 150 }, (_, i) => new Date(now.getTime() - 30 * HOUR + i * 10 * MINUTE)),
      ...Array.from({ length: 5 }, (_, i) => new Date(now.getTime() - (30 - 5 * i) * MINUTE)),
    ];
    write(
      join(root, "projects", "demo", "s-week.jsonl"),
      whens.map((when) => assistant(when, 200_000)),
    );

    const report = tsReport(harnessEnv(root, now), now, 7, null, "claude")!;
    const burn = report.burns.claude!;
    expect(burn.rate).toBeGreaterThan(0);
    expect(Math.abs((burn.ratePct! * burn.limit!) / 100 - burn.rate)).toBeLessThan(1e-6 * burn.rate);
    const points = burn.weekBurndown!;
    expect(Math.abs(points[points.length - 1][1] - burn.used!)).toBeLessThan(0.5);
    expect(points[0][1]).toBe(0);
    for (let i = 1; i < points.length; i++) {
      expect(points[i][1]).toBeGreaterThanOrEqual(points[i - 1][1]);
      expect(points[i][0] >= points[i - 1][0]).toBe(true);
    }
    expect(points[points.length - 1][2]).toBeLessThanOrEqual(points[points.length - 1][1]);
    const proj = burn.projection!;
    expect(proj.ratePct).toBeGreaterThan(0);
    // One run-out for tile and chart: points left at the 24 h pace.
    expect(Math.abs(proj.hoursToEmpty! * proj.ratePct - (100 - burn.used!))).toBeLessThan(1e-6);
  });
});

describe("check_codex_week", () => {
  /** Codex's weekly window comes from the rate_limits it logs; a finished week is ignored. */
  it("returns the live reading and drops a finished one", () => {
    const home = join(tempRoot(), "codex");
    const now = fixedNow();
    const source = new CodexSource({ CODEX_HOME: home });
    const epoch = now.getTime() / 1000;
    buildCodexWeek(home, 40, epoch + 3_600);
    expect(source.week(now)?.used).toBe(40);
    buildCodexWeek(home, 40, epoch - 3_600);
    expect(source.week(now)).toBeNull();
  });
});

describe("main", () => {
  const now = fixedNow();
  const root = tempRoot();
  const env = () => harnessEnv(root, now);
  const report = () => tsReport(env(), now, 2, null, "claude")!;

  it("finds every leak and config problem, and names the agent for each", () => {
    write(join(root, "projects", "demo", "memory", "MEMORY.md"), Array.from({ length: 250 }, () => "- line"));
    const lines = [user(new Date(now.getTime() - 13 * HOUR), "fix the bug")];
    for (let i = 0; i < 300; i++) {
      const when = new Date(now.getTime() - 13 * HOUR + i * 150_000);
      if (i % 5 === 0) lines.push(user(when, "<task-notification>done</task-notification>"));
      lines.push(assistant(when, 400_000, [["Bash", "cd /x && sed -n 1,9p f"]]));
    }
    write(join(root, "projects", "demo", "aaaaaaaa-leak.jsonl"), lines);

    const data = report();
    const text = [...data.config, ...data.topSessions.flatMap((s) => s.flags)].join("\n");
    for (const expected of [
      "late compaction: peak 400k",
      "caller reads: 300",
      "wakeups: 60 (teammate 0, task 60",
      "loop: 300 turns for 1 human",
      "long-lived: 12h",
      "autoCompactWindow is unset",
      "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset",
      "has 250 lines",
    ]) {
      expect(text, `missing ${expected}`).toContain(expected);
    }
    expect(data.issues).toHaveLength(11); // the count test_burn.py's doctor assert expects
    expect(JSON.stringify(data)).toContain("caller reads: 300");
    expect(data.issues.some((i) => i.title.includes("compact too late"))).toBe(true);
    expect(data.issues.every((i) => i.priority >= 1 && i.priority <= 3)).toBe(true);
    expect(data.issues.map((i) => i.priority)).toEqual(
      [...data.issues].map((i) => i.priority).sort((a, b) => a - b),
    );
    expect(data.issues.some((i) => i.prompt.includes("transcript: "))).toBe(true);
    // Every issue and check names its agent, and the fix prompt carries the extra context.
    expect(data.issues.every((i) => ["claude", "codex", "all"].includes(i.source ?? ""))).toBe(true);
    expect(data.baseline.every((b) => Boolean(b.source))).toBe(true);
    const sub = data.issues.find((i) => i.title === "Config: subagent fan-out cap")!;
    expect(sub.source).toBe("claude");
    expect(sub.prompt).toContain("Applies to: Claude Code.");
    expect(sub.prompt).toContain("Additional info:");
    expect(sub.prompt).toContain("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH");
    expect(data.burn!.basis).toContain("2-day average");
    expect(Array.isArray(data.active)).toBe(true);
    expect(data.burndown.length).toBeGreaterThan(0);
    expect(data.kpis.length).toBeGreaterThan(0);
    expect(data.timeline.length).toBeGreaterThan(0);
    expect(data.baseline.length).toBeGreaterThan(0);
  });

  it("reports a pinned compaction window from settings, and one from the env", () => {
    expect(report().config).toContain(
      'autoCompactWindow is unset: compaction waits for the model window (about 1M on 1M models). Set "autoCompactWindow": 200000.',
    );
    writeFileSync(join(root, "settings.json"), JSON.stringify({ autoCompactWindow: 200000 }));
    expect(report().config).toContain("autoCompactWindow is 200k (from settings): ok.");

    const over = env();
    over.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "800k";
    expect(configChecks(["claude"], readConfig(over))).toContain(
      "autoCompactWindow is 800k (from env): too high. Use about 200k.",
    );
  });
});