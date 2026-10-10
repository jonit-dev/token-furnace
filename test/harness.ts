/**
 * The shared test harness: write a fixture directory, then read the report from it.
 * The golden files in test/golden/ are burn.py's own output on these fixtures, kept as the oracle.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildReport } from "../src/core/analyze/report";
import { reportView } from "../src/core/analyze/view";
import type {
  ConfigInput,
  Report,
  ReportInput,
  SessionInput,
  Source,
  Week,
} from "../src/core/model";
import { ClaudeSource } from "../src/sources/claude";
import { CodexSource } from "../src/sources/codex";

/** The env test_burn.py run() unsets, so a developer's own settings cannot leak in. */
export const CLEARED = [
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
  "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY",
  "TOKEN_FURNACE_WEEKLY_BUDGET",
];

/** A whole-second instant, so Python's datetime.now() and a JS Date agree to the second. */
export function fixedNow(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

export function harnessEnv(root: string, now: Date): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: join(root, "codex"),
    XDG_CACHE_HOME: root,
    TF_PARITY_NOW: now.toISOString(),
  };
  for (const key of CLEARED) delete env[key];
  return env;
}

/** Every file the sources see, parsed. Same order as burn.py's per-source file loop. */
export function collectSessions(env: NodeJS.ProcessEnv, source: string): { live: Source[]; sessions: SessionInput[] } {
  const agents = {
    claude: new ClaudeSource(env),
    codex: new CodexSource(env),
  } as const;
  const live: Source[] = [];
  const sessions: SessionInput[] = [];
  for (const name of Object.keys(agents) as Source[]) {
    if (source !== "all" && source !== name) continue;
    const agent = agents[name];
    if (!existsDir(agent.root())) continue; // not installed
    live.push(name);
    for (const file of agent.files()) {
      const parsed = agent.parse(file.path);
      sessions.push({
        source: name,
        path: file.path,
        mtimeMs: file.mtimeMs,
        title: parsed.title,
        turns: parsed.turns,
      });
    }
  }
  return { live, sessions };
}

/** The plan week's saved reading, as burn.py plan_week() reads it. No network. */
export function planWeek(root: string, now: Date): Week | null {
  const path = join(root, "token-furnace", "usage.json");
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8"))?.seven_day;
  if (!data) return null;
  const resets = new Date(
    typeof data.resets_at === "number" ? data.resets_at * 1000 : Date.parse(data.resets_at),
  );
  if (resets <= now) return null;
  return { start: new Date(resets.getTime() - 7 * 86_400_000), resets, used: Number(data.utilization) };
}

/** Read every config file the checks want, so the core never touches the disk. */
export function readConfig(env: NodeJS.ProcessEnv): ConfigInput {
  const claudeBase = env.CLAUDE_CONFIG_DIR ?? "";
  const codexHome = env.CODEX_HOME ?? "";
  const memoryIndexes = [];
  for (const project of tryDirs(join(claudeBase, "projects"))) {
    const path = join(claudeBase, "projects", project, "memory", "MEMORY.md");
    const text = tryRead(path);
    if (text === null) continue;
    memoryIndexes.push({ path, lines: text.split("\n").length - 1 });
  }
  const inner: Record<string, string | undefined> = {};
  for (const key of CLEARED) inner[key] = env[key];
  return {
    claudeBase,
    claudeHome: env.HOME ? join(env.HOME, ".claude") : claudeBase,
    settings: tryRead(join(claudeBase, "settings.json")),
    codexConfig: tryRead(join(codexHome, "config.toml")),
    memoryIndexes,
    env: inner,
  };
}

export function reportInput(
  env: NodeJS.ProcessEnv,
  now: Date,
  days: number,
  budget: number | null,
  source: string,
): ReportInput {
  const { live, sessions } = collectSessions(env, source);
  const codex = new CodexSource(env);
  return {
    now,
    days,
    weeklyBudget: budget,
    live,
    sessions,
    config: readConfig(env),
    planWeek: planWeek(env.CLAUDE_CONFIG_DIR ?? "", now),
    codexWeek: live.includes("codex") ? codex.week(now) : null,
  };
}

/** The TypeScript report over a fixture directory. */
export function tsReport(
  env: NodeJS.ProcessEnv,
  now: Date,
  days: number,
  budget: number | null,
  source: string,
): Report | null {
  const raw = buildReport(reportInput(env, now, days, budget, source));
  return raw ? reportView(raw, now) : null;
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function tryDirs(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}