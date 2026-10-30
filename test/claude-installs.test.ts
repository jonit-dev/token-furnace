import { spawn } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compose } from "../src/compose";
import type { Report } from "../src/core/model";
import { startServer } from "../src/server";
import { planWeek } from "../src/services/usage-client";
import { buildClaudeInstall, saveUsageReading } from "./fixtures/build";

const NOW = new Date("2026-10-30T20:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function baselineEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: join(home, ".codex"),
    TOKEN_FURNACE_NOW: NOW.toISOString(),
    TOKEN_FURNACE_WORKERS: "0",
  };
}

function stable(value: unknown, home: string): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll(`/private${home}`, "$HOME").replaceAll(home, "$HOME"));
}

function reportSnapshot(report: Report | null, home: string): unknown {
  if (!report) return null;
  const copy = stable(report, home) as Record<string, unknown>;
  delete copy.providers;
  return copy;
}

function getReport(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/report", headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("single Claude install baseline", () => {
  it("keeps the report, cache rows, limits, usage and API payload stable", async () => {
    const home = mkdtempSync(join(tmpdir(), "tf-claude-baseline-"));
    roots.push(home);
    const install = buildClaudeInstall(home, ".claude", { now: NOW });
    const env = baselineEnv(home);
    saveUsageReading(env.XDG_CACHE_HOME!, NOW);
    const app = compose(env);
    await app.reports.refresh();
    const plan = await planWeek(app.env, NOW, false);
    const report = app.reports.getReport(7, "claude", { weeklyBudget: null, planWeek: plan, now: NOW });
    const server = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
    try {
      const api = await getReport(server.port);
      expect(api.status).toBe(200);
      const limitsPath = join(env.XDG_CACHE_HOME!, "token-furnace", "limits.json");
      const baseline = {
        report: reportSnapshot(report, home),
        api: reportSnapshot(JSON.parse(api.body) as Report, home),
        cache: app.repo.all().map(({ source, path, title, turns }) => ({
          source,
          path: path.replace(`/private${home}`, "$HOME").replace(home, "$HOME"),
          title,
          turns: stable(turns, home),
        })),
        limits: existsSync(limitsPath) ? readFileSync(limitsPath, "utf8") : null,
        usage: readFileSync(join(env.XDG_CACHE_HOME!, "token-furnace", "usage.json"), "utf8"),
        install: install.dir.replace(`/private${home}`, "$HOME").replace(home, "$HOME"),
      };

      expect(baseline).toMatchInlineSnapshot(`
        {
          "api": {
            "actions": [
              "Burn spike in “hello” (Claude Code): 10260 tokens/h, above twice the ideal pace. Pause or finish this session.",
            ],
            "active": [
              {
                "agents": {
                  "activeCount": 1,
                  "complete": true,
                  "members": [
                    {
                      "active": true,
                      "id": "session",
                      "lastSeen": "2026-10-30T20:00:00.000Z",
                      "model": "claude-opus-5-5",
                      "parentId": null,
                      "role": "parent",
                    },
                  ],
                },
                "context": 100010,
                "flags": [],
                "fullId": "session",
                "hours": 0,
                "id": "session",
                "idle": 0,
                "lastTurn": 10260,
                "model": "claude-opus-5-5",
                "path": "$HOME/.claude/projects/demo/session.jsonl",
                "peak": 100010,
                "project": "demo",
                "rate": 10260,
                "rateShare": 100,
                "share": 100,
                "source": "claude",
                "title": "hello",
                "turns": 1,
              },
            ],
            "agentActivity": {
              "peak7d": 1,
              "peakLifetime": 1,
              "timeline": [
                [
                  "2026-10-29T20:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T20:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T21:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T21:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T22:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T22:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T23:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T23:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T00:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T00:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T01:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T01:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T02:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T02:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T03:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T03:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T04:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T04:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T05:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T05:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T06:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T06:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T07:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T07:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T08:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T08:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T09:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T09:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T10:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T10:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T11:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T11:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T12:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T12:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T13:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T13:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T14:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T14:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T15:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T15:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T16:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T16:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T17:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T17:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T18:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T18:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T19:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T19:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T20:00:00.000Z",
                  1,
                ],
              ],
            },
            "baseline": [
              {
                "advisory": false,
                "level": "ok",
                "name": "Spend on turns over 400k",
                "now_24h": "0%",
                "ok": true,
                "ratio": 0,
                "source": "claude",
                "target": "under 10%",
                "value_7d": "0%",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Median context per turn",
                "now_24h": "100k",
                "ok": true,
                "ratio": 0.250025,
                "source": "claude",
                "target": "at most 400k",
                "value_7d": "100k",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Turns per human prompt",
                "now_24h": "1",
                "ok": true,
                "ratio": 0.02,
                "source": "claude",
                "target": "under 50",
                "value_7d": "1",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Caller reads per tool call",
                "now_24h": "-",
                "ok": true,
                "ratio": null,
                "source": "claude",
                "target": "under 20%",
                "value_7d": "0%",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Wakeups per session",
                "now_24h": "0",
                "ok": true,
                "ratio": 0,
                "source": "claude",
                "target": "under 20",
                "value_7d": "0",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Longest top session",
                "now_24h": "-",
                "ok": true,
                "ratio": null,
                "source": "claude",
                "target": "under 12h",
                "value_7d": "0h",
              },
              {
                "advisory": true,
                "level": "info",
                "name": "Spend on the top model",
                "now_24h": "100%",
                "ok": false,
                "ratio": 1.6666666666666667,
                "source": "claude",
                "target": "under 60%",
                "value_7d": "100%",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Cache rebuilds",
                "now_24h": "0%",
                "ok": true,
                "ratio": 0,
                "source": "claude",
                "target": "under 10%",
                "value_7d": "0%",
              },
              {
                "advisory": false,
                "level": "critical",
                "name": "Preamble per session (p50)",
                "now_24h": "100k",
                "ok": false,
                "ratio": 2.50025,
                "source": "claude",
                "target": "under 40k",
                "value_7d": "100k",
              },
              {
                "advisory": false,
                "level": "warn",
                "name": "autoCompactWindow",
                "now_24h": "unset (model max)",
                "ok": false,
                "ratio": null,
                "source": "claude",
                "target": "400k",
                "value_7d": null,
              },
              {
                "advisory": false,
                "level": "warn",
                "name": "Max concurrent subagents",
                "now_24h": "unset",
                "ok": false,
                "ratio": null,
                "source": "claude",
                "target": "at most 3",
                "value_7d": null,
              },
              {
                "advisory": false,
                "level": "warn",
                "name": "Subagent spawn depth",
                "now_24h": "unset",
                "ok": false,
                "ratio": null,
                "source": "claude",
                "target": "at most 1",
                "value_7d": null,
              },
              {
                "advisory": false,
                "level": "warn",
                "name": "Subagent model",
                "now_24h": "unset",
                "ok": false,
                "ratio": null,
                "source": "claude",
                "target": "pinned",
                "value_7d": null,
              },
              {
                "advisory": false,
                "level": "warn",
                "name": "Tool-call concurrency",
                "now_24h": "unset",
                "ok": false,
                "ratio": null,
                "source": "claude",
                "target": "at most 4",
                "value_7d": null,
              },
            ],
            "buckets": [
              {
                "aboveTargetShare": 0,
                "label": "100-200k",
                "share": 100,
                "turns": 1,
              },
            ],
            "budget": null,
            "burn": {
              "basis": "ideal pace to the weekly reset Mon 12:00 (72 h left)",
              "gains": {
                "1": 40,
                "24": 40,
                "6": 40,
              },
              "goal": 213.75,
              "hoursLeft": 72,
              "idealPct": 0.8333333333333334,
              "limit": 25650,
              "pending": null,
              "projection": {
                "hoursToEmpty": 36,
                "ratePct": 1.6666666666666667,
                "runsOut": "2026-11-01T08:00:00+00:00",
              },
              "rate": 10260,
              "ratePct": 40,
              "resets": "2026-11-02T20:00:00+00:00",
              "start": "2026-10-26T20:00:00+00:00",
              "used": 40,
              "weekBurndown": [
                [
                  "2026-10-26T20:00:00+00:00",
                  0,
                  0,
                ],
                [
                  "2026-10-30T20:00:00+00:00",
                  40,
                  40,
                ],
              ],
            },
            "burndown": [
              [
                "2026-10-30T21:00:00+00:00",
                10260,
                10260,
              ],
            ],
            "burns": {
              "claude": {
                "basis": "ideal pace to the weekly reset Mon 12:00 (72 h left)",
                "gains": {
                  "1": 40,
                  "24": 40,
                  "6": 40,
                },
                "goal": 213.75,
                "hoursLeft": 72,
                "idealPct": 0.8333333333333334,
                "limit": 25650,
                "pending": null,
                "projection": {
                  "hoursToEmpty": 36,
                  "ratePct": 1.6666666666666667,
                  "runsOut": "2026-11-01T08:00:00+00:00",
                },
                "rate": 10260,
                "ratePct": 40,
                "resets": "2026-11-02T20:00:00+00:00",
                "start": "2026-10-26T20:00:00+00:00",
                "used": 40,
                "weekBurndown": [
                  [
                    "2026-10-26T20:00:00+00:00",
                    0,
                    0,
                  ],
                  [
                    "2026-10-30T20:00:00+00:00",
                    40,
                    40,
                  ],
                ],
              },
            },
            "checkHours": 24,
            "config": [
              "autoCompactWindow is unset: compaction waits for the model window (about 1M on 1M models). Set "autoCompactWindow": 400000.",
              "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset: set it to at most 3.",
              "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH is unset: set it to at most 1.",
              "CLAUDE_CODE_SUBAGENT_MODEL is unset: subagents inherit the main model; pin a cheap worker (e.g. CLAUDE_CODE_SUBAGENT_MODEL=sonnet).",
              "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY is unset: set it to at most 4.",
            ],
            "contextTargets": {
              "claude": 400000,
              "codex": 300000,
              "opencode": 128000,
            },
            "days": 7,
            "generated": "2026-10-30T20:00:00+00:00",
            "issues": [
              {
                "fix": "autoCompactWindow is unset: compaction waits for the model window (about 1M on 1M models). Set "autoCompactWindow": 400000.",
                "level": "critical",
                "priority": 1,
                "prompt": "Token leak to fix: Config: autoCompactWindow.
        Applies to: Claude Code.

        Why it costs tokens: autoCompactWindow is unset: compaction waits for the model window (about 1M on 1M models). Set "autoCompactWindow": 400000.

        What to do: Fix this config problem: autoCompactWindow is unset: compaction waits for the model window (about 1M on 1M models). Set "autoCompactWindow": 400000.

        Report what you changed and how to check that it worked.",
                "sessions": 0,
                "share": null,
                "source": "claude",
                "title": "Config: autoCompactWindow",
              },
              {
                "fix": "Cap concurrent subagents at 3: each one runs its own model and tool loop.",
                "level": "warn",
                "priority": 2,
                "prompt": "Token leak to fix: Config: subagent fan-out cap.
        Applies to: Claude Code.

        Why it costs tokens: CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset: set it to at most 3.

        Additional info:
        - Claude Code defaults to 20 concurrent subagents and nesting depth 3, with no total cap.
        - Also set the depth cap: \`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1\` (Codex: \`agents.max_depth\`; note Multi-Agent V2 ignores it).
        - Pin the worker model so it is not inherited silently: \`CLAUDE_CODE_SUBAGENT_MODEL=sonnet\` (add \`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1\` to hard-enforce).
        - Codex: prefer \`fork_turns="none"\` for independent workers so they do not inherit the parent conversation history.

        What to do: Fix this config problem: CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset: set it to at most 3.

        Report what you changed and how to check that it worked.",
                "sessions": 0,
                "share": null,
                "source": "claude",
                "title": "Config: subagent fan-out cap",
              },
              {
                "fix": "Cap subagent nesting depth at 1: recursive delegation multiplies the loop.",
                "level": "warn",
                "priority": 2,
                "prompt": "Token leak to fix: Config: subagent nesting depth.
        Applies to: Claude Code.

        Why it costs tokens: CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH is unset: set it to at most 1.

        Additional info:
        - Nesting is the worst fan-out: a worker that spawns workers multiplies the whole loop.
        - Claude: \`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1\`. Codex: \`agents.max_depth\` (Multi-Agent V2 ignores it, so verify the effective depth from real traces).

        What to do: Fix this config problem: CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH is unset: set it to at most 1.

        Report what you changed and how to check that it worked.",
                "sessions": 0,
                "share": null,
                "source": "claude",
                "title": "Config: subagent nesting depth",
              },
              {
                "fix": "Pin a cheap worker model so subagents do not inherit a premium one.",
                "level": "warn",
                "priority": 2,
                "prompt": "Token leak to fix: Config: subagent model.
        Applies to: Claude Code.

        Why it costs tokens: CLAUDE_CODE_SUBAGENT_MODEL is unset: subagents inherit the main model; pin a cheap worker (e.g. CLAUDE_CODE_SUBAGENT_MODEL=sonnet).

        Additional info:
        - \`CLAUDE_CODE_SUBAGENT_MODEL=sonnet\` is a default, not a guarantee; add \`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1\` to hard-enforce (it overrides intentional per-agent specialization).
        - Codex: set \`agents.default_subagent_model\` explicitly; V2 can silently run a costlier worker than requested.
        - Verify the effective model from real usage, not from the instruction.

        What to do: Fix this config problem: CLAUDE_CODE_SUBAGENT_MODEL is unset: subagents inherit the main model; pin a cheap worker (e.g. CLAUDE_CODE_SUBAGENT_MODEL=sonnet).

        Report what you changed and how to check that it worked.",
                "sessions": 0,
                "share": null,
                "source": "claude",
                "title": "Config: subagent model",
              },
              {
                "fix": "Cap parallel tool calls at 4.",
                "level": "warn",
                "priority": 2,
                "prompt": "Token leak to fix: Config: tool-call concurrency.
        Applies to: Claude Code.

        Why it costs tokens: CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY is unset: set it to at most 4.

        Additional info:
        - \`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=4\` bounds parallel tool calls in the main agent.
        - Limit shell output at the byte level; a line-count cap fails when one line is huge.

        What to do: Fix this config problem: CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY is unset: set it to at most 4.

        Report what you changed and how to check that it worked.",
                "sessions": 0,
                "share": null,
                "source": "claude",
                "title": "Config: tool-call concurrency",
              },
            ],
            "kpis": [
              {
                "name": "Claude Code median context per turn",
                "target": 400000,
                "unit": "k",
                "values": [
                  100010,
                ],
              },
              {
                "name": "Turns over provider context target",
                "target": 0.1,
                "unit": "%",
                "values": [
                  0,
                ],
              },
              {
                "name": "Caller reads per tool call",
                "target": 0.2,
                "unit": "%",
                "values": [
                  0,
                ],
              },
            ],
            "overTarget": 0,
            "projectCount": 1,
            "projects": [
              [
                "demo",
                100,
              ],
            ],
            "sessions": 1,
            "timeline": [
              [
                "2026-10-30T20:00:00+00:00",
                10260,
                0,
              ],
            ],
            "timelines": {
              "claude": [
                [
                  "2026-10-30T20:00:00+00:00",
                  10260,
                  0,
                ],
              ],
            },
            "toolCalls": 0,
            "tools": [],
            "topSessions": [
              {
                "flags": [],
                "fullId": "session",
                "hours": 0,
                "id": "session",
                "path": "$HOME/.claude/projects/demo/session.jsonl",
                "peak": 100010,
                "project": "demo",
                "share": 100,
                "source": "claude",
                "title": "hello",
                "turns": 1,
              },
            ],
            "total": 10260,
            "turns": 1,
            "unpriced": null,
          },
          "cache": [
            {
              "path": "$HOME/.claude/projects/demo/session.jsonl",
              "source": "claude",
              "title": "hello",
              "turns": [
                {
                  "baseIn": 10,
                  "cacheRead": 100000,
                  "cacheWrite": 0,
                  "model": "claude-opus-5-5",
                  "output": 50,
                  "project": "demo",
                  "reads": 0,
                  "session": "session",
                  "source": "claude",
                  "tools": [],
                  "wakes": [
                    "human",
                  ],
                  "when": "2026-10-30T20:00:00.000Z",
                },
              ],
            },
          ],
          "install": "$HOME/.claude",
          "limits": "{"claude":25650}",
          "report": {
            "actions": [
              "Burn spike in “hello” (Claude Code): 10260 tokens/h, above twice the ideal pace. Pause or finish this session.",
            ],
            "active": [
              {
                "agents": {
                  "activeCount": 1,
                  "complete": true,
                  "members": [
                    {
                      "active": true,
                      "id": "session",
                      "lastSeen": "2026-10-30T20:00:00.000Z",
                      "model": "claude-opus-5-5",
                      "parentId": null,
                      "role": "parent",
                    },
                  ],
                },
                "context": 100010,
                "flags": [],
                "fullId": "session",
                "hours": 0,
                "id": "session",
                "idle": 0,
                "lastTurn": 10260,
                "model": "claude-opus-5-5",
                "path": "$HOME/.claude/projects/demo/session.jsonl",
                "peak": 100010,
                "project": "demo",
                "rate": 10260,
                "rateShare": 100,
                "share": 100,
                "source": "claude",
                "title": "hello",
                "turns": 1,
              },
            ],
            "agentActivity": {
              "peak7d": 1,
              "peakLifetime": 1,
              "timeline": [
                [
                  "2026-10-29T20:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T20:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T21:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T21:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T22:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T22:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T23:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-29T23:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T00:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T00:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T01:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T01:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T02:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T02:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T03:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T03:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T04:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T04:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T05:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T05:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T06:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T06:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T07:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T07:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T08:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T08:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T09:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T09:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T10:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T10:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T11:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T11:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T12:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T12:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T13:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T13:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T14:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T14:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T15:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T15:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T16:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T16:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T17:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T17:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T18:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T18:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T19:00:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T19:30:00.000Z",
                  0,
                ],
                [
                  "2026-10-30T20:00:00.000Z",
                  1,
                ],
              ],
            },
            "baseline": [
              {
                "advisory": false,
                "level": "ok",
                "name": "Spend on turns over 400k",
                "now_24h": "0%",
                "ok": true,
                "ratio": 0,
                "source": "claude",
                "target": "under 10%",
                "value_7d": "0%",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Median context per turn",
                "now_24h": "100k",
                "ok": true,
                "ratio": 0.250025,
                "source": "claude",
                "target": "at most 400k",
                "value_7d": "100k",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Turns per human prompt",
                "now_24h": "1",
                "ok": true,
                "ratio": 0.02,
                "source": "claude",
                "target": "under 50",
                "value_7d": "1",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Caller reads per tool call",
                "now_24h": "-",
                "ok": true,
                "ratio": null,
                "source": "claude",
                "target": "under 20%",
                "value_7d": "0%",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Wakeups per session",
                "now_24h": "0",
                "ok": true,
                "ratio": 0,
                "source": "claude",
                "target": "under 20",
                "value_7d": "0",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Longest top session",
                "now_24h": "-",
                "ok": true,
                "ratio": null,
                "source": "claude",
                "target": "under 12h",
                "value_7d": "0h",
              },
              {
                "advisory": true,
                "level": "info",
                "name": "Spend on the top model",
                "now_24h": "100%",
                "ok": false,
                "ratio": 1.6666666666666667,
                "source": "claude",
                "target": "under 60%",
                "value_7d": "100%",
              },
              {
                "advisory": false,
                "level": "ok",
                "name": "Cache rebuilds",
                "now_24h": "0%",
                "ok": true,
                "ratio": 0,
                "source": "claude",
                "target": "under 10%",
                "value_7d": "0%",
              },
              {
                "advisory": false,
                "level": "critical",
                "name": "Preamble per session (p50)",
                "now_24h": "100k",
                "ok": false,
                "ratio": 2.50025,
                "source": "claude",
                "target": "under 40k",
                "value_7d": "100k",
              },
              {
                "advisory": false,
                "level": "warn",
                "name": "autoCompactWindow",
                "now_24h": "unset (model max)",
                "ok": false,
                "ratio": null,
                "source": "claude",
                "target": "400k",
                "value_7d": null,
              },
              {
                "advisory": false,
                "level": "warn",
                "name": "Max concurrent subagents",
                "now_24h": "unset",
                "ok": false,
                "ratio": null,
                "source": "claude",
                "target": "at most 3",
                "value_7d": null,
              },
              {
                "advisory": false,
                "level": "warn",
                "name": "Subagent spawn depth",
                "now_24h": "unset",
                "ok": false,
                "ratio": null,
                "source": "claude",
                "target": "at most 1",
                "value_7d": null,
              },
              {
                "advisory": false,
                "level": "warn",
                "name": "Subagent model",
                "now_24h": "unset",
                "ok": false,
                "ratio": null,
                "source": "claude",
                "target": "pinned",
                "value_7d": null,
              },
              {
                "advisory": false,
                "level": "warn",
                "name": "Tool-call concurrency",
                "now_24h": "unset",
                "ok": false,
                "ratio": null,
                "source": "claude",
                "target": "at most 4",
                "value_7d": null,
              },
            ],
            "buckets": [
              {
                "aboveTargetShare": 0,
                "label": "100-200k",
                "share": 100,
                "turns": 1,
              },
            ],
            "budget": null,
            "burn": {
              "basis": "ideal pace to the weekly reset Mon 12:00 (72 h left)",
              "gains": {
                "1": 40,
                "24": 40,
                "6": 40,
              },
              "goal": 213.75,
              "hoursLeft": 72,
              "idealPct": 0.8333333333333334,
              "limit": 25650,
              "pending": null,
              "projection": {
                "hoursToEmpty": 36,
                "ratePct": 1.6666666666666667,
                "runsOut": "2026-11-01T08:00:00+00:00",
              },
              "rate": 10260,
              "ratePct": 40,
              "resets": "2026-11-02T20:00:00+00:00",
              "start": "2026-10-26T20:00:00+00:00",
              "used": 40,
              "weekBurndown": [
                [
                  "2026-10-26T20:00:00+00:00",
                  0,
                  0,
                ],
                [
                  "2026-10-30T20:00:00+00:00",
                  40,
                  40,
                ],
              ],
            },
            "burndown": [
              [
                "2026-10-30T21:00:00+00:00",
                10260,
                10260,
              ],
            ],
            "burns": {
              "claude": {
                "basis": "ideal pace to the weekly reset Mon 12:00 (72 h left)",
                "gains": {
                  "1": 40,
                  "24": 40,
                  "6": 40,
                },
                "goal": 213.75,
                "hoursLeft": 72,
                "idealPct": 0.8333333333333334,
                "limit": 25650,
                "pending": null,
                "projection": {
                  "hoursToEmpty": 36,
                  "ratePct": 1.6666666666666667,
                  "runsOut": "2026-11-01T08:00:00+00:00",
                },
                "rate": 10260,
                "ratePct": 40,
                "resets": "2026-11-02T20:00:00+00:00",
                "start": "2026-10-26T20:00:00+00:00",
                "used": 40,
                "weekBurndown": [
                  [
                    "2026-10-26T20:00:00+00:00",
                    0,
                    0,
                  ],
                  [
                    "2026-10-30T20:00:00+00:00",
                    40,
                    40,
                  ],
                ],
              },
            },
            "checkHours": 24,
            "config": [
              "autoCompactWindow is unset: compaction waits for the model window (about 1M on 1M models). Set "autoCompactWindow": 400000.",
              "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset: set it to at most 3.",
              "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH is unset: set it to at most 1.",
              "CLAUDE_CODE_SUBAGENT_MODEL is unset: subagents inherit the main model; pin a cheap worker (e.g. CLAUDE_CODE_SUBAGENT_MODEL=sonnet).",
              "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY is unset: set it to at most 4.",
            ],
            "contextTargets": {
              "claude": 400000,
              "codex": 300000,
              "opencode": 128000,
            },
            "days": 7,
            "generated": "2026-10-30T20:00:00+00:00",
            "issues": [
              {
                "fix": "autoCompactWindow is unset: compaction waits for the model window (about 1M on 1M models). Set "autoCompactWindow": 400000.",
                "level": "critical",
                "priority": 1,
                "prompt": "Token leak to fix: Config: autoCompactWindow.
        Applies to: Claude Code.

        Why it costs tokens: autoCompactWindow is unset: compaction waits for the model window (about 1M on 1M models). Set "autoCompactWindow": 400000.

        What to do: Fix this config problem: autoCompactWindow is unset: compaction waits for the model window (about 1M on 1M models). Set "autoCompactWindow": 400000.

        Report what you changed and how to check that it worked.",
                "sessions": 0,
                "share": null,
                "source": "claude",
                "title": "Config: autoCompactWindow",
              },
              {
                "fix": "Cap concurrent subagents at 3: each one runs its own model and tool loop.",
                "level": "warn",
                "priority": 2,
                "prompt": "Token leak to fix: Config: subagent fan-out cap.
        Applies to: Claude Code.

        Why it costs tokens: CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset: set it to at most 3.

        Additional info:
        - Claude Code defaults to 20 concurrent subagents and nesting depth 3, with no total cap.
        - Also set the depth cap: \`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1\` (Codex: \`agents.max_depth\`; note Multi-Agent V2 ignores it).
        - Pin the worker model so it is not inherited silently: \`CLAUDE_CODE_SUBAGENT_MODEL=sonnet\` (add \`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1\` to hard-enforce).
        - Codex: prefer \`fork_turns="none"\` for independent workers so they do not inherit the parent conversation history.

        What to do: Fix this config problem: CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset: set it to at most 3.

        Report what you changed and how to check that it worked.",
                "sessions": 0,
                "share": null,
                "source": "claude",
                "title": "Config: subagent fan-out cap",
              },
              {
                "fix": "Cap subagent nesting depth at 1: recursive delegation multiplies the loop.",
                "level": "warn",
                "priority": 2,
                "prompt": "Token leak to fix: Config: subagent nesting depth.
        Applies to: Claude Code.

        Why it costs tokens: CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH is unset: set it to at most 1.

        Additional info:
        - Nesting is the worst fan-out: a worker that spawns workers multiplies the whole loop.
        - Claude: \`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1\`. Codex: \`agents.max_depth\` (Multi-Agent V2 ignores it, so verify the effective depth from real traces).

        What to do: Fix this config problem: CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH is unset: set it to at most 1.

        Report what you changed and how to check that it worked.",
                "sessions": 0,
                "share": null,
                "source": "claude",
                "title": "Config: subagent nesting depth",
              },
              {
                "fix": "Pin a cheap worker model so subagents do not inherit a premium one.",
                "level": "warn",
                "priority": 2,
                "prompt": "Token leak to fix: Config: subagent model.
        Applies to: Claude Code.

        Why it costs tokens: CLAUDE_CODE_SUBAGENT_MODEL is unset: subagents inherit the main model; pin a cheap worker (e.g. CLAUDE_CODE_SUBAGENT_MODEL=sonnet).

        Additional info:
        - \`CLAUDE_CODE_SUBAGENT_MODEL=sonnet\` is a default, not a guarantee; add \`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1\` to hard-enforce (it overrides intentional per-agent specialization).
        - Codex: set \`agents.default_subagent_model\` explicitly; V2 can silently run a costlier worker than requested.
        - Verify the effective model from real usage, not from the instruction.

        What to do: Fix this config problem: CLAUDE_CODE_SUBAGENT_MODEL is unset: subagents inherit the main model; pin a cheap worker (e.g. CLAUDE_CODE_SUBAGENT_MODEL=sonnet).

        Report what you changed and how to check that it worked.",
                "sessions": 0,
                "share": null,
                "source": "claude",
                "title": "Config: subagent model",
              },
              {
                "fix": "Cap parallel tool calls at 4.",
                "level": "warn",
                "priority": 2,
                "prompt": "Token leak to fix: Config: tool-call concurrency.
        Applies to: Claude Code.

        Why it costs tokens: CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY is unset: set it to at most 4.

        Additional info:
        - \`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=4\` bounds parallel tool calls in the main agent.
        - Limit shell output at the byte level; a line-count cap fails when one line is huge.

        What to do: Fix this config problem: CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY is unset: set it to at most 4.

        Report what you changed and how to check that it worked.",
                "sessions": 0,
                "share": null,
                "source": "claude",
                "title": "Config: tool-call concurrency",
              },
            ],
            "kpis": [
              {
                "name": "Claude Code median context per turn",
                "target": 400000,
                "unit": "k",
                "values": [
                  100010,
                ],
              },
              {
                "name": "Turns over provider context target",
                "target": 0.1,
                "unit": "%",
                "values": [
                  0,
                ],
              },
              {
                "name": "Caller reads per tool call",
                "target": 0.2,
                "unit": "%",
                "values": [
                  0,
                ],
              },
            ],
            "overTarget": 0,
            "projectCount": 1,
            "projects": [
              [
                "demo",
                100,
              ],
            ],
            "sessions": 1,
            "timeline": [
              [
                "2026-10-30T20:00:00+00:00",
                10260,
                0,
              ],
            ],
            "timelines": {
              "claude": [
                [
                  "2026-10-30T20:00:00+00:00",
                  10260,
                  0,
                ],
              ],
            },
            "toolCalls": 0,
            "tools": [],
            "topSessions": [
              {
                "flags": [],
                "fullId": "session",
                "hours": 0,
                "id": "session",
                "path": "$HOME/.claude/projects/demo/session.jsonl",
                "peak": 100010,
                "project": "demo",
                "share": 100,
                "source": "claude",
                "title": "hello",
                "turns": 1,
              },
            ],
            "total": 10260,
            "turns": 1,
            "unpriced": null,
          },
          "usage": "{"fetched":1793390400,"seven_day":{"utilization":40,"resets_at":1793649600}}",
        }
      `);
    } finally {
      await server.close();
    }
  });

  it("still reads an install selected by CLAUDE_CONFIG_DIR", async () => {
    const home = mkdtempSync(join(tmpdir(), "tf-claude-env-"));
    roots.push(home);
    const install = buildClaudeInstall(home, ".agentx", { now: NOW });
    const app = compose({ ...baselineEnv(home), CLAUDE_CONFIG_DIR: install.dir }, { noCache: true });
    await app.reports.refresh();
    expect(app.repo.all().map((row) => row.path)).toEqual([install.session]);
  });
});

describe("Claude install discovery", () => {
  it("finds arbitrary named installs from the default, env, scan and shell rc signals", async () => {
    const home = mkdtempSync(join(tmpdir(), "tf-claude-discovery-"));
    roots.push(home);
    const outside = buildClaudeInstall(home, "../tf-claude-outside", { now: NOW });
    roots.push(outside.dir);
    const defaultInstall = buildClaudeInstall(home, ".claude", { now: NOW });
    const scanned = buildClaudeInstall(home, ".cc-work", { now: NOW });
    const xdg = buildClaudeInstall(join(home, ".config"), ".agentx", { now: NOW });
    const envInstall = buildClaudeInstall(home, ".from-env", { now: NOW });
    const linked = join(home, ".linked-claude");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(defaultInstall.dir, linked, "dir");
    writeFileSync(join(home, ".zshrc"), [
      `CLAUDE_CONFIG_DIR="$HOME/../${outside.dir.split("/").at(-1)}"`,
      `export CLAUDE_CONFIG_DIR='~/.not-the-outside'`,
      `export CLAUDE_CONFIG_DIR="$OTHER/ignored"`,
    ].join("\n"));
    const { discoverClaudeInstalls } = await import("../src/sources/claude-installs");

    const installs = discoverClaudeInstalls({
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CLAUDE_CONFIG_DIR: envInstall.dir,
    });

    expect(installs.map((install) => install.id)).toEqual([
      "claude", "claude:agentx", "claude:cc-work", "claude:from-env", "claude:tf-claude-outside",
    ]);
    expect(installs[0]).toMatchObject({ dir: defaultInstall.dir, isDefault: true, found: ["default", "scan"] });
    expect(installs.find((install) => install.dir === outside.dir)?.found).toEqual(["shell-rc"]);
    expect(installs.find((install) => install.dir === scanned.dir)?.id).toBe("claude:cc-work");
    expect(installs.find((install) => install.dir === xdg.dir)?.id).toBe("claude:agentx");

  });

  it("deduplicates the default env path and suffixes slug collisions", async () => {
    const home = mkdtempSync(join(tmpdir(), "tf-claude-slugs-"));
    roots.push(home);
    buildClaudeInstall(home, ".claude", { now: NOW });
    buildClaudeInstall(home, ".claude-work", { now: NOW });
    buildClaudeInstall(home, ".claude_work", { now: NOW });
    const { discoverClaudeInstalls } = await import("../src/sources/claude-installs");
    const installs = discoverClaudeInstalls({ HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") });
    expect(installs.map(({ id, label }) => ({ id, label }))).toMatchInlineSnapshot(`
      [
        {
          "id": "claude",
          "label": "Claude Code",
        },
        {
          "id": "claude:work",
          "label": "Claude Code (work)",
        },
        {
          "id": "claude:work-2",
          "label": "Claude Code (work-2)",
        },
      ]
    `);
  });

  it("composes one Claude source per discovered install", () => {
    const home = mkdtempSync(join(tmpdir(), "tf-claude-compose-"));
    roots.push(home);
    buildClaudeInstall(home, ".claude", { now: NOW });
    buildClaudeInstall(home, ".cc-work", { now: NOW });
    const app = compose({ ...baselineEnv(home), CLAUDE_CONFIG_DIR: undefined }, { noCache: true });
    expect(app.sources.filter((source) => source.kind === "claude").map((source) => source.name)).toEqual([
      "claude",
      "claude:cc-work",
    ]);
  });

  it("scopes cache eviction to the installs scanned in that run", async () => {
    const home = mkdtempSync(join(tmpdir(), "tf-claude-cache-home-"));
    const outside = mkdtempSync(join(tmpdir(), "tf-claude-cache-outside-"));
    const cache = mkdtempSync(join(tmpdir(), "tf-claude-cache-"));
    roots.push(home, outside, cache);
    const a = buildClaudeInstall(home, ".claude", { now: NOW, session: "a" });
    const b = buildClaudeInstall(outside, ".cc-work", { now: NOW, session: "b" });
    const base = { HOME: home, XDG_CACHE_HOME: cache, TOKEN_FURNACE_NOW: NOW.toISOString(), TOKEN_FURNACE_WORKERS: "0" };

    const onlyA = compose(base);
    await onlyA.reports.refresh();
    expect(onlyA.repo.all().map((row) => row.source)).toEqual(["claude"]);

    writeFileSync(join(home, ".zshrc"), `CLAUDE_CONFIG_DIR=${b.dir}\n`);
    const both = compose(base);
    await both.reports.refresh();
    const bId = both.sources.find((source) => source.base() === b.dir)!.name;
    const bMtime = statSync(b.session).mtimeMs;
    expect(both.repo.all().map((row) => row.source).sort()).toEqual(["claude", bId].sort());

    rmSync(join(home, ".zshrc"));
    const againA = compose(base);
    await againA.reports.refresh();
    expect(againA.repo.all().map((row) => row.source).sort()).toEqual(["claude", bId].sort());
    expect(statSync(b.session).mtimeMs).toBe(bMtime);
    expect(againA.reports.getReport(7, "all", { now: NOW, weeklyBudget: null })!.topSessions.every((session) => session.source === "claude")).toBe(true);
    writeFileSync(join(home, ".zshrc"), `CLAUDE_CONFIG_DIR=${b.dir}\n`);
    const returning = compose(base);
    const parsed: string[] = [];
    for (const source of returning.sources) {
      const parse = source.parse.bind(source);
      source.parse = (path) => { parsed.push(path); return parse(path); };
    }
    await returning.reports.refresh();
    expect(parsed).toEqual([]);
    expect(returning.repo.all().map((row) => row.path).sort()).toEqual([a.session, b.session].sort());
  });

  it("lets concurrent apps share a cache without showing each other's sessions", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "tf-claude-concurrent-a-"));
    const homeB = mkdtempSync(join(tmpdir(), "tf-claude-concurrent-b-"));
    const customA = buildClaudeInstall(homeA, "../.cc-a", { now: NOW, session: "a" });
    const customB = buildClaudeInstall(homeB, "../.cc-b", { now: NOW, session: "b" });
    const cache = mkdtempSync(join(tmpdir(), "tf-claude-concurrent-cache-"));
    roots.push(homeA, homeB, customA.dir, customB.dir, cache);
    writeFileSync(join(homeA, ".zshrc"), `CLAUDE_CONFIG_DIR=${customA.dir}\n`);
    writeFileSync(join(homeB, ".zshrc"), `CLAUDE_CONFIG_DIR=${customB.dir}\n`);
    const envA = { HOME: homeA, XDG_CACHE_HOME: cache, TOKEN_FURNACE_NOW: NOW.toISOString(), TOKEN_FURNACE_WORKERS: "0" };
    const envB = { HOME: homeB, XDG_CACHE_HOME: cache, TOKEN_FURNACE_NOW: NOW.toISOString(), TOKEN_FURNACE_WORKERS: "0" };
    const appA = compose(envA);
    const appB = compose(envB);
    await Promise.all([appA.reports.refresh(), appB.reports.refresh()]);
    const reportA = appA.reports.getReport(7, "all", { now: NOW, weeklyBudget: null })!;
    const reportB = appB.reports.getReport(7, "all", { now: NOW, weeklyBudget: null })!;
    expect(reportA.topSessions.map((session) => session.source)).toEqual(["claude:cc-a"]);
    expect(reportB.topSessions.map((session) => session.source)).toEqual(["claude:cc-b"]);
  });
});


describe("Claude install isolation edge cases", () => {
  it("reads quoted aliases and exact HOME variables without executing shell content", async () => {
    const home = mkdtempSync(join(tmpdir(), "tf-aliases-"));
    roots.push(home);
    const alias = buildClaudeInstall(home, "nested/alias dir", { now: NOW });
    const braced = buildClaudeInstall(home, "nested/braced", { now: NOW });
    const tilde = buildClaudeInstall(home, "nested/tilde", { now: NOW });
    const invalid = buildClaudeInstall(home, `../${home.split("/").at(-1)}OTHER`, { now: NOW });
    roots.push(invalid.dir);
    writeFileSync(join(home, ".zshrc"), [
      `alias second='CLAUDE_CONFIG_DIR="$HOME/nested/alias dir" claude'`,
      `alias third="CLAUDE_CONFIG_DIR='\${HOME}/nested/braced' claude"`,
      `export CLAUDE_CONFIG_DIR="~/nested/tilde"`,
      `CLAUDE_CONFIG_DIR="$HOMEOTHER"`,
      `CLAUDE_CONFIG_DIR="${invalid.dir}"$OTHER`,
      `CLAUDE_CONFIG_DIR="$(touch ${join(home, "executed")})"`,
    ].join("\n"));
    const { discoverClaudeInstalls } = await import("../src/sources/claude-installs");
    const installs = discoverClaudeInstalls(baselineEnv(home));
    expect(installs.map((install) => install.dir)).toEqual([join(home, ".claude"), alias.dir, braced.dir, tilde.dir]);
    expect(existsSync(join(home, "executed"))).toBe(false);
  });

  it("reserves collision suffixes across A, A+B, B and A discovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "tf-stable-identity-"));
    roots.push(home);
    const a = buildClaudeInstall(home, "z/.claude-work", { now: NOW });
    const b = buildClaudeInstall(home, "a/.claude-work", { now: NOW });
    const rc = join(home, ".zshrc");
    const { discoverClaudeInstalls } = await import("../src/sources/claude-installs");
    const discover = (...dirs: string[]) => {
      writeFileSync(rc, dirs.map((dir) => `CLAUDE_CONFIG_DIR="${dir}"`).join("\n"));
      return discoverClaudeInstalls(baselineEnv(home));
    };
    const aId = discover(a.dir).find((install) => install.dir === a.dir)!.id;
    expect(aId).toBe("claude:work");
    const both = discover(a.dir, b.dir);
    expect(both.find((install) => install.dir === a.dir)?.id).toBe(aId);
    const bId = both.find((install) => install.dir === b.dir)!.id;
    expect(bId).toBe("claude:work-2");
    expect(discover(b.dir).find((install) => install.dir === b.dir)?.id).toBe(bId);
    expect(discover(a.dir).find((install) => install.dir === a.dir)?.id).toBe(aId);
  });

  it("reserves different ids for concurrent CLI discovery of colliding paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "tf-concurrent-identity-"));
    roots.push(home);
    const dirs = ["a/.claude-work", "b/.claude-work"].map((path) => buildClaudeInstall(home, path, { now: NOW }).dir);
    const env = baselineEnv(home);
    const run = (dir: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/cli.js", "--list-sources"], { env: { ...env, CLAUDE_CONFIG_DIR: dir }, stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`CLI exit ${code}`)));
    });
    await Promise.all([...dirs, ...dirs].map(run));
    const { discoverClaudeInstalls } = await import("../src/sources/claude-installs");
    const ids = dirs.map((dir) => discoverClaudeInstalls({ ...env, CLAUDE_CONFIG_DIR: dir }).find((install) => install.dir === dir)!.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.sort()).toEqual(["claude:work", "claude:work-2"]);
  });

  it("does not promote a custom env install into the default account's identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "tf-env-identity-"));
    roots.push(home);
    const custom = buildClaudeInstall(home, ".agentx", { now: NOW });
    const { discoverClaudeInstalls } = await import("../src/sources/claude-installs");
    expect(discoverClaudeInstalls({ ...baselineEnv(home), CLAUDE_CONFIG_DIR: custom.dir }).map((install) => install.id)).toEqual(["claude", "claude:agentx"]);
  });
});


it("targets custom install paths in config advice and compaction prompts", async () => {
  const home = mkdtempSync(join(tmpdir(), "tf-install-advice-"));
  roots.push(home);
  buildClaudeInstall(home, ".claude", { now: NOW });
  const custom = buildClaudeInstall(home, ".agentx", { now: NOW, context: 500_000 });
  const app = compose(baselineEnv(home), { noCache: true });
  await app.reports.refresh();
  const report = app.reports.getReport(7, "all", { now: NOW, weeklyBudget: null })!;
  expect(report.config.some((line) => line.startsWith("claude:agentx ") && line.includes(custom.dir))).toBe(true);
  const issue = report.issues.find((issue) => issue.source === "claude:agentx" && issue.title === "Sessions compact too late")!;
  expect(issue.fix).toContain(`${custom.dir}/settings.json`);
  expect(issue.prompt).toContain(`${custom.dir}/settings.json`);
  expect(issue.prompt).not.toContain("~/.claude/settings.json");
});


it("refuses a corrupt identity reservation instead of reusing another install's quota id", async () => {
  const home = mkdtempSync(join(tmpdir(), "tf-reservation-failure-"));
  roots.push(home);
  buildClaudeInstall(home, ".claude-work", { now: NOW });
  const env = baselineEnv(home);
  const root = join(env.XDG_CACHE_HOME!, "token-furnace", "claude-installs");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "work"), "unreadable reservation format");
  const { discoverClaudeInstalls } = await import("../src/sources/claude-installs");
  expect(() => discoverClaudeInstalls(env)).toThrow();
});
