/** Data contracts shared by every layer. See docs/PRDs/active/npx-restructure/schema.md. */

export type Source = "claude" | "codex";

/** What arrived before a turn: a human prompt, a teammate, a task, or a peer agent. */
export type Wake = "human" | "teammate" | "task" | "peer";

/** One normalized assistant turn. A source yields these and nothing else. */
export interface Turn {
  source: Source;
  project: string;
  /** Session id. */
  session: string;
  model: string;
  /** UTC. */
  when: Date;
  /** Uncached input tokens. */
  baseIn: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Tool names called in this turn. */
  tools: string[];
  /** Tool calls that read files or logs into the caller's own context. */
  reads: number;
  wakes: Wake[];
}

/** A transcript file that an agent can scan. */
export interface SourceFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** What one transcript file yields. Message text never survives the parse. */
export interface ParsedFile {
  turns: Turn[];
  /** Session title, Claude only. */
  title: string | null;
  /** Transcript lines that were not valid JSON. */
  badLines: number;
}