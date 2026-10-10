import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { MemorySessionRepository } from "./repo/memory-repo";
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

/** The composition root: the only place that calls `new`. architecture.md */
export function compose(env: Env = process.env): App {
  const sources: AgentSource[] = [new ClaudeSource(env), new CodexSource(env)];
  // PRD-004 swaps this for SqliteSessionRepository(cachePath(env)) unless --no-cache.
  const repo = new MemorySessionRepository();
  return {
    env,
    sources,
    repo,
    reports: new ReportService(sources, repo, env, workers()),
    now: () => new Date(env.TOKEN_FURNACE_NOW || Date.now()),
  };
}

/**
 * Parse threads, when the built worker script sits next to this bundle. Running from source (a
 * test, `tsx`) has no such file and parses on the main thread. TOKEN_FURNACE_WORKERS=0 turns it off.
 */
function workers(): { url: URL; size: number } | null {
  const url = new URL("./scan-worker.js", import.meta.url);
  const wanted = Number(process.env.TOKEN_FURNACE_WORKERS ?? Math.min(availableParallelism() - 1, 8));
  return existsSync(fileURLToPath(url)) && wanted > 1 ? { url, size: Math.floor(wanted) } : null;
}
