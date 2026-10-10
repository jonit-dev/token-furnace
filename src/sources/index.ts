import { ClaudeSource } from "./claude";
import { CodexSource } from "./codex";
import type { AgentSource, Env } from "./agent-source";
import type { Source } from "../core/model";

/** One adapter registration for the CLI and parse workers. */
export function createSources(env: Env): AgentSource[] {
  const sources: Record<Source, AgentSource> = {
    claude: new ClaudeSource(env),
    codex: new CodexSource(env),
  };
  return Object.values(sources);
}
