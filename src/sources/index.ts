import { OpenCodeSource } from "./opencode";
import { ClaudeSource } from "./claude";
import { CodexSource } from "./codex";
import type { AgentSource, Env } from "./agent-source";
import { discoverClaudeInstalls } from "./claude-installs";

/** One adapter registration for the CLI and parse workers. */
export function createSources(env: Env): AgentSource[] {
  return [
    ...discoverClaudeInstalls(env).map((install) => new ClaudeSource(install)),
    new CodexSource(env),
    new OpenCodeSource(env),
  ];
}
