import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ParsedFile, SourceFile, Turn, Wake, Week } from "../core/model";
import {
  classifyPrompt,
  extractCodexTitle,
  isRead,
  jsonParse,
  num,
  parseTime,
  readDirSafe,
  type AgentSource,
  type Env,
} from "./agent-source";
import { isIgnoredOutput } from "./ignored-output";
import { lines } from "./lines";

const ROLLOUT = /^rollout-.*\.jsonl$/;

/** Codex transcripts under $CODEX_HOME/sessions (default ~/.codex). burn.py:212-282 */
export class CodexSource implements AgentSource {
  readonly name = "codex" as const;

  constructor(private readonly env: Env) {}

  base(): string {
    return this.env.CODEX_HOME || join(this.env.HOME || homedir(), ".codex");
  }

  home(): string {
    return join(this.env.HOME || homedir(), ".codex");
  }

  readFile(name: string): string | null {
    try {
      return readFileSync(join(this.base(), name), "utf8");
    } catch {
      return null;
    }
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
   * Reads $CODEX_HOME/session_index.jsonl if present and returns Map<fullId, thread_name>.
   * Append-only format; later entries win.
   */
  sessionMetadata(): Map<string, string> {
    const out = new Map<string, string>();
    const content = this.readFile("session_index.jsonl");
    if (!content) return out;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const record = jsonParse(line);
      if (record && typeof record.id === "string" && typeof record.thread_name === "string") {
        const title = record.thread_name.trim();
        if (title) {
          out.set(record.id, title);
        }
      }
    }
    return out;
  }

  /**
   * Codex logs usage in event_msg/token_count and tool calls in separate records.
   *
   * input_tokens already includes the cached portion, unlike Claude Code, so base input is
   * the difference. output_tokens already includes reasoning tokens.
   */
  parse(path: string): ParsedFile {
    let project = "?";
    let session = basename(path);
    let model = "";
    let pendingTools: string[] = [];
    let pendingReads = 0;
    let wakes: Wake[] = [];
    let messageWakes: [string, Wake][] = [];
    let title: string | null = null;
    const eventMessages = new Map<string, number>();
    const seenCalls = new Set<string>();
    let lastTotal: number | null = null;
    const turns: Turn[] = [];
    let bad = 0;

    for (const line of lines(path, isIgnoredOutput)) {
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
      if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        if (typeof payload.call_id === "string") seenCalls.add(payload.call_id);
        pendingTools.push(String(payload.name ?? ""));
        const raw = payload.arguments ?? payload.input;
        const args = typeof raw === "string" ? jsonParse(raw) : null;
        const command = args?.cmd ?? args?.command ?? raw;
        pendingReads += (Array.isArray(command) ? command.some((c) => isRead(null, c)) : isRead(null, command)) ? 1 : 0;
        continue;
      }
      if (payload.type === "item_completed" && payload.item?.type === "CommandExecution") {
        const item = payload.item;
        if (typeof item.id === "string") {
          if (seenCalls.has(item.id)) continue;
          seenCalls.add(item.id);
        }
        // Code-mode wrappers log the commands they actually executed separately.
        pendingTools.push("exec_command");
        const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
        const shellCommand = Array.isArray(item.command) && item.command.some((arg: unknown) => typeof arg === "string" && ["-lc", "-c", "-command"].includes(arg.toLowerCase()))
          ? item.command.at(-1) : command;
        pendingReads += isRead(null, shellCommand) ? 1 : 0;
        continue;
      }
      if (kind === "response_item" && payload.type === "message" && payload.role === "user") {
        const text = Array.isArray(payload.content)
          ? payload.content.map((c: any) => typeof c.text === "string" ? c.text : "").join("\n")
          : "";
        if (!title && Array.isArray(payload.content)) {
          for (const c of payload.content) {
            if (typeof c?.text === "string") {
              const candidate = extractCodexTitle(c.text);
              if (candidate) {
                title = candidate;
                break;
              }
            }
          }
        }
        const wake = classifyPrompt(text);
        if (wake) messageWakes.push([text.trim(), wake]);
        continue;
      }
      if (payload.type === "user_message") {
        const text = String(payload.message || "").trim();
        if (!title) {
          title = extractCodexTitle(text);
        }
        const wake = classifyPrompt(text);
        if (wake) wakes.push(wake);
        eventMessages.set(text, (eventMessages.get(text) ?? 0) + 1);
        continue;
      }
      if (payload.type !== "token_count") continue;

      const usage = payload.info?.last_token_usage;
      if (!usage || Object.keys(usage).length === 0) continue;
      const when = parseTime(record.timestamp);
      if (when === null) continue;
      const total = payload.info?.total_token_usage?.total_tokens;
      if (typeof total === "number" && Number.isFinite(total)) {
        if (total === lastTotal) continue; // Quota updates can repeat the previous turn's usage.
        lastTotal = total;
      }
      const cached = num(usage.cached_input_tokens);
      const tools = pendingTools;
      const reads = pendingReads;
      pendingTools = [];
      pendingReads = 0;
      for (const [text, wake] of messageWakes) {
        const matching = eventMessages.get(text) ?? 0;
        if (matching) eventMessages.set(text, matching - 1);
        else wakes.push(wake);
      }
      turns.push({
        source: "codex",
        project,
        session,
        model,
        when,
        baseIn: Math.max(num(usage.input_tokens) - cached, 0),
        cacheRead: cached,
        cacheWrite: 0,
        output: num(usage.output_tokens),
        tools,
        reads,
        wakes,
      });
      wakes = [];
      messageWakes = [];
      eventMessages.clear();
    }
    return { turns, title, badLines: bad };
  }

  /**
   * Codex's 7-day window from the rate_limits it logs in each session; null when unknown. No
   * network. burn.py:926
   *
   * Scans the newest rollouts until a live reading turns up: the most recently touched file is
   * often a non-subscription (eval/tooling) session that logs no rate_limits at all.
   */
  week(now: Date): Week | null {
    return this.weekReading(now);
  }

  weekReading(now: Date): Week | null {
    const files = [...this.files()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 200);
    for (const file of files) {
      for (const line of tail(file.path, file.size).reverse()) {
        if (!line.includes('"rate_limits"')) continue;
        const record = jsonParse(line);
        const limits = record?.payload?.rate_limits;
        const week = [limits?.primary, limits?.secondary].find(
          (w: any) => w && w.window_minutes === 10080,
        );
        const resets = epoch(week?.resets_at);
        if (resets === null) continue;
        if (resets <= now.getTime()) break; // this file's newest reading ended; try an older one
        const observedAt = parseTime(record?.timestamp) ?? new Date(file.mtimeMs);
        const used = Number(week.used_percent);
        if (!Number.isFinite(used) || !Number.isFinite(observedAt.getTime())) continue;
        return {
          start: new Date(resets - 7 * 86_400_000),
          resets: new Date(resets),
          used,
          observedAt,
          window: "7d",
          account: typeof limits?.account_id === "string" ? limits.account_id : null,
          authoritative: true,
        };
      }
    }
    return null;
  }
}

function epoch(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;
}

/** The last 256 KB of a rollout, oldest line first; callers walk it newest first, like burn.py:936. */
function tail(path: string, size: number): string[] {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, 262_144));
    const read = readSync(handle, buffer, 0, buffer.length, Math.max(size - buffer.length, 0));
    return buffer.toString("utf8", 0, read).split("\n");
  } finally {
    closeSync(handle);
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
