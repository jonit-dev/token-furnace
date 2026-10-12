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

// Quota reader hardening: each case guards a way the Go meter has gone missing from the dashboard.
const goBody = (weekly: unknown) => ({ ok: true, json: async () => ({ usage: { weekly } }) });
async function withAuth(env: Record<string, string>, key = "file-key") {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(env.OPENCODE_DATA_DIR, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key } }));
}
const bearer = (call: unknown[]) => (call[1] as { headers: Record<string, string> }).headers.Authorization;

it("prefers the auth.json login over OPENCODE_API_KEY, which may belong to another account", async () => {
  const { db, env } = fixture(); await withAuth(env);
  const fetcher = vi.fn(async (_url: string, init: { headers: Record<string, string> }) =>
    goBody({ percent: init.headers.Authorization === "Bearer file-key" ? 5 : 0, resetsAt: "2026-10-12T00:00:00Z" }));
  vi.stubGlobal("fetch", fetcher);
  expect((await openCodeWeek({ ...env, OPENCODE_API_KEY: "other-account" }, now, true))?.used).toBe(5);
  expect(fetcher.mock.calls.map(bearer)).toEqual(["Bearer file-key"]);
  db.close();
});

it("falls back to OPENCODE_API_KEY when the auth.json key is rejected", async () => {
  const { db, env } = fixture(); await withAuth(env, "expired");
  const fetcher = vi.fn(async (_url: string, init: { headers: Record<string, string> }) =>
    init.headers.Authorization === "Bearer env-key" ? goBody({ percent: 4, resetsAt: "2026-10-12T00:00:00Z" }) : { ok: false });
  vi.stubGlobal("fetch", fetcher);
  expect((await openCodeWeek({ ...env, OPENCODE_API_KEY: "env-key" }, now, true))?.used).toBe(4);
  expect(fetcher.mock.calls.map(bearer)).toEqual(["Bearer expired", "Bearer env-key"]);
  db.close();
});

it("does not call twice with the same key when env and auth.json agree", async () => {
  const { db, env } = fixture(); await withAuth(env, "same");
  const fetcher = vi.fn().mockResolvedValue({ ok: false }); vi.stubGlobal("fetch", fetcher);
  expect(await openCodeWeek({ ...env, OPENCODE_API_KEY: "same" }, now, true)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  db.close();
});

it("falls back to the env key when the auth.json key throws a network error", async () => {
  const { db, env } = fixture(); await withAuth(env);
  const fetcher = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
    if (init.headers.Authorization === "Bearer file-key") throw new Error("socket hang up");
    return goBody({ percent: 3, resetsAt: "2026-10-12T00:00:00Z" });
  });
  vi.stubGlobal("fetch", fetcher);
  expect((await openCodeWeek({ ...env, OPENCODE_API_KEY: "env-key" }, now, true))?.used).toBe(3);
  db.close();
});

it("makes no request without any key, and works with only the env key", async () => {
  const { db, env } = fixture();
  const fetcher = vi.fn().mockResolvedValue(goBody({ percent: 9, resetsAt: "2026-10-12T00:00:00Z" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await openCodeWeek(env, now, true)).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  expect((await openCodeWeek({ ...env, OPENCODE_API_KEY: "env-only" }, now, true))?.used).toBe(9);
  db.close();
});

it.each([
  ["a response with no weekly meter (monthly or rolling only)", { monthly: { percent: 31, resetsAt: "2026-11-01T00:00:00Z" } }],
  ["a non-numeric percent", { percent: "5", resetsAt: "2026-10-12T00:00:00Z" }],
  ["a negative percent", { percent: -1, resetsAt: "2026-10-12T00:00:00Z" }],
  ["a reset that already passed", { percent: 5, resetsAt: "2026-10-09T00:00:00Z" }],
  ["a missing reset", { percent: 5 }],
])("ignores %s and writes no reading", async (_label, weekly) => {
  const { db, env } = fixture(); await withAuth(env);
  const { existsSync } = await import("node:fs");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(goBody(weekly)));
  expect(await openCodeWeek(env, now, true)).toBeNull();
  expect(existsSync(join(env.HOME, ".cache", "token-furnace", "opencode-usage.json"))).toBe(false);
  db.close();
});

it("keeps the last good reading when a refresh fails, until its own reset passes", async () => {
  const { db, env } = fixture(); await withAuth(env);
  const fetcher = vi.fn().mockResolvedValue(goBody({ percent: 5, resetsAt: "2026-10-12T00:00:00Z" }));
  vi.stubGlobal("fetch", fetcher);
  expect((await openCodeWeek(env, now, true))?.used).toBe(5);
  fetcher.mockResolvedValue({ ok: false });
  const later = new Date(+now + 10 * 60_000); // past the 5-minute reuse window, so it retries
  expect((await openCodeWeek(env, later, true))?.used).toBe(5);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await openCodeWeek(env, new Date("2026-10-12T00:00:01Z"), true)).toBeNull();
  db.close();
});

it("reads the saved reading on a fresh process, and ignores one saved for another data directory", async () => {
  const { db, env } = fixture();
  const { mkdirSync: mk, writeFileSync } = await import("node:fs");
  const dir = join(env.HOME, ".cache", "token-furnace"); mk(dir, { recursive: true });
  const saved = (source: string) => JSON.stringify({ source, fetched: +now / 1000, seven_day: { utilization: 2, resets_at: "2026-10-19T00:00:00.000Z" } });
  writeFileSync(join(dir, "opencode-usage.json"), saved(env.OPENCODE_DATA_DIR));
  expect((await openCodeWeek(env, now, false))?.used).toBe(2);
  writeFileSync(join(dir, "opencode-usage.json"), saved("/somewhere/else"));
  expect(await openCodeWeek({ ...env, OPENCODE_DATA_DIR: join(env.HOME, "other") }, now, false)).toBeNull();
  db.close();
});

it("surfaces a new week with no local spend as pending, not as a dash, and not as a calibrated week", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const later = new Date(+now + 2 * 3_600_000); // the fixture's only turn is before this week began
  const week = (used: number) => ({ start: new Date(+now + 3_600_000), resets: new Date(+now + 7 * 86_400_000), used });
  for (const used of [0, 2, 5]) {
    const burn = app.reports.getReport(7, "opencode", { weeklyBudget: null, now: later, opencodeWeek: week(used) })!.burns.opencode!;
    expect(burn.used).toBeNull(); expect(burn.weekBurndown).toBeNull(); expect(burn.limit).toBeNull();
    expect(burn.pending?.used).toBe(used);
    expect(Date.parse(burn.pending!.resets)).toBe(+now + 7 * 86_400_000);
  }
  db.close();
});

it("calibrates once this week has Go spend and the plan reads 1% or more, and clears pending", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const week = (used: number) => ({ start: new Date(+now - 86_400_000), resets: new Date(+now + 6 * 86_400_000), used });
  const ok = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week(5) })!.burns.opencode!;
  expect(ok.used).toBe(5); expect(ok.pending).toBeNull(); expect(ok.limit).toBeGreaterThan(0);
  // Spend exists, but the plan still reads 0%: the limit cannot be divided out yet.
  const zero = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week(0) })!.burns.opencode!;
  expect(zero.used).toBeNull(); expect(zero.pending?.used).toBe(0);
  db.close();
});

it("reports no pending and no week when the plan reading is unavailable", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const burn = app.reports.getReport(7, "opencode", { weeklyBudget: null, now })!.burns.opencode!;
  expect(burn.used).toBeNull(); expect(burn.pending).toBeNull();
  db.close();
});

it("adds hidden headless runs to the active count, and visible ones only past the sessions already seen", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const get = (headless: import("../src/services/processes").Headless | undefined) =>
    app.reports.getReport(7, "opencode", { weeklyBudget: null, now, headless })!;
  expect(get(undefined).unseenAgents).toBeUndefined();
  expect(get({ hidden: {}, visible: {} }).unseenAgents).toEqual({});
  const seen = get(undefined).active.filter((a) => a.source === "opencode").length; // 1: the fixture turn is at `now`
  expect(seen).toBe(1);
  // One visible run is the session we already see; a second is a real extra.
  expect(get({ hidden: {}, visible: { opencode: 1 } }).unseenAgents).toEqual({});
  expect(get({ hidden: {}, visible: { opencode: 3 } }).unseenAgents).toEqual({ opencode: 2 });
  expect(get({ hidden: { codex: 2 }, visible: { opencode: 1 } }).unseenAgents).toEqual({ codex: 2 });
  db.close();
});

it("probes the process table for /api/report only when the server opts in", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const { startServer } = await import("../src/server");
  const base = { days: 7, source: "opencode" as const, weeklyBudget: null, planUsage: false, port: 0 };
  for (const [processes, expected] of [[undefined, "undefined"], [true, "object"]] as const) {
    const server = await startServer(app, { ...base, processes });
    try {
      const report = await (await fetch(`${server.url}/api/report`)).json() as { unseenAgents?: unknown };
      expect(typeof report.unseenAgents).toBe(expected);
    } finally { await server.close(); }
  }
  db.close();
});

// Red/green: a new week with no local spend has the plan's reading but no way to size the plan.
// The last calibrated size is remembered, so the gauge and tile read the weekly quota anyway.
const emptyWeek = (used: number) => ({ start: new Date(+now + 3_600_000), resets: new Date(+now + 7 * 86_400_000), used });
const later = new Date(+now + 2 * 3_600_000); // the fixture's only turn is before this week began

it("reads a new week from the remembered plan size when there is no local spend yet", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const burn = app.reports.getReport(7, "opencode", { weeklyBudget: null, now: later, opencodeWeek: emptyWeek(5), limits: { opencode: 2_000_000 } })!.burns.opencode!;
  expect(burn.pending).toBeNull();
  expect(burn.used).toBe(5);
  expect(burn.limit).toBe(2_000_000);
  // 95% of the plan is left over the hours to the reset: the goal comes from the plan, not the 7-day average.
  const hoursLeft = burn.hoursLeft!;
  expect(burn.idealPct).toBeCloseTo(95 / hoursLeft);
  expect(burn.goal).toBeCloseTo((2_000_000 * 0.95) / hoursLeft);
  expect(burn.basis).not.toContain("7-day average");
  expect(burn.weekBurndown!.at(-1)).toEqual([expect.any(String), 5, 5]); // ends at the plan's reading, not 0
  db.close();
});

it("stays pending when there is no local spend and no remembered plan size", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const burn = app.reports.getReport(7, "opencode", { weeklyBudget: null, now: later, opencodeWeek: emptyWeek(5) })!.burns.opencode!;
  expect(burn.used).toBeNull(); expect(burn.pending?.used).toBe(5);
  db.close();
});

it("prefers a fresh calibration over the remembered plan size", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const week = { start: new Date(+now - 86_400_000), resets: new Date(+now + 6 * 86_400_000), used: 5 };
  const burn = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week, limits: { opencode: 99 } })!.burns.opencode!;
  expect(burn.limit).not.toBe(99); expect(burn.limit).toBeGreaterThan(0);
  db.close();
});

it("remembers the calibrated plan size on disk and uses it for a later week with no spend", async () => {
  const { db, env } = fixture(); const { existsSync, readFileSync } = await import("node:fs");
  const app = compose(env); await app.reports.refresh();
  const week = { start: new Date(+now - 86_400_000), resets: new Date(+now + 6 * 86_400_000), used: 5 };
  const calibrated = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week })!.burns.opencode!;
  const file = join(env.HOME, ".cache", "token-furnace", "limits.json");
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).opencode).toBeCloseTo(calibrated.limit!, 0);
  const next = app.reports.getReport(7, "opencode", { weeklyBudget: null, now: later, opencodeWeek: emptyWeek(3) })!.burns.opencode!;
  expect(next.used).toBe(3); expect(next.limit).toBeCloseTo(calibrated.limit!, 0); expect(next.pending).toBeNull();
  db.close();
});

it("writes no plan size with no-cache, and ignores a corrupt or nonsense file", async () => {
  const { db, env } = fixture(); const { existsSync, mkdirSync: mk, writeFileSync } = await import("node:fs");
  const week = { start: new Date(+now - 86_400_000), resets: new Date(+now + 6 * 86_400_000), used: 5 };
  const off = compose({ ...env, TOKEN_FURNACE_NO_CACHE: "1" }, { noCache: true }); await off.reports.refresh();
  off.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week });
  const file = join(env.HOME, ".cache", "token-furnace", "limits.json");
  expect(existsSync(file)).toBe(false);
  mk(join(env.HOME, ".cache", "token-furnace"), { recursive: true });
  for (const bad of ["{not json", JSON.stringify({ opencode: -5 }), JSON.stringify({ opencode: "big" }), "null"]) {
    writeFileSync(file, bad);
    const app = compose({ ...env, TOKEN_FURNACE_NO_CACHE: "1" }, { noCache: true }); await app.reports.refresh();
    expect(app.reports.getReport(7, "opencode", { weeklyBudget: null, now: later, opencodeWeek: emptyWeek(5) })!.burns.opencode!.pending?.used).toBe(5);
  }
  db.close();
});

// Red/green: local spend can under-count (runs this machine cannot see), so a calibration may only
// raise the plan size. A remembered larger size is never replaced by a smaller one.
it("uses the remembered plan size as a floor when local spend under-counts the plan", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const week = { start: new Date(+now - 86_400_000), resets: new Date(+now + 6 * 86_400_000), used: 5 };
  const local = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week })!.burns.opencode!;
  const big = local.limit! * 50;
  const burn = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week, limits: { opencode: big } })!.burns.opencode!;
  expect(burn.limit).toBe(big);
  expect(burn.used).toBe(5);
  // The plan has 95% left, so the hourly goal comes from the larger size.
  expect(burn.goal).toBeCloseTo((big * 0.95) / burn.hoursLeft!);
  // The curve keeps its local shape but ends at the plan's reading.
  expect(burn.weekBurndown!.at(-1)![1]).toBeCloseTo(5);
  db.close();
});

it("never lowers the remembered plan size, and raises it when a calibration is larger", async () => {
  const { db, env } = fixture(); const { readFileSync, writeFileSync, mkdirSync: mk } = await import("node:fs");
  const dir = join(env.HOME, ".cache", "token-furnace"); mk(dir, { recursive: true });
  const file = join(dir, "limits.json");
  const app = compose(env); await app.reports.refresh();
  const week = { start: new Date(+now - 86_400_000), resets: new Date(+now + 6 * 86_400_000), used: 5 };
  const local = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week })!.burns.opencode!.limit!;
  writeFileSync(file, JSON.stringify({ opencode: local * 10 }));
  app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week });
  expect(JSON.parse(readFileSync(file, "utf8")).opencode).toBeCloseTo(local * 10, 0);
  writeFileSync(file, JSON.stringify({ opencode: local / 10 }));
  app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week });
  expect(JSON.parse(readFileSync(file, "utf8")).opencode).toBeCloseTo(local, 0);
  db.close();
});

// Red/green: the gauge reads the plan's own meter over time, so spend this machine never records
// (lanes, throwaway data dirs, other machines) still shows up as a burn rate.
const H = 3_600_000;
const meterWeek = (readings: [number, number][], used: number) =>
  ({ start: new Date(+now - 6 * H), resets: new Date(+now + 162 * H), used, readings });

it("builds the week from the meter alone when nothing is recorded locally and no plan size is known", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  // The clock is 10 h past the fixture's only turn, so this week has no local spend.
  const t = new Date(+now + 10 * H);
  const start = +t - 6 * H;
  const week = { start: new Date(start), resets: new Date(+t + 162 * H), used: 7,
    readings: [[start + 1 * H, 1], [start + 2 * H, 3], [+t - 0.5 * H, 6], [+t, 7]] as [number, number][] };
  const burn = app.reports.getReport(7, "opencode", { weeklyBudget: null, now: t, opencodeWeek: week })!.burns.opencode!;
  expect(burn.pending).toBeNull();
  expect(burn.used).toBe(7);
  expect(burn.limit).toBeNull();
  // Last 3 h: the newest reading at or before t-3h is 3% at start+2h, 4 h ago -> (7-3)/4.
  expect(burn.ratePct).toBeCloseTo(1);
  expect(burn.idealPct).toBeCloseTo(93 / 162);
  // A week younger than a day projects from its start, where the meter read 0.
  expect(burn.projection!.ratePct).toBeCloseTo(7 / 6);
  expect(burn.gains!["1"]).toBeCloseTo(4); // the newest reading at or before t-1h is 3% (t-4h)
  expect(burn.gains!["6"]).toBeCloseTo(7);
  // The chart is the meter itself, from 0 at the week start to the reading now.
  expect(burn.weekBurndown![0].slice(1)).toEqual([0, 0]);
  expect(burn.weekBurndown!.map((p) => p[1])).toEqual([0, 1, 3, 6, 7]);
  // The gauge has an hourly goal to draw against, so it shows %/h instead of "no quota reading".
  expect(burn.goal).toBeGreaterThan(0);
  db.close();
});

it("prefers the meter's rate over local token spend when both exist", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const start = +now - 6 * H;
  const week = { start: new Date(start), resets: new Date(+now + 162 * H), used: 9,
    readings: [[start + H, 2], [+now - 3 * H, 3], [+now, 9]] as [number, number][] };
  const burn = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week })!.burns.opencode!;
  expect(burn.limit).toBeGreaterThan(0); // sized from the fixture's local turn
  expect(burn.ratePct).toBeCloseTo(2); // (9-3)/3, not the local tokens over that size
  db.close();
});

it("falls back to the average since the week began when the meter has a single reading", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const t = new Date(+now + 10 * H);
  const week = { start: new Date(+t - 6 * H), resets: new Date(+t + 162 * H), used: 6, readings: [[+t, 6]] as [number, number][] };
  const burn = app.reports.getReport(7, "opencode", { weeklyBudget: null, now: t, opencodeWeek: week })!.burns.opencode!;
  expect(burn.used).toBe(6); expect(burn.ratePct).toBeCloseTo(1); expect(burn.pending).toBeNull();
  db.close();
});

it("records each meter reading for the week, keeps them across processes, and drops last week's", async () => {
  const { db, env } = fixture(); await withAuth(env);
  const { readFileSync } = await import("node:fs");
  const fetcher = vi.fn().mockResolvedValue(goBody({ percent: 2, resetsAt: "2026-10-12T00:00:00Z" }));
  vi.stubGlobal("fetch", fetcher);
  await openCodeWeek(env, now, true);
  fetcher.mockResolvedValue(goBody({ percent: 4, resetsAt: "2026-10-12T00:00:00Z" }));
  const week = (await openCodeWeek(env, new Date(+now + 6 * 60_000), true))!;
  expect(week.readings).toEqual([[+now, 2], [+now + 6 * 60_000, 4]]);
  const file = join(env.HOME, ".cache", "token-furnace", "opencode-usage.json");
  expect(JSON.parse(readFileSync(file, "utf8")).history).toEqual([[+now, 2], [+now + 6 * 60_000, 4]]);
  // A reused reading (inside 5 minutes) still carries the history.
  expect((await openCodeWeek(env, new Date(+now + 7 * 60_000), false))!.readings).toHaveLength(2);
  // The next week starts a new history.
  fetcher.mockResolvedValue(goBody({ percent: 1, resetsAt: "2026-10-19T00:00:00Z" }));
  const next = (await openCodeWeek(env, new Date("2026-10-12T01:00:00Z"), true))!;
  expect(next.readings).toEqual([[Date.parse("2026-10-12T01:00:00Z"), 1]]);
  db.close();
});

it("treats a saved reading from before meter history existed as the first meter point", async () => {
  const { db, env } = fixture();
  const { mkdirSync: mk, writeFileSync } = await import("node:fs");
  const dir = join(env.HOME, ".cache", "token-furnace"); mk(dir, { recursive: true });
  writeFileSync(join(dir, "opencode-usage.json"), JSON.stringify({ source: env.OPENCODE_DATA_DIR, fetched: +now / 1000 - 60,
    seven_day: { utilization: 8, resets_at: "2026-10-12T00:00:00.000Z" } }));
  const week = (await openCodeWeek(env, now, false))!;
  expect(week.used).toBe(8);
  expect(week.readings).toEqual([[+now - 60_000, 8]]);
  db.close();
});

// Red/green: a remembered floor 50x the local calibration flattened Codex's projection to ~0 while
// its curve (scaled by local spend) climbed 25% in a day. Rates must use the curve's scale.
it("converts local rates to plan percent on the curve's scale, not the remembered floor", async () => {
  const { db, env } = fixture(); const app = compose(env, { noCache: true }); await app.reports.refresh();
  const week = { start: new Date(+now - 86_400_000), resets: new Date(+now + 6 * 86_400_000), used: 5 };
  const local = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week })!.burns.opencode!;
  const floored = app.reports.getReport(7, "opencode", { weeklyBudget: null, now, opencodeWeek: week, limits: { opencode: local.limit! * 50 } })!.burns.opencode!;
  expect(local.gains![24]).toBeGreaterThan(0);
  expect(floored.gains).toEqual(local.gains);
  expect(floored.projection).toEqual(local.projection);
  db.close();
});

// Red/green: the env-key fallback (another account) read 0% mid-week and two processes interleaved
// writes, so the curve dropped to 0 and back. Within one week the meter only rises.
it("keeps the weekly meter monotonic: drops lower readings and orders interleaved ones", async () => {
  const { db, env } = fixture(); await withAuth(env);
  const { mkdirSync: mk, writeFileSync } = await import("node:fs");
  const dir = join(env.HOME, ".cache", "token-furnace"); mk(dir, { recursive: true });
  const resets_at = "2026-10-12T00:00:00Z", t = (m: number) => +now - m * 60_000;
  writeFileSync(join(dir, "opencode-usage.json"), JSON.stringify({ source: env.OPENCODE_DATA_DIR, fetched: t(30) / 1000,
    seven_day: { utilization: 40, resets_at }, history: [[t(40), 30], [t(35), 0], [t(30), 40], [t(32), 38]] }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(goBody({ percent: 0, resetsAt: resets_at })));
  const week = await openCodeWeek(env, now, true);
  expect(week?.used).toBe(40);
  expect(week?.readings).toEqual([[t(40), 30], [t(32), 38], [t(30), 40]]);
  db.close();
});
