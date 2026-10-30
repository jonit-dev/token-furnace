/**
 * Fixture builders for the analysis tests and the parity harness.
 *
 * Each builder writes a CLAUDE_CONFIG_DIR and a CODEX_HOME with transcript times relative to
 * a fixed `now`, so Python and TypeScript read the same bytes and agree on the same clock.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Source } from "../../src/core/model";

export interface Fixture {
  /** CLAUDE_CONFIG_DIR is the root; CODEX_HOME is the codex directory under it. */
  root: string;
  now: Date;
  files: { source: Source; path: string }[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function iso(at: Date): string {
  return at.toISOString();
}

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function write(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n");
}

/** The record shapes Claude Code writes, as test_burn.py builds them. */
export function assistant(
  when: Date,
  context: number,
  calls: [name: string, command: string][] = [],
  write = 0,
): string {
  return line({
    type: "assistant",
    timestamp: iso(when),
    message: {
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: context,
        cache_creation_input_tokens: write,
        output_tokens: 50,
      },
      content: calls.map(([name, command]) => ({ type: "tool_use", name, input: { command } })),
    },
  });
}

export function user(when: Date, text: string): string {
  return line({ type: "user", timestamp: iso(when), message: { content: text } });
}

export interface ClaudeInstallFixture {
  dir: string;
  session: string;
}

/** A minimal Claude config at any path, independent of the directory name. */
export function buildClaudeInstall(
  root: string,
  relDir: string,
  options: { now: Date; project?: string; session?: string; context?: number },
): ClaudeInstallFixture {
  const dir = relDir.startsWith("/") ? relDir : join(root, relDir);
  const project = options.project ?? "demo";
  const session = options.session ?? "session";
  const sessionPath = join(dir, "projects", project, `${session}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), "{}\n");
  writeFileSync(join(dir, "settings.json"), "{}\n");
  write(sessionPath, [
    user(options.now, "hello"),
    assistant(options.now, options.context ?? 100_000),
  ]);
  return { dir, session: sessionPath };
}

/** A codex token_count record, with reasoning tokens billed as output. */
export function codexToken(
  when: Date,
  input: number,
  cached: number,
  output: number,
): string {
  return line({
    type: "event_msg",
    timestamp: iso(when),
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 0,
        },
      },
    },
  });
}

export function codexRateLimits(used: number, resetsAtEpochSeconds: number): string {
  return line({
    type: "event_msg",
    payload: {
      rate_limits: {
        primary: { used_percent: 9, window_minutes: 300, resets_at: resetsAtEpochSeconds },
        secondary: { used_percent: used, window_minutes: 10080, resets_at: resetsAtEpochSeconds },
      },
    },
  });
}

/**
 * The full fixture: five session leaks, every config check in FR-6 and FR-7, a live Claude
 * session, a live Codex session, and rate_limits for the weekly window. test_burn.py:main
 */
export function buildFull(root: string, now: Date): Fixture {
  const project = join(root, "projects", "demo");
  write(join(project, "memory", "MEMORY.md"), Array.from({ length: 250 }, () => "- line"));
  write(join(root, "settings.json"), ["{}"]);

  const lines: string[] = [user(new Date(now.getTime() - 13 * HOUR), "fix the bug")];
  for (let i = 0; i < 300; i++) {
    const when = new Date(now.getTime() - 13 * HOUR + i * 150_000);
    if (i % 5 === 0) lines.push(user(when, "<task-notification>done</task-notification>"));
    lines.push(assistant(when, 400_000, [["Bash", "cd /x && sed -n 1,9p f"]]));
  }
  const leak = join(project, "aaaaaaaa-leak.jsonl");
  write(leak, lines);

  // A second session: an old, huge one plus a recent healthy one, for check_last_24h.
  const healthy = new Date(now.getTime() - 2 * HOUR);
  const healthyLines: string[] = [];
  for (let i = 0; i < 20; i++) {
    if (i === 0) healthyLines.push(user(healthy, "go"));
    healthyLines.push(
      assistant(new Date(healthy.getTime() + i * MINUTE), i >= 10 ? 200_000 : 100_000, [], 20_000),
    );
  }
  const healthyFile = join(project, "bbbbbbbb-healthy.jsonl");
  write(healthyFile, healthyLines);

  const old = new Date(now.getTime() - 3 * 86_400_000);
  const oldLines = [user(old, "go")];
  for (let i = 0; i < 20; i++) {
    oldLines.push(assistant(new Date(old.getTime() + i * MINUTE), 900_000));
  }
  const oldFile = join(project, "cccccccc-old.jsonl");
  write(oldFile, oldLines);

  // Codex: one rollout with usage, tool calls and a live weekly reading.
  const codexPath = join(root, "codex", "sessions", "2026", "10", "rollout-demo.jsonl");
  const codexLines: string[] = [
    line({
      type: "session_meta",
      payload: { cwd: "/srv/api", id: "0a1b2c3d4e5f" },
    }),
    line({ type: "turn_context", payload: { model: "gpt-5.5" } }),
    user(new Date(now.getTime() - 4 * HOUR), "port the CLI"),
  ];
  for (let i = 0; i < 40; i++) {
    const when = new Date(now.getTime() - 4 * HOUR + i * MINUTE);
    codexLines.push(
      line({ type: "event_msg", payload: { type: "function_call", name: "shell", arguments: '{"command":"sed -n 1,20p x"}' } }),
      codexToken(when, 50_000, 30_000, 900),
    );
  }
  codexLines.push(codexRateLimits(40, Math.floor(now.getTime() / 1000) + 3 * 86_400));
  write(codexPath, codexLines);
  // Every Codex check is over its target, so each one becomes a config issue.
  write(join(root, "codex", "config.toml"), [
    "[agents]",
    "max_concurrent_threads_per_session = 5",
    "max_depth = 2",
    "",
  ]);

  return {
    root,
    now,
    files: [
      { source: "claude", path: leak },
      { source: "claude", path: healthyFile },
      { source: "claude", path: oldFile },
      { source: "codex", path: codexPath },
    ],
  };
}

/** The fixture check_weekly_quota builds: one session plus a saved usage reading. */
export function buildWeeklyQuota(root: string, now: Date): Fixture {
  const project = join(root, "projects", "demo");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, "token-furnace"), { recursive: true });
  writeFileSync(
    join(root, "token-furnace", "usage.json"),
    JSON.stringify({
      fetched: now.getTime() / 1000,
      seven_day: { utilization: 40, resets_at: now.getTime() / 1000 + 3 * 86_400 },
    }),
  );
  const whens = [
    ...Array.from({ length: 150 }, (_, i) => new Date(now.getTime() - 30 * HOUR + i * 10 * MINUTE)),
    ...Array.from({ length: 5 }, (_, i) => new Date(now.getTime() - (30 - 5 * i) * MINUTE)),
  ];
  const path = join(project, "s-week.jsonl");
  write(path, whens.map((when) => assistant(when, 200_000)));
  return { root, now, files: [{ source: "claude", path }] };
}

/** Codex's rate_limits file, for check_codex_week. */
export function buildCodexWeek(root: string, used: number, resetsAtEpochSeconds: number): string {
  const path = join(root, "sessions", "2026", "rollout-x.jsonl");
  write(path, [codexRateLimits(used, resetsAtEpochSeconds)]);
  return path;
}

/** A saved subscription reading, the file plan_week() reads: 40% used, resetting in 3 days. */
export function saveUsageReading(root: string, now: Date): void {
  mkdirSync(join(root, "token-furnace"), { recursive: true });
  writeFileSync(
    join(root, "token-furnace", "usage.json"),
    JSON.stringify({
      fetched: now.getTime() / 1000,
      seven_day: { utilization: 40, resets_at: now.getTime() / 1000 + 3 * 86_400 },
    }),
  );
}
