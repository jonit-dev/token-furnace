import { OpenCodeSource } from "./opencode";
import { AgySource } from "./agy";
import { ClaudeSource } from "./claude";
import { CodexSource } from "./codex";
import type { AgentSource, Env } from "./agent-source";
import type { Source } from "../core/model";

/** One adapter registration for the CLI and parse workers. */
export function createSources(env: Env): AgentSource[] {
  const sources: Record<Source, AgentSource> = {
    claude: new ClaudeSource(env),
    codex: new CodexSource(env),
    opencode: new OpenCodeSource(env),
    agy: new AgySource(env),
  };
  return Object.values(sources);
}
