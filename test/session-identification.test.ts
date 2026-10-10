import { describe, expect, it } from "vitest";
import { extractCodexTitle } from "../src/sources/agent-source";
import { buildReport } from "../src/core/analyze/report";
import type { ReportInput, SessionInput, Turn } from "../src/core/model";

describe("Session identification and actionability", () => {
  it("extracts human task fallback from Codex prompts and skips boilerplate", () => {
    expect(extractCodexTitle("")).toBeNull();
    expect(extractCodexTitle("<permissions instructions>\nsandbox\n</permissions instructions>")).toBeNull();
    expect(extractCodexTitle("# AGENTS.md instructions for repo\n\n<INSTRUCTIONS>\nhello\n</INSTRUCTIONS>")).toBeNull();
    expect(extractCodexTitle("Base directory for this skill: /foo")).toBeNull();
    expect(extractCodexTitle("This session is being continued from previous")).toBeNull();
    
    const task = "Fix the authentication token expiration bug in auth.ts";
    expect(extractCodexTitle(task)).toBe(task);

    const multiline = "\n\n  \n# Heading to ignore\n\nFix memory leak in report generation\nMore details here";
    expect(extractCodexTitle(multiline)).toBe("Fix memory leak in report generation");
  });

  it("buildReport populates fullId and preserves short id for active and top sessions", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    const turn1: Turn = {
      source: "codex",
      project: "token-furnace",
      session: "01a127e3-70f6-7dd3-9dfb-7504ffeb687d",
      model: "gpt-5.5",
      when: new Date("2026-10-10T11:50:00Z"),
      baseIn: 1000,
      cacheRead: 500,
      cacheWrite: 0,
      output: 100,
      tools: [],
      reads: 0,
      wakes: ["human"],
    };

    const session: SessionInput = {
      source: "codex",
      path: "/sessions/rollout.jsonl",
      mtimeMs: now.getTime(),
      title: "Inspect quota leaks",
      turns: [turn1],
    };

    const input: ReportInput = {
      now,
      days: 7,
      weeklyBudget: null,
      live: ["codex"],
      sessions: [session],
      config: {
        claudeBase: "",
        claudeHome: "",
        settings: null,
        codexConfig: null,
        memoryIndexes: [],
        env: {},
      },
      planWeek: null,
      codexWeek: null,
    };

    const report = buildReport(input);
    expect(report).not.toBeNull();
    expect(report?.active).toHaveLength(1);
    const active = report!.active[0];
    expect(active.id).toBe("01a127e3");
    expect(active.fullId).toBe("01a127e3-70f6-7dd3-9dfb-7504ffeb687d");
    expect(active.title).toBe("Inspect quota leaks");

    expect(report?.sessions).toHaveLength(1);
    const top = report!.sessions[0];
    expect(top.id).toBe("01a127e3");
    expect(top.fullId).toBe("01a127e3-70f6-7dd3-9dfb-7504ffeb687d");
  });
});
