import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

const keyring = vi.hoisted(() => ({ value: "" }));
vi.mock("node:child_process", async (load) => ({
  ...(await load<typeof import("node:child_process")>()),
  execFileSync: (cmd: string) => { if (cmd === "secret-tool" && keyring.value) return keyring.value; throw new Error("no keyring"); },
}));

import { compose } from "../src/compose";
import { SqliteSessionRepository } from "../src/repo/sqlite-repo";
import { AgySource } from "../src/sources/agy";
import { agyWeek } from "../src/services/usage-client";

/** Protobuf wire encoding: enough to write agy's rows. */
const varint = (n: number): number[] => { const out: number[] = []; while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
const f = (n: number, v: number | string | number[]): number[] => typeof v === "number" ? [...varint(n * 8), ...varint(v)]
  : ((b: number[]) => [...varint(n * 8 + 2), ...varint(b.length), ...b])(typeof v === "string" ? [...Buffer.from(v)] : v);
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

const roots: string[] = [];
const now = new Date("2026-11-21T20:00:00Z");
const at = now.getTime() / 1000 - 60;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tf-agy-")); roots.push(root);
  const base = join(root, "agy"); mkdirSync(join(base, "conversations"), { recursive: true });
  const id = "11111111-2222-3333-4444-555555555555";
  const db = new DatabaseSync(join(base, "conversations", `${id}.db`));
  db.exec(`CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, metadata blob);
    CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob)`);
  const step = db.prepare("INSERT INTO steps VALUES (?, ?, ?)");
  const call = (name: string, args: object) => f(4, [...f(1, "call"), ...f(2, name), ...f(3, JSON.stringify(args))]);
  step.run(0, 14, bytes(f(1, [...f(1, at - 5)]))); // the user prompt
  step.run(1, 15, bytes(f(1, [...f(1, at)])));
  step.run(2, 132, bytes(f(1, [...f(1, at)]), call("read_file", { Path: "a.ts" })));
  step.run(3, 132, bytes(f(1, [...f(1, at)]), call("run_command", { CommandLine: "rg needle src" })));
  step.run(4, 132, bytes(f(1, [...f(1, at)]), call("edit_file", {})));
  const usage = (input: number, output: number, read: number) => f(4, [...f(1, 1535), ...f(2, input), ...f(3, output), ...f(5, read)]);
  const gen = db.prepare("INSERT INTO gen_metadata VALUES (?, ?)");
  gen.run(0, bytes(f(1, [...usage(1000, 30, 2000), ...f(19, "gemini-4-neon")]), f(2, [1, 2, 3])));
  gen.run(1, bytes(f(1, [...usage(500, 10, 3000), ...f(19, "claude-opus-5-5-high")]), f(2, [4])));
  db.close();
  const summary = new DatabaseSync(join(base, "conversation_summaries.db"));
  summary.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, workspace_uris text)");
  summary.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run(id, "agy fixture", '["file:///srv/demo"]');
  summary.close();
  const env = { HOME: root, AGY_HOME: base, XDG_CACHE_HOME: root, TOKEN_FURNACE_NOW: now.toISOString(), TOKEN_FURNACE_WORKERS: "0" };
  return { env, id, source: new AgySource(env) };
}
afterEach(() => { keyring.value = ""; vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("reads one turn per model call with usage, tools, reads, prompt wakes, title and project", () => {
  const { id, source } = fixture();
  const files = source.files(); expect(files).toHaveLength(1);
  const parsed = source.parse(files[0].path);
  expect(parsed).toMatchObject({ title: "agy fixture", badLines: 0 });
  expect(parsed.turns).toHaveLength(2);
  expect(parsed.turns[0]).toMatchObject({ source: "agy", session: id, project: "demo", model: "gemini-4-neon", baseIn: 1000,
    cacheRead: 2000, cacheWrite: 0, output: 30, tools: ["read_file", "run_command"], reads: 2, wakes: ["human"] });
  expect(parsed.turns[0].when).toEqual(new Date(at * 1000));
  expect(parsed.turns[1]).toMatchObject({ model: "claude-opus-5-5-high", tools: ["edit_file"], reads: 0, wakes: [] });
});

it("reads the Google plan's weekly meter with agy's keyring login and counts only its metered models", async () => {
  const { env } = fixture();
  const resets = new Date(+now + 3 * 86_400_000).toISOString();
  keyring.value = JSON.stringify({ token: { access_token: "tok", expiry: new Date(+now + 3_600_000).toISOString() } });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ groups: [{ buckets: [
    { window: "5h", remainingFraction: 0.1, resetTime: resets },
    { window: "weekly", remainingFraction: 0.75, resetTime: resets },
  ] }] })));
  vi.stubGlobal("fetch", fetch);
  const week = await agyWeek(env, now, true);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]).toMatchObject([expect.stringContaining("retrieveUserQuotaSummary"), { headers: { Authorization: "Bearer tok" } }]);
  expect(week).toMatchObject({ used: 25, resets: new Date(resets) });

  const app = compose(env);
  await app.reports.refresh();
  const raw = app.reports.getRaw(7, "agy", { weeklyBudget: null, now, agyWeek: week });
  expect(raw?.burns.agy?.week?.used).toBe(25);
  expect(raw?.burns.agy?.week?.burndown.at(-1)?.[1]).toBe(25);
  (app.repo as SqliteSessionRepository).close();
});

it("makes no call when agy's login has expired", async () => {
  const { env } = fixture();
  keyring.value = JSON.stringify({ token: { access_token: "tok", expiry: new Date(+now - 1).toISOString() } });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect(await agyWeek(env, now, true)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
