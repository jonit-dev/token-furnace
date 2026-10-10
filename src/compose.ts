import { homedir } from "node:os";
import { join } from "node:path";
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
  const sources: AgentSource[] = [new ClaudeSource(env), new CodexSource(env)];
  const noCache = opts?.noCache ?? Boolean(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0");
  const repo = noCache ? new MemorySessionRepository() : new SqliteSessionRepository(sqliteCachePath(env));
  return {
    env,
    sources,
    repo,
    reports: new ReportService(sources, repo, env),
    now: () => new Date(env.TOKEN_FURNACE_NOW || Date.now()),
  };
}
