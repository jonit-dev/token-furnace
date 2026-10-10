import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ParsedFile, SourceFile, Turn, Wake } from "../core/model";
import {
  classifyPrompt,
  isRead,
  jsonParse,
  num,
  parseTime,
  readDirSafe,
  type AgentSource,
  type Env,
} from "./agent-source";

const ROLLOUT = /^rollout-.*\.jsonl$/;

/** Codex transcripts under $CODEX_HOME/sessions (default ~/.codex). burn.py:212-282 */
export class CodexSource implements AgentSource {
  readonly name = "codex" as const;

  constructor(private readonly env: Env) {}

  private base(): string {
    return this.env.CODEX_HOME || join(this.env.HOME || homedir(), ".codex");
  }

  root(): string {
    return join(this.base(), "sessions");
  }

  files(): SourceFile[] {
    const out: SourceFile[] = [];
    walk(this.root(), out);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * Codex logs usage in event_msg/token_count and tool calls in separate records.
   *
   * input_tokens already includes the cached portion, unlike Claude Code, so base input is
   * the difference. Reasoning tokens bill as output.
   */
  parse(path: string): ParsedFile {
    const lines = readLines(path);
    let project = "?";
    let session = basename(path);
    let model = "";
    let pendingTools: string[] = [];
    let pendingReads = 0;
    let wakes: Wake[] = [];
    const turns: Turn[] = [];
    let bad = 0;

    for (const line of lines) {
      const record = jsonParse(line);
      if (record === null) {
        if (line.trim() !== "") bad += 1;
        continue;
      }
      const payload = record.payload || {};
      const kind = record.type;

      if (kind === "session_meta") {
        project = basename(String(payload.cwd || "").replace(/\/+$/, "")) || project;
        session = String(payload.id || session).slice(0, 8);
        continue;
      }
      if (kind === "turn_context") {
        model = String(payload.model || model);
        continue;
      }
      if (payload.type === "function_call") {
        pendingTools.push(String(payload.name ?? ""));
        pendingReads += isRead(null, payload.arguments) ? 1 : 0;
        continue;
      }
      if (payload.type === "user_message") {
        const wake = classifyPrompt(String(payload.message || ""));
        if (wake) wakes.push(wake);
        continue;
      }
      if (payload.type !== "token_count") continue;

      const usage = payload.info?.last_token_usage;
      if (!usage || Object.keys(usage).length === 0) continue;
      const when = parseTime(record.timestamp);
      if (when === null) continue;
      const cached = num(usage.cached_input_tokens);
      const tools = pendingTools;
      const reads = pendingReads;
      pendingTools = [];
      pendingReads = 0;
      turns.push({
        source: "codex",
        project,
        session,
        model,
        when,
        baseIn: Math.max(num(usage.input_tokens) - cached, 0),
        cacheRead: cached,
        cacheWrite: 0,
        output: num(usage.output_tokens) + num(usage.reasoning_output_tokens),
        tools,
        reads,
        wakes,
      });
      wakes = [];
    }
    return { turns, title: null, badLines: bad };
  }
}

function walk(dir: string, out: SourceFile[]): void {
  for (const name of readDirSafe(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) {
        walk(path, out);
      } else if (ROLLOUT.test(name)) {
        const stat = statSync(path);
        out.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch {
      continue;
    }
  }
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n");
}