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
  /** Map of full session ID to native thread/session title, if the agent stores an index. */
  sessionMetadata?(): Map<string, string>;
}

export type Env = Record<string, string | undefined>;

/** A shell command that reads files or logs into the caller's context. burn.py:96 */
const READ_COMMAND =
  /(?:^|&&|;|\|\||\n)\s*(?:sed -n|grep|rg|cat|head|tail|awk|jq|find|python3? -c?(?:\s|$))/;

const WINDOWS_READ_COMMAND =
  /(?:^|&&|;|\|\||\||\n)\s*(?:Get-Content|Select-String|gc|cat|type|sls)(?:\s|$)/i;

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "read", "grep", "glob"]);

export function isRead(name: unknown, command: unknown): boolean {
  if (typeof name === "string" && READ_TOOLS.has(name)) return true;
  const text = typeof command === "string" ? command.trim() : "";
  return text !== "" && (READ_COMMAND.test(text) || WINDOWS_READ_COMMAND.test(text));
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

/** A full UUID anywhere in a string. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Readable words from a file stem: first word capitalized, acronyms kept, the rest lower case. */
function humanizeStem(stem: string): string {
  const words = stem.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return "";
  const parts = words.map((w) => (/[a-z]/.test(w) ? w.toLowerCase() : w));
  parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return parts.join(" ");
}

/**
 * A readable title from a handoff prompt, or null. A handoff begins with Read or Please read and a
 * path; the path must carry a separator, so ordinary prose never matches. The stem becomes readable
 * words, or `opaque` when it names a UUID or a hash (the caller then falls back to project plus id).
 */
export function deriveHandoffTitle(text: string): { title: string } | { opaque: true } | null {
  const start = /^\s*(?:please\s+)?read\s+(\S+)/i.exec(text);
  if (!start) return null;
  const token = start[1].replace(/^["'`]|["'`]$/g, "").replace(/[.,;:]+$/, "");
  if (!/[\\/]/.test(token)) return null; // a path needs a separator
  const base = token.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, ""); // drop an extension, if any
  if (!stem) return null;
  if (UUID_RE.test(stem) || /^[0-9a-f]{16,}$/i.test(stem)) return { opaque: true };
  const title = humanizeStem(stem);
  return title ? { title } : null;
}

/** Extract clean fallback title for Codex sessions, skipping AGENTS/prompt preamble. */
export function extractCodexTitle(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (
    !trimmed ||
    trimmed.startsWith("<") ||
    trimmed.startsWith("# AGENTS.md") ||
    trimmed.startsWith("# CLAUDE.md") ||
    trimmed.startsWith("Base directory for this skill") ||
    trimmed.startsWith("This session is being continued")
  ) {
    return null;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (l && !l.startsWith("#") && !l.startsWith("<")) {
      const handoff = deriveHandoffTitle(l);
      if (handoff) {
        if ("title" in handoff) return handoff.title;
        // Opaque handoff path: return null so caller defaults to project + short ID
        return null;
      }
      const single = l.split(/\s+/).join(" ");
      return single.slice(0, 80) || null;
    }
  }
  return null;
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
