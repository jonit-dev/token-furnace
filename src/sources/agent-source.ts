import { readdirSync } from "node:fs";
import type { ParsedFile, Source, SourceFile, Week } from "../core/model";

/** Read-only adapter for one agent's transcripts on disk. */
export interface AgentSource {
  name: Source;
  /** Directory that proves the agent is installed. */
  root(): string;
  files(): SourceFile[];
  parse(path: string): ParsedFile;
  /** The agent's own directory: CLAUDE_CONFIG_DIR or ~/.claude, CODEX_HOME or ~/.codex. */
  base(): string;
  /** The directory the agent uses when its env var is unset. */
  home(): string;
  /** Raw text of a file in the agent's own directory, or null when it is not there. */
  readFile(name: string): string | null;
  /** The agent's 7-day usage window from local data, when it logs one. */
  week?(now: Date): Week | null;
  /** MEMORY.md indexes the agent loads, with their line counts. Claude only. */
  memoryIndexes?(): { path: string; lines: number }[];
}

export type Env = Record<string, string | undefined>;

/** A shell command that reads files or logs into the caller's context. burn.py:96 */
const READ_COMMAND =
  /(?:^|&&|;|\|\||\n)\s*(?:sed -n|grep|rg|cat|head|tail|awk|jq|find|python3? -c?(?:\s|$))/;

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

export function isRead(name: unknown, command: unknown): boolean {
  if (typeof name === "string" && READ_TOOLS.has(name)) return true;
  const text = typeof command === "string" ? command.trim() : "";
  return text !== "" && READ_COMMAND.test(text);
}

/** What a user record means: a wakeup kind, a human prompt, or null (harness noise). burn.py:105 */
export function classifyPrompt(text: string): "human" | "teammate" | "task" | "peer" | null {
  if (text.includes("<teammate-message")) return "teammate";
  if (text.includes("<task-notification")) return "task";
  if (text.includes("<cross-session-message")) return "peer";
  const body = text.trimStart();
  if (
    !body ||
    body.startsWith("<") ||
    body.startsWith("This session is being continued") ||
    body.startsWith("Base directory for this skill")
  ) {
    return null;
  }
  return "human";
}

/** ISO time to a Date, or null when it is not a time. burn.py:74 */
export function parseTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? null : when;
}

/** One transcript line, or null when the line is not valid JSON. */
export function jsonParse(line: string): Record<string, any> | null {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === "object" ? (value as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/** A directory listing that treats a missing directory as empty. */
export function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Token count, with a missing or null value as zero, like Python's `or 0`. */
export function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}