import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ParsedFile, SourceFile, Turn, Wake } from "../core/model";
import { isRead, jsonParse, type AgentSource, type Env } from "./agent-source";

type Fields = Map<number, (number | Uint8Array)[]>;

/** Protobuf wire format, untyped: field number to raw values. Fixed-width fields are skipped. */
export function proto(buf: Uint8Array): Fields {
  const out: Fields = new Map();
  let i = 0;
  const varint = (): number => {
    let value = 0, scale = 1;
    for (;;) {
      const byte = buf[i++];
      value += (byte & 127) * scale;
      scale *= 128;
      if (byte < 128 || i >= buf.length) return value;
    }
  };
  while (i < buf.length) {
    const key = varint(), field = Math.floor(key / 8), wire = key % 8;
    let value: number | Uint8Array;
    if (wire === 0) value = varint();
    else if (wire === 2) { const n = varint(); value = buf.subarray(i, i + n); i += n; }
    else if (wire === 1) { i += 8; continue; }
    else if (wire === 5) { i += 4; continue; }
    else break; // groups are not used here; a stray byte ends the message
    const list = out.get(field);
    if (list) list.push(value); else out.set(field, [value]);
  }
  return out;
}

const int = (f: Fields | null, n: number): number => { const v = f?.get(n)?.[0]; return typeof v === "number" ? v : 0; };
const bytes = (f: Fields | null, n: number): Uint8Array | null => { const v = f?.get(n)?.[0]; return v instanceof Uint8Array ? v : null; };
const sub = (f: Fields | null, n: number): Fields | null => { const b = bytes(f, n); return b ? proto(b) : null; };
const text = (f: Fields | null, n: number): string => { const b = bytes(f, n); return b ? Buffer.from(b).toString("utf8") : ""; };
function packed(b: Uint8Array | null): number[] {
  const out: number[] = [];
  if (!b) return out;
  for (let i = 0; i < b.length;) {
    let value = 0, scale = 1;
    for (;;) { const byte = b[i++]; value += (byte & 127) * scale; scale *= 128; if (byte < 128 || i >= b.length) break; }
    out.push(value);
  }
  return out;
}

const USER_INPUT = 14;
/** agy's own file tools; shell reads go through isRead's command check. */
const READ_TOOLS = new Set(["read_file", "view_file", "list_dir", "find_by_name", "grep_search"]);

/**
 * Antigravity CLI (agy): one SQLite file per conversation, rows of protobuf. Each gen_metadata row is
 * one model call with its usage; the steps it produced carry the time and the tool calls.
 */
export class AgySource implements AgentSource {
  readonly name = "agy" as const;
  constructor(private readonly env: Env) {}
  home(): string { return join(this.env.HOME || homedir(), ".gemini", "antigravity-cli"); }
  base(): string { return this.env.AGY_HOME || this.home(); }
  root(): string { return join(this.base(), "conversations"); }
  readFile(name: string): string | null {
    try { return readFileSync(join(this.base(), name), "utf8"); } catch { return null; }
  }

  files(): SourceFile[] {
    if (!existsSync(this.root())) return [];
    return readdirSync(this.root()).filter((name) => name.endsWith(".db")).flatMap((name) => {
      const path = join(this.root(), name);
      try {
        const db = statSync(path);
        const wal = existsSync(`${path}-wal`) ? statSync(`${path}-wal`) : null;
        return [{ path, mtimeMs: Math.max(db.mtimeMs, wal?.mtimeMs ?? 0), size: db.size + (wal?.size ?? 0) }];
      } catch { return []; }
    });
  }

  parse(path: string): ParsedFile {
    const session = basename(path, ".db");
    const meta = this.summary(session);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000; BEGIN");
      const steps = new Map<number, { type: number; meta: Fields | null }>();
      for (const row of db.prepare("SELECT idx, step_type, metadata FROM steps").iterate())
        steps.set(Number(row.idx), { type: Number(row.step_type), meta: row.metadata instanceof Uint8Array ? proto(row.metadata) : null });
      const turns: Turn[] = [];
      let badLines = 0, last = -1;
      for (const row of db.prepare("SELECT data FROM gen_metadata ORDER BY idx").iterate()) {
        const top = row.data instanceof Uint8Array ? proto(row.data) : null;
        const gen = sub(top, 1), usage = sub(gen, 4);
        const made = packed(bytes(top, 2));
        const first = steps.get(made[0])?.meta ?? null;
        const seconds = int(sub(first, 1), 1);
        if (!usage || !seconds) { badLines++; continue; }
        const wakes: Wake[] = [];
        for (let i = last + 1; i < made[0]; i++) if (steps.get(i)?.type === USER_INPUT) { wakes.push("human"); break; }
        last = made[made.length - 1];
        const calls = made.map((i) => sub(steps.get(i)?.meta ?? null, 4)).filter((c): c is Fields => c !== null);
        const tools = calls.map((c) => text(c, 2));
        turns.push({
          source: this.name, session, project: meta.project, model: text(gen, 19),
          when: new Date(seconds * 1000),
          baseIn: int(usage, 2), cacheRead: int(usage, 5), cacheWrite: int(usage, 4), output: int(usage, 3),
          tools,
          reads: calls.filter((c, k) => READ_TOOLS.has(tools[k]) || isRead(null, jsonParse(text(c, 3))?.CommandLine)).length,
          wakes,
        });
      }
      return { turns, title: meta.title, badLines };
    } finally { db.close(); }
  }

  /** Title and workspace from agy's own index; a conversation it has not indexed yet has neither. */
  private summary(id: string): { title: string | null; project: string } {
    const path = join(this.base(), "conversation_summaries.db");
    if (!existsSync(path)) return { title: null, project: "?" };
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const row = db.prepare("SELECT title, workspace_uris FROM conversation_summaries WHERE conversation_id = ?").get(id) as { title: string; workspace_uris: string } | undefined;
      const uri = (jsonParse(row?.workspace_uris ?? "") as string[] | null)?.[0] ?? "";
      return { title: row?.title || null, project: basename(uri.replace(/^file:\/\//, "")) || "?" };
    } catch { return { title: null, project: "?" }; } finally { db.close(); }
  }
}
