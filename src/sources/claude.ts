import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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

/** Claude Code transcripts under $CLAUDE_CONFIG_DIR/projects (default ~/.claude). burn.py:122-211 */
export class ClaudeSource implements AgentSource {
  readonly name = "claude" as const;

  constructor(private readonly env: Env) {}

  private base(): string {
    return this.env.CLAUDE_CONFIG_DIR || join(this.env.HOME || homedir(), ".claude");
  }

  root(): string {
    return join(this.base(), "projects");
  }

  files(): SourceFile[] {
    const root = this.root();
    const out: SourceFile[] = [];
    for (const project of readDirSafe(root)) {
      for (const name of readDirSafe(join(root, project))) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(root, project, name);
        try {
          const stat = statSync(path);
          out.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          continue;
        }
      }
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  parse(path: string): ParsedFile {
    const lines = readLines(path);
    return {
      turns: this.turns(path, lines),
      title: this.title(lines),
      badLines: badLines(lines),
    };
  }

  /** The session's latest custom or generated title, else its first prompt, or null. burn.py:141 */
  private title(lines: string[]): string | null {
    let title: string | null = null;
    let first: string | null = null;
    for (const line of lines) {
      const titled = line.includes('"customTitle"') || line.includes('"aiTitle"');
      if (!titled && !first && !line.includes('"user"')) continue;
      const record = jsonParse(line);
      if (record === null) continue;
      if (titled) {
        const value = record.customTitle || record.aiTitle;
        if (value) title = String(value);
      } else if (record.type === "user" && !record.isMeta) {
        const content = record.message?.content;
        if (typeof content === "string" && !content.startsWith("<local-command")) {
          const command = /<command-name>(.*?)<\/command-name>/.exec(content);
          const args = /<command-args>(.*?)<\/command-args>/s.exec(content);
          const text = command ? `${command[1]} ${args ? args[1] : ""}` : content;
          first = text.split(/\s+/).join(" ").trim().slice(0, 80) || null;
        }
      }
    }
    return title ?? first;
  }

  /** burn.py:168 */
  private turns(path: string, lines: string[]): Turn[] {
    // The directory name encodes the whole path; the record's cwd names the project.
    let project = basename(dirname(path));
    const session = basename(path).slice(0, -6);
    const turns: Turn[] = [];
    let wakes: Wake[] = [];
    for (const line of lines) {
      if (!candidate(line)) continue;
      const record = jsonParse(line);
      if (record === null) continue;
      project = basename(String(record.cwd || "").replace(/\/+$/, "")) || project;
      if (record.type === "user") {
        const kind = userWake(record);
        if (kind) wakes.push(kind);
        continue;
      }
      if (record.type !== "assistant") continue;
      const when = parseTime(record.timestamp);
      if (when === null) continue;
      const message = record.message || {};
      const usage = message.usage;
      if (!usage || Object.keys(usage).length === 0) continue;
      const calls = (message.content || []).filter(
        (block: any) => block && typeof block === "object" && block.type === "tool_use",
      );
      turns.push({
        source: "claude",
        project,
        session,
        model: String(message.model ?? ""),
        when,
        baseIn: num(usage.input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        output: num(usage.output_tokens),
        tools: calls.map((block: any) => String(block.name ?? "")),
        reads: calls.filter((block: any) => isRead(block.name, block.input?.command)).length,
        wakes,
      });
      wakes = [];
    }
    return turns;
  }
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n");
}

/** A line the Claude parsers look at: an assistant record, or a user record without a tool result. */
function candidate(line: string): boolean {
  const isUser = line.includes('"user"') && !line.includes('"tool_result"');
  return line.includes('"assistant"') || isUser;
}

/** Transcript lines a parser tried to read and could not. A bad line never stops the scan. */
function badLines(lines: string[]): number {
  let bad = 0;
  for (const line of lines) {
    const titled = line.includes('"customTitle"') || line.includes('"aiTitle"');
    if (!titled && !candidate(line)) continue;
    if (jsonParse(line) === null) bad += 1;
  }
  return bad;
}

/** What a user record means, or null for harness noise. burn.py:131 */
function userWake(record: Record<string, any>): Wake | null {
  if (record.isMeta) return null;
  let content = record.message?.content;
  if (Array.isArray(content)) {
    content = content
      .filter((block: any) => block && typeof block === "object" && block.type === "text")
      .map((block: any) => block.text ?? "")
      .join(" ");
  }
  return typeof content === "string" ? classifyPrompt(content) : null;
}