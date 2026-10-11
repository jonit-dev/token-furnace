import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ActivityTurn, SessionInput, Source, SourceFile, Turn, Wake } from "../core/model";
import type { SessionRepository } from "./session-repo";
import { PROVIDERS } from "../core/providers";

const SCHEMA_VERSION = 1;

const DDL = `
PRAGMA foreign_keys = ON;
PRAGMA user_version = ${SCHEMA_VERSION};

CREATE TABLE files (
  path        TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  mtime_ns    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  title       TEXT,
  bad_lines   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE turns (
  path        TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  project     TEXT NOT NULL,
  session     TEXT NOT NULL,
  model       TEXT NOT NULL,
  at          INTEGER NOT NULL,
  base_in     INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  tools       TEXT NOT NULL,
  reads       INTEGER NOT NULL,
  wakes       TEXT NOT NULL,
  PRIMARY KEY (path, seq)
);
CREATE INDEX turns_at ON turns(at);
`;

interface FileRow {
  path: string;
  source: string;
  mtime_ns: number;
  size: number;
  title: string | null;
  bad_lines: number;
  parser_version: number;
}

interface TurnRow {
  path: string;
  seq: number;
  project: string;
  session: string;
  model: string;
  at: number;
  base_in: number;
  cache_read: number;
  cache_write: number;
  output: number;
  tools: string;
  reads: number;
  wakes: string;
}

export class SqliteSessionRepository implements SessionRepository {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;
  private stmtDeleteFile: StatementSync | null = null;
  private stmtInsertFile: StatementSync | null = null;
  private stmtInsertTurn: StatementSync | null = null;
  private stmtAllFiles: StatementSync | null = null;
  private stmtAllTurns: StatementSync | null = null;
  private stmtAllTurnsSince: StatementSync | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.ensureDb();
  }

  private prepareStatements(): void {
    if (!this.db) return;
    const columns = this.db.prepare("PRAGMA table_info(files);").all() as { name: string }[];
    if (!columns.some((column) => column.name === "parser_version")) {
      this.db.exec("ALTER TABLE files ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0;");
    }
    this.stmtDeleteFile = this.db.prepare("DELETE FROM files WHERE path = ?;");
    this.stmtInsertFile = this.db.prepare(
      "INSERT INTO files (path, source, mtime_ns, size, title, bad_lines, parser_version) VALUES (?, ?, ?, ?, ?, 0, ?);",
    );
    this.stmtInsertTurn = this.db.prepare(
      "INSERT INTO turns (path, seq, project, session, model, at, base_in, cache_read, cache_write, output, tools, reads, wakes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    );
    this.stmtAllFiles = this.db.prepare("SELECT path, source, mtime_ns, size, title, bad_lines, parser_version FROM files;");
    this.stmtAllTurns = this.db.prepare(
      "SELECT path, seq, project, session, model, at, base_in, cache_read, cache_write, output, tools, reads, wakes FROM turns ORDER BY path, seq;",
    );
    this.stmtAllTurnsSince = this.db.prepare(
      "SELECT path, seq, project, session, model, at, base_in, cache_read, cache_write, output, tools, reads, wakes FROM turns WHERE at >= ? ORDER BY path, seq;",
    );
  }

  private openDb(path: string): DatabaseSync {
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA synchronous = NORMAL;");
      if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private ensureDb(): void {
    if (this.db) return;
    try {
      if (this.dbPath !== ":memory:") {
        mkdirSync(dirname(this.dbPath), { recursive: true });
      }
      const db = this.openDb(this.dbPath);
      const verRow = db.prepare("PRAGMA user_version;").get() as { user_version: number } | undefined;
      const ver = verRow ? verRow.user_version : 0;
      if (ver !== SCHEMA_VERSION) {
        db.close();
        this.recreateDb();
        return;
      }
      this.db = db;
      this.prepareStatements();
    } catch {
      this.recreateDb();
    }
  }

  private recreateDb(): void {
    try {
      if (this.dbPath !== ":memory:" && existsSync(this.dbPath)) {
        rmSync(this.dbPath, { force: true });
        rmSync(`${this.dbPath}-wal`, { force: true });
        rmSync(`${this.dbPath}-shm`, { force: true });
      }
    } catch {
      // ignore deletion errors
    }
    try {
      if (this.dbPath !== ":memory:") {
        mkdirSync(dirname(this.dbPath), { recursive: true });
      }
      const db = this.openDb(this.dbPath);
      db.exec(DDL);
      this.db = db;
      this.prepareStatements();
    } catch {
      try {
        const memDb = this.openDb(":memory:");
        memDb.exec(DDL);
        this.db = memDb;
        this.prepareStatements();
      } catch {
        this.db = null;
      }
    }
  }

  changed(files: SourceFile[]): SourceFile[] {
    this.ensureDb();
    if (!this.db || !this.stmtAllFiles || !this.stmtDeleteFile) return files;

    const seen = new Set<string>();
    const out: SourceFile[] = [];

    const cachedFiles = new Map<string, FileRow>();
    for (const row of this.stmtAllFiles.all() as unknown as FileRow[]) {
      cachedFiles.set(row.path, row);
    }

    for (const file of files) {
      seen.add(file.path);
      const held = cachedFiles.get(file.path);
      if (held && held.mtime_ns === file.mtimeMs && held.size === file.size &&
          held.parser_version === PROVIDERS[held.source as Source]?.parserVersion) continue;
      out.push(file);
    }

    for (const path of cachedFiles.keys()) {
      if (!seen.has(path)) {
        this.stmtDeleteFile.run(path);
      }
    }

    return out;
  }

  *activity(): Iterable<ActivityTurn> {
    this.ensureDb();
    if (!this.db) return;
    const rows = this.db.prepare(`
      SELECT files.source, turns.project, turns.session, turns.at
      FROM turns JOIN files ON files.path = turns.path
      WHERE base_in + cache_read + cache_write > 0 ORDER BY at
    `).all() as unknown as ActivityTurn[];
    for (const row of rows) yield row as unknown as ActivityTurn;
  }

  all(cutoff?: Date): SessionInput[] {
    this.ensureDb();
    if (!this.db || !this.stmtAllFiles || !this.stmtAllTurns) return [];

    const ms = cutoff?.getTime();
    const filtered = ms !== undefined && !Number.isNaN(ms);
    const fileRows = this.stmtAllFiles.all() as unknown as FileRow[];
    const turnRows = (filtered && this.stmtAllTurnsSince
      ? this.stmtAllTurnsSince.iterate(ms)
      : this.stmtAllTurns.iterate()) as unknown as Iterable<TurnRow>;

    const turnsByPath = new Map<string, Turn[]>();
    for (const r of turnRows) {
      let list = turnsByPath.get(r.path);
      if (!list) {
        list = [];
        turnsByPath.set(r.path, list);
      }
      list.push({
        source: "claude",
        project: r.project,
        session: r.session,
        model: r.model,
        when: new Date(r.at),
        baseIn: r.base_in,
        cacheRead: r.cache_read,
        cacheWrite: r.cache_write,
        output: r.output,
        tools: JSON.parse(r.tools) as string[],
        reads: r.reads,
        wakes: JSON.parse(r.wakes) as Wake[],
      });
    }

    return fileRows.map((f) => {
      const source = f.source as Source;
      const turns = (turnsByPath.get(f.path) ?? []).map((t) => ({ ...t, source }));
      return {
        source,
        path: f.path,
        mtimeMs: f.mtime_ns,
        title: f.title,
        turns,
      };
    });
  }

  save(session: SessionInput, size: number): void {
    this.ensureDb();
    if (!this.db || !this.stmtDeleteFile || !this.stmtInsertFile || !this.stmtInsertTurn) return;

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.stmtDeleteFile.run(session.path);
      this.stmtInsertFile.run(session.path, session.source, session.mtimeMs, size, session.title ?? null, PROVIDERS[session.source].parserVersion);

      for (let seq = 0; seq < session.turns.length; seq++) {
        const t = session.turns[seq];
        this.stmtInsertTurn.run(
          session.path,
          seq,
          t.project,
          t.session,
          t.model,
          t.when.getTime(),
          t.baseIn,
          t.cacheRead,
          t.cacheWrite,
          t.output,
          JSON.stringify(t.tools),
          t.reads,
          JSON.stringify(t.wakes),
        );
      }
      this.db.exec("COMMIT;");
    } catch {
      this.db.exec("ROLLBACK;");
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      this.db = null;
    }
  }
}
