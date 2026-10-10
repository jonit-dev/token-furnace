import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteSessionRepository } from "../src/repo/sqlite-repo";
import { compose } from "../src/compose";
import { OpenCodeSource } from "../src/sources/opencode";
import { openCodeWeek } from "../src/services/usage-client";

const roots: string[] = [];
const now = new Date("2026-10-10T20:00:00Z");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tf-opencode-")); roots.push(root);
  const base = join(root, "opencode"); mkdirSync(base);
  const db = new DatabaseSync(join(base, "opencode.db"));
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_updated INTEGER, data TEXT);`);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_demo", "/srv/demo", "OpenCode fixture", +now);
  const message = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  message.run("user", "ses_demo", +now - 2, +now - 2, JSON.stringify({ role: "user" }));
  message.run("assistant", "ses_demo", +now - 1, +now, JSON.stringify({ role: "assistant", providerID: "opencode-go", modelID: "gpt-5.5", time: { created: +now - 1 }, tokens: { input: 1000, output: 20, reasoning: 10, cache: { read: 2000, write: 30 } } }));
  const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
  part.run("a-read", "assistant", "ses_demo", +now, JSON.stringify({ type: "tool", tool: "read", state: { input: {} } }));
  part.run("b-bash", "assistant", "ses_demo", +now, JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "rg needle src" } } }));
  part.run("finish", "assistant", "ses_demo", +now, JSON.stringify({ type: "step-finish", tokens: { input: 1000 } }));
  const env = { HOME: root, OPENCODE_DATA_DIR: base, TOKEN_FURNACE_NOW: now.toISOString(), TOKEN_FURNACE_WORKERS: "0" };
  return { db, env, source: new OpenCodeSource(env) };
}
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("normalizes assistant usage once, including reasoning, cache, tools and prompt wakes", () => {
  const { db, source } = fixture();
  const files = source.files(); expect(files).toHaveLength(1);
  const parsed = source.parse(files[0].path);
  expect(parsed.title).toBe("OpenCode fixture");
  expect(parsed.turns).toHaveLength(1);
  expect(parsed.turns[0]).toMatchObject({ source: "opencode", project: "demo", session: "ses_demo", baseIn: 1000, cacheRead: 2000, cacheWrite: 30, output: 30, tools: ["read", "bash"], reads: 2, wakes: ["human"] });
  expect(db.prepare("SELECT count(*) AS n FROM part").get()?.n).toBe(3);
  db.close();
});

it("flows through reports and persistent cache, invalidates changed messages and deletes removed sessions", async () => {
  const { db, env, source } = fixture(); const app = compose(env);
  await app.reports.refresh();
  const report = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: { start: new Date(+now - 86_400_000), resets: new Date(+now + 6 * 86_400_000), used: 63 } });
  expect(report?.turns).toBe(1); expect(report?.burns.opencode?.used).toBe(63);
  const before = source.files()[0];
  db.prepare("UPDATE message SET time_updated = ? WHERE id = 'assistant'").run(+now + 1000);
  expect(source.files()[0].mtimeMs).toBeGreaterThan(before.mtimeMs);
  db.exec("DELETE FROM session"); await app.reports.refresh();
  expect(app.reports.getReport(7, "opencode", { weeklyBudget: null, now })).toBeNull();
  (app.repo as SqliteSessionRepository).close(); db.close();
});

it("handles absent installs without creating a database and respects XDG data paths", () => {
  const root = mkdtempSync(join(tmpdir(), "tf-opencode-")); roots.push(root);
  const source = new OpenCodeSource({ HOME: root, XDG_DATA_HOME: join(root, "data") });
  expect(source.base()).toBe(join(root, "data", "opencode")); expect(source.files()).toEqual([]);
});

it("reads Go weekly quota, reuses the reading, and handles expired or invalid readings safely", async () => {
  const { db, env } = fixture();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(env.OPENCODE_DATA_DIR, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "test-secret" } }));
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ usage: { weekly: { percent: 63, resetsAt: "2026-10-12T00:00:00Z" } } }) });
  vi.stubGlobal("fetch", fetcher);
  const week = await openCodeWeek(env, now, true);
  expect(week?.used).toBe(63); expect(week?.resets.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  expect(fetcher.mock.calls[0][0]).toBe("https://opencode.ai/zen/go/v1/usage");
  expect(await openCodeWeek(env, now, false)).toEqual(week);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await openCodeWeek(env, new Date("2026-11-01"), false)).toBeNull();
  db.close();
});

it("parses SQLite sessions through the built worker and serves OpenCode-filtered HTTP reports", async () => {
  const { db, env, source } = fixture();
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const { ReportService } = await import("../src/services/report-service");
  const { MemorySessionRepository } = await import("../src/repo/memory-repo");
  const { startServer } = await import("../src/server");
  source.parse = () => { throw new Error("Main thread must not parse this session"); };
  const repo = new MemorySessionRepository();
  const reports = new ReportService([source], repo, env, { url: pathToFileURL(resolve("dist/scan-worker.js")), size: 2 });
  await reports.refresh();
  expect(reports.getReport(7, "opencode", { weeklyBudget: null, now })?.turns).toBe(1);
  const app = compose(env, { noCache: true });
  await app.reports.refresh();
  const server = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
  try {
    const response = await fetch(`${server.url}/api/report?source=opencode`);
    expect(response.status).toBe(200);
    const report = await response.json() as import("../src/core/model").Report;
    expect(report.turns).toBe(1); expect(Object.keys(report.burns)).toEqual(["opencode"]);
    expect(await (await fetch(`${server.url}/api/report?source=claude`)).json()).toBeNull();
  } finally { await server.close(); db.close(); }
});

it("does not charge other OpenCode providers to the Go weekly quota", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true });
  const options = { weeklyBudget: null, now, opencodeWeek: { start: new Date(+now - 86_400_000), resets: new Date(+now + 6 * 86_400_000), used: 63 } };
  await app.reports.refresh();
  const before = app.reports.getReport(7, "opencode", options)!;
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("other", "ses_demo", +now, +now + 1,
    JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: "claude-opus", tokens: { input: 200_000, output: 1000 } }));
  await app.reports.refresh(); const after = app.reports.getReport(7, "opencode", options)!;
  expect(after.total).toBeGreaterThan(before.total);
  expect(after.burns.opencode?.limit).toBe(before.burns.opencode?.limit);
  expect(after.burns.opencode?.ratePct).toBe(before.burns.opencode?.ratePct);
  db.close();
});

it("keeps quota failures private, retries at most once a minute, and writes nothing with no-cache", async () => {
  const { db, env } = fixture();
  const { writeFileSync, existsSync } = await import("node:fs");
  writeFileSync(join(env.OPENCODE_DATA_DIR, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "test-secret" } }));
  const fetcher = vi.fn().mockResolvedValue({ ok: false }); vi.stubGlobal("fetch", fetcher);
  expect(await openCodeWeek(env, now, true)).toBeNull();
  expect(await openCodeWeek(env, now, true)).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ usage: { weekly: { percent: 63, resetsAt: "2026-10-12T00:00:00Z" } } }) });
  expect((await openCodeWeek({ ...env, TOKEN_FURNACE_NO_CACHE: "1" }, new Date(+now + 60_000), true))?.used).toBe(63);
  expect(existsSync(join(env.HOME, ".cache", "token-furnace", "opencode-usage.json"))).toBe(false);
  expect((await openCodeWeek(env, new Date(+now + 60_000), false))?.used).toBe(63);
  db.close();
});
