import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { compose, type App } from "../src/compose";
import { MemorySessionRepository } from "../src/repo/memory-repo";
import { SqliteSessionRepository } from "../src/repo/sqlite-repo";
import { buildFull } from "./fixtures/build";
import { fixedNow, harnessEnv, planWeek, tsReport } from "./harness";

const now = fixedNow();

function fixtureApp(dbPath?: string, noCache?: boolean): { app: App; root: string; cacheDir: string } {
  const root = mkdtempSync(join(tmpdir(), "tf-sqlite-test-root-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "tf-sqlite-test-cache-"));
  buildFull(root, now);
  const env = {
    ...harnessEnv(root, now),
    TOKEN_FURNACE_NOW: now.toISOString(),
    XDG_CACHE_HOME: cacheDir,
  };
  const app = compose(env, { noCache });
  return { app, root, cacheDir };
}

function parseLog(app: App): string[] {
  const seen: string[] = [];
  for (const source of app.sources) {
    const parse = source.parse.bind(source);
    source.parse = (path: string) => {
      seen.push(path);
      return parse(path);
    };
  }
  return seen;
}

describe("SqliteSessionRepository", () => {
  it("AC-1: report from SQLite repository equals report from memory repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "tf-ac1-root-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "tf-ac1-cache-"));
    buildFull(root, now);
    const env = {
      ...harnessEnv(root, now),
      TOKEN_FURNACE_NOW: now.toISOString(),
      XDG_CACHE_HOME: cacheDir,
    };

    const week = planWeek(root, now);
    const opts = { weeklyBudget: null, planWeek: week, now };

    // SQLite app
    const sqliteApp = compose(env);
    await sqliteApp.reports.refresh();
    const sqliteReport = sqliteApp.reports.getReport(7, "all", opts);

    // Memory app
    const memoryApp = compose(env, { noCache: true });
    await memoryApp.reports.refresh();
    const memoryReport = memoryApp.reports.getReport(7, "all", opts);

    // Compare with tsReport harness as well
    const expected = tsReport(env, now, 7, null, "all");
    expect(sqliteReport).toEqual(memoryReport);
    expect(sqliteReport).toEqual(expected);
  });

  it("AC-2: warm run parses 0 files, append parses only changed file, deleted file loses rows", async () => {
    const { app, root } = fixtureApp();
    const seen = parseLog(app);

    await app.reports.refresh();
    expect(seen).toHaveLength(4); // initial scan parses 4 files

    // Second run: 0 files parsed
    await app.reports.refresh();
    expect(seen).toHaveLength(4);

    // Append a line to one file
    const targetFile = seen[0];
    appendFileSync(targetFile, `${JSON.stringify({ type: "user", message: { content: "extra line" } })}\n`);
    await app.reports.refresh();
    expect(seen).toHaveLength(5);
    expect(seen[4]).toBe(targetFile);

    // Delete one file
    expect(app.repo.all()).toHaveLength(4);
    rmSync(targetFile, { force: true });
    await app.reports.refresh();
    expect(app.repo.all()).toHaveLength(3);
    expect(app.repo.all().some((s) => s.path === targetFile)).toBe(false);
  });

  it("AC-3: user_version = 0 or garbage bytes rebuilds cache and run succeeds", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "tf-ac3-cache-"));
    const dbPath = join(cacheDir, "token-furnace", "cache.sqlite");

    // 1. Corrupt with user_version = 0
    const repo1 = new SqliteSessionRepository(dbPath);
    const testFile = { path: "/tmp/sample.jsonl", mtimeMs: 100, size: 200 };
    repo1.save(
      { source: "claude", path: testFile.path, mtimeMs: 100, title: "demo", turns: [] },
      testFile.size,
    );
    expect(repo1.all()).toHaveLength(1);
    repo1.close();

    const dbCorrupt = new DatabaseSync(dbPath);
    dbCorrupt.exec("PRAGMA user_version = 0;");
    dbCorrupt.close();

    const repo2 = new SqliteSessionRepository(dbPath);
    // Rebuilt, so previous rows were dropped and run succeeds
    expect(repo2.all()).toHaveLength(0);
    repo2.save(
      { source: "claude", path: testFile.path, mtimeMs: 100, title: "demo", turns: [] },
      testFile.size,
    );
    expect(repo2.all()).toHaveLength(1);
    repo2.close();

    // 2. Corrupt with garbage bytes
    writeFileSync(dbPath, "GARBAGE NOT SQLITE AT ALL !!!");
    const repo3 = new SqliteSessionRepository(dbPath);
    expect(repo3.all()).toHaveLength(0);
    repo3.save(
      { source: "claude", path: testFile.path, mtimeMs: 100, title: "demo", turns: [] },
      testFile.size,
    );
    expect(repo3.all()).toHaveLength(1);
    repo3.close();
  });

  it("AC-4: --no-cache creates no cache file", async () => {
    const { app, cacheDir } = fixtureApp(undefined, true);
    expect(app.repo instanceof MemorySessionRepository).toBe(true);
    await app.reports.refresh();
    const dbFile = join(cacheDir, "token-furnace", "cache.sqlite");
    expect(existsSync(dbFile)).toBe(false);
  });

  it("AC-5: cache holds no message text", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "tf-ac5-cache-"));
    const root = mkdtempSync(join(tmpdir(), "tf-ac5-root-"));
    const SECRET = "SUPER_SECRET_TOKEN_TEXT_12345";
    const lines = [
      JSON.stringify({ type: "custom-title", customTitle: "Regular Title" }),
      JSON.stringify({ type: "user", message: { content: `prompt with ${SECRET}` } }),
      JSON.stringify({
        type: "assistant",
        timestamp: now.toISOString(),
        message: {
          model: "claude-3-5-sonnet-20241022",
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{ type: "text", text: `response with ${SECRET}` }],
        },
      }),
    ];
    const projDir = join(root, "projects", "demo");
    const sessionPath = join(projDir, "session.jsonl");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(sessionPath, `${lines.join("\n")}\n`);

    const env = {
      ...harnessEnv(root, now),
      TOKEN_FURNACE_NOW: now.toISOString(),
      XDG_CACHE_HOME: cacheDir,
    };
    const app = compose(env);
    await app.reports.refresh();

    expect(app.repo.all().flatMap((session) => session.turns)).toHaveLength(1);
    const dbPath = join(cacheDir, "token-furnace", "cache.sqlite");
    expect(existsSync(dbPath)).toBe(true);
    const content = readFileSync(dbPath);
    expect(content.includes(Buffer.from(SECRET))).toBe(false);
  });

  it("AC-6: reopened connection uses WAL/NORMAL pragmas and preserves rows", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "tf-ac6-cache-"));
    const dbPath = join(cacheDir, "token-furnace", "cache.sqlite");
    const session = { source: "claude" as const, path: "/tmp/sample.jsonl", mtimeMs: 100, title: "demo", turns: [] };

    const repo1 = new SqliteSessionRepository(dbPath);
    repo1.save(session, 200);
    expect(repo1.all()).toHaveLength(1);
    repo1.close();

    const repo2 = new SqliteSessionRepository(dbPath);
    const db = (repo2 as unknown as { db: DatabaseSync }).db;
    expect(db).not.toBeNull();
    expect((db!.prepare("PRAGMA journal_mode;").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db!.prepare("PRAGMA synchronous;").get() as { synchronous: number }).synchronous).toBe(1);
    expect(repo2.all()).toHaveLength(1);
    repo2.close();
  });
});
