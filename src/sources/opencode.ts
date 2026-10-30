import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ParsedFile, SourceFile, Turn, Wake } from "../core/model";
import { isRead, jsonParse, num, type AgentSource, type Env } from "./agent-source";

/** OpenCode's current SQLite store. Connections are read-only, including live WAL data. */
export class OpenCodeSource implements AgentSource {
  readonly name = "opencode" as const;
  readonly kind = "opencode" as const;
  readonly label = "OpenCode";
  constructor(private readonly env: Env) {}
  home(): string { return join(this.env.XDG_DATA_HOME || join(this.env.HOME || homedir(), ".local", "share"), "opencode"); }
  base(): string { return this.env.OPENCODE_DATA_DIR || this.home(); }
  root(): string { return join(this.base(), "opencode.db"); }
  readFile(name: string): string | null {
    try { return readFileSync(join(this.base(), name), "utf8"); } catch { return null; }
  }

  // Virtual session paths use a row count for size: cache invalidation needs no text payloads.
  files(): SourceFile[] {
    if (!existsSync(this.root())) return [];
    return this.read((db) => (db.prepare(`SELECT s.id,
      max(s.time_updated, coalesce((SELECT max(time_updated) FROM message WHERE session_id = s.id), 0),
        coalesce((SELECT max(time_updated) FROM part WHERE session_id = s.id), 0)) AS updated,
      (SELECT count(*) FROM message WHERE session_id = s.id) +
        (SELECT count(*) FROM part WHERE session_id = s.id) AS size
      FROM session s ORDER BY s.id`).all() as unknown as { id: string; updated: number; size: number }[])
      .map((row) => ({ path: `${this.root()}#${encodeURIComponent(row.id)}`, mtimeMs: row.updated, size: row.size })));
  }

  parse(path: string): ParsedFile {
    const prefix = `${this.root()}#`;
    if (!path.startsWith(prefix)) throw new Error("Invalid OpenCode session path");
    const id = decodeURIComponent(path.slice(prefix.length));
    return this.read((db) => {
      const session = db.prepare("SELECT directory, title FROM session WHERE id = ?").get(id) as { directory: string; title: string } | undefined;
      if (!session) return { turns: [], title: null, badLines: 0 };
      const messages = db.prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id");
      // Project only tool metadata: large text/tool outputs never enter the parser or cache.
      const parts = db.prepare(`SELECT json_extract(data, '$.tool') AS tool,
        json_extract(data, '$.state.input.command') AS command FROM part
        WHERE message_id = ? AND CASE WHEN json_valid(data) THEN json_extract(data, '$.type') = 'tool' ELSE 0 END ORDER BY id`);
      const turns: Turn[] = [];
      let wakes: Wake[] = [], badLines = 0;
      for (const row of messages.iterate(id)) {
        const data = jsonParse(String(row.data));
        if (!data) { badLines++; continue; }
        if (data.role === "user") { wakes.push("human"); continue; }
        if (data.role !== "assistant" || !data.tokens) continue;
        const usage = data.tokens;
        const when = new Date(data.time?.created ?? Number(row.time_created));
        if (!Number.isFinite(+when)) { badLines++; continue; }
        const calls = parts.all(row.id);
        turns.push({ source: this.name, session: id, project: basename(session.directory || "") || "?",
          model: data.providerID ? `${data.providerID}/${data.modelID ?? ""}` : String(data.modelID ?? ""), when, baseIn: num(usage.input),
          cacheRead: num(usage.cache?.read), cacheWrite: num(usage.cache?.write),
          output: num(usage.output) + num(usage.reasoning),
          tools: calls.map((call) => String(call.tool ?? "")),
          reads: calls.filter((call) => isRead(call.tool, call.command)).length, wakes });
        wakes = [];
      }
      return { turns, title: session.title || null, badLines };
    });
  }

  private read<T>(run: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.root(), { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 5000; BEGIN"); return run(db); } finally { db.close(); }
  }
}
