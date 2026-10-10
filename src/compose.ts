import { existsSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemorySessionRepository } from "./repo/memory-repo";
import { SqliteSessionRepository } from "./repo/sqlite-repo";
import type { SessionRepository } from "./repo/session-repo";
import { ReportService } from "./services/report-service";
import { ClaudeSource } from "./sources/claude";
import { CodexSource } from "./sources/codex";
import type { AgentSource, Env } from "./sources/agent-source";

export interface App {
  env: Env;
  sources: AgentSource[];
  repo: SessionRepository;
  reports: ReportService;
  /** The clock. TOKEN_FURNACE_NOW freezes it, so a test can compare two runs byte for byte. */
  now: () => Date;
}

export function sqliteCachePath(env: Env): string {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(base, "token-furnace", "cache.sqlite");
}

/** The composition root: the only place that calls `new`. architecture.md */
export function compose(env: Env = process.env, opts?: { noCache?: boolean }): App {
  const noCache = opts?.noCache ?? Boolean(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0");
  const effective: Env = { ...env, TOKEN_FURNACE_NO_CACHE: noCache ? "1" : "0" };
  const sources: AgentSource[] = [new ClaudeSource(effective), new CodexSource(effective)];
  const repo = noCache ? new MemorySessionRepository() : new SqliteSessionRepository(sqliteCachePath(effective));
  return {
    env: effective,
    sources,
    repo,
    reports: new ReportService(sources, repo, effective, workers(effective)),
    now: () => new Date(effective.TOKEN_FURNACE_NOW || Date.now()),
  };
}

/**
 * Parse threads, when the built worker script sits next to this bundle. Running from source (a
 * test, `tsx`) has no such file and parses on the main thread. TOKEN_FURNACE_WORKERS=0 turns it off.
 */
function workers(env: Env): { url: URL; size: number } | null {
  const url = new URL("./scan-worker.js", import.meta.url);
  const wanted = env.TOKEN_FURNACE_WORKERS !== undefined
    ? Number(env.TOKEN_FURNACE_WORKERS)
    : Math.max(1, Math.min(availableParallelism() - 1, 8));
  return existsSync(fileURLToPath(url)) && wanted >= 1 ? { url, size: Math.floor(wanted) } : null;
}
