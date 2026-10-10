/**
 * The shared test harness: write a fixture directory, then read a report from it with either
 * TypeScript or the real burn.py. The Python side is the oracle until PRD-003 deletes it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildReport } from "../src/core/analyze/report";
import { reportView } from "../src/core/analyze/view";
import type {
  ConfigInput,
  RawReport,
  Report,
  ReportInput,
  SessionInput,
  Source,
  Week,
} from "../src/core/model";
import { ClaudeSource } from "../src/sources/claude";
import { CodexSource } from "../src/sources/codex";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

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

/** The raw report, for a test that reads burn.py's own dict keys. */
export function tsRaw(
  env: NodeJS.ProcessEnv,
  now: Date,
  days: number,
  budget: number | null,
  source: string,
): RawReport | null {
  return buildReport(reportInput(env, now, days, budget, source));
}

/** burn.build_report + burn.report_view, as JSON, with the clock frozen to TF_PARITY_NOW. */
export function pythonReport(
  env: NodeJS.ProcessEnv,
  days: number,
  budget: number | null,
  source: string,
): unknown {
  const script = `
import datetime, json, sys, types
sys.path.insert(0, ${JSON.stringify(join(REPO, "scripts"))})
import burn

fixed = datetime.datetime.fromisoformat("${env.TF_PARITY_NOW}")


class Frozen(datetime.datetime):
    @classmethod
    def now(cls, tz=None):
        return fixed


burn.datetime.datetime = Frozen
args = types.SimpleNamespace(days=${days}, weekly_budget=${budget === null ? "None" : budget},
                             source=${JSON.stringify(source)})
report = burn.build_report(args)
print(json.dumps(burn.report_view(report) if report else None, default=str))
`;
  const out = execFileSync("python3", ["-c", script], { env, encoding: "utf8", cwd: REPO });
  const lines = out.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * Python's clock has microseconds, a JS Date has milliseconds. Truncate every ISO string to
 * milliseconds so a sub-millisecond difference in a projected instant is not a parity failure.
 */
export function normalizeTimes(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\.(\d{3})\d*\+00:00$/, ".$1+00:00");
  if (Array.isArray(value)) return value.map(normalizeTimes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeTimes(item);
    return out;
  }
  return value;
}

/** Float comparison to 1e-9, as the PRD asks; everything else must be identical. */
export function compare(a: unknown, b: unknown, path = "report"): string[] {
  const diffs: string[] = [];
  const walk = (x: unknown, y: unknown, at: string): void => {
    if (typeof x === "number" && typeof y === "number") {
      if (Math.abs(x - y) > 1e-9) diffs.push(`${at}: ${x} != ${y}`);
      return;
    }
    if (x === null || y === null || typeof x !== "object" || typeof y !== "object") {
      if (x !== y) {
        const cut = (v: unknown) => {
          const text = JSON.stringify(v) ?? String(v);
          return text.length > 400 ? `${text.slice(0, 400)}…` : text;
        };
        diffs.push(`${at}: ${cut(x)} != ${cut(y)}`);
      }
      return;
    }
    if (Array.isArray(x) !== Array.isArray(y)) {
      diffs.push(`${at}: array mismatch`);
      return;
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const key of keys) walk((x as any)[key], (y as any)[key], `${at}.${key}`);
  };
  walk(a, b, path);
  return diffs;
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