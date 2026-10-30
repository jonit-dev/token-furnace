import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ParsedFile, ProviderId, SourceFile, Turn, Wake } from "../core/model";
import {
  classifyPrompt,
  deriveHandoffTitle,
  isRead,
  jsonParse,
  num,
  parseTime,
  readDirSafe,
  type AgentSource,
  type Env,
} from "./agent-source";
import { defaultClaudeInstall, type ClaudeInstall } from "./claude-installs";
import { lines } from "./lines";

/** Claude Code transcripts under $CLAUDE_CONFIG_DIR/projects (default ~/.claude). burn.py:122-211 */
export class ClaudeSource implements AgentSource {
  readonly kind = "claude" as const;
  readonly name: ProviderId;
  readonly label: string;
  readonly install: ClaudeInstall;

  constructor(installOrEnv: ClaudeInstall | Env) {
    const install = typeof (installOrEnv as Partial<ClaudeInstall>).id === "string"
      ? installOrEnv as ClaudeInstall
      : defaultClaudeInstall(installOrEnv as Env);
    this.install = install;
    this.name = install.id;
    this.label = install.label;
  }

  /** CLAUDE_CONFIG_DIR, or ~/.claude. burn.py:122 */
  base(): string {
    return this.install.dir;
  }

  home(): string {
    return this.install.dir;
  }

  readFile(name: string): string | null {
    try {
      return readFileSync(join(this.base(), name), "utf8");
    } catch {
      return null;
    }
  }

  /** Every MEMORY.md under projects, with its line count. burn.py:502 */
  memoryIndexes(): { path: string; lines: number }[] {
    const root = this.root();
    const out: { path: string; lines: number }[] = [];
    for (const project of readDirSafe(root)) {
      const path = join(root, project, "memory", "MEMORY.md");
      let text: string | null = null;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      out.push({ path, lines: countLines(text) });
    }
    return out;
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

  /**
   * One streaming pass: turns, title and bad lines together. burn.py:141, 168
   *
   * A transcript can reach 300 MB, so the file is never held in memory.
   */
  parse(path: string): ParsedFile {
    // The directory name encodes the whole path; the record's cwd names the project.
    let project = basename(dirname(path));
    const session = basename(path).slice(0, -6);
    const turns: Turn[] = [];
    let wakes: Wake[] = [];
    let title: string | null = null;
    let first: string | null = null;
    let bad = 0;

    for (const line of lines(path)) {
      const titled = line.includes('"customTitle"') || line.includes('"aiTitle"');
      const isCandidate = candidate(line);
      const isUser = line.includes('"user"');
      // Once `first` is set, later user lines are ignored: the first prompt is the title.
      const wantsTitle = titled || (first === null && isUser);
      if (!wantsTitle && !isCandidate) continue;
      const record = jsonParse(line);
      if (record === null) {
        if (titled || isCandidate) bad += 1; // a bad line is counted once, never fatal
        continue;
      }
      if (titled) {
        const value = record.customTitle || record.aiTitle;
        if (value) title = String(value);
      }
      if (wantsTitle && !titled && record.type === "user" && !record.isMeta) {
        first = userTitle(record) ?? first;
      }
      if (!isCandidate) continue;
      project = basename(String(record.cwd || "").replace(/\/+$/, "")) || project;
      if (record.type === "user") {
        const kind = userWake(record);
        if (kind) wakes.push(kind);
        continue;
      }
      if (record.type !== "assistant") continue;
      const turn = assistantTurn(record, project, session, wakes, this.name);
      if (turn) {
        turns.push(turn);
        wakes = [];
      }
    }
    return { turns, title: title ?? first, badLines: bad };
  }
}

/** The session title from a user record, or null. burn.py:141 */
function userTitle(record: Record<string, any>): string | null {
  const content = record.message?.content;
  if (typeof content !== "string" || content.startsWith("<local-command")) return null;
  const command = /<command-name>(.*?)<\/command-name>/.exec(content);
  const args = /<command-args>(.*?)<\/command-args>/s.exec(content);
  const text = command ? `${command[1]} ${args ? args[1] : ""}` : content;
  const handoff = deriveHandoffTitle(text);
  if (handoff) return "title" in handoff ? handoff.title : null;
  return text.split(/\s+/).join(" ").trim().slice(0, 80) || null;
}

/** One assistant record as a Turn, or null when it carries no usage. burn.py:168 */
function assistantTurn(
  record: Record<string, any>,
  project: string,
  session: string,
  wakes: Wake[],
  source: ProviderId,
): Turn | null {
  const when = parseTime(record.timestamp);
  if (when === null) return null;
  const message = record.message || {};
  const usage = message.usage;
  if (!usage || Object.keys(usage).length === 0) return null;
  const calls = (message.content || []).filter(
    (block: any) => block && typeof block === "object" && block.type === "tool_use",
  );
  return {
    source,
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
  };
}

/** Python counts lines by iterating the file, so a last line without a newline still counts. */
function countLines(text: string): number {
  const parts = text.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

/** A line the Claude parsers look at: an assistant record, or a user record without a tool result. */
function candidate(line: string): boolean {
  const isUser = line.includes('"user"') && !line.includes('"tool_result"');
  return line.includes('"assistant"') || isUser;
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
