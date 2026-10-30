import { mkdirSync, realpathSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { PROVIDERS as PROVIDER_KINDS } from "../src/core/providers";
import type { Source } from "../src/core/model";
import { compose } from "../src/compose";
import { SqliteSessionRepository } from "../src/repo/sqlite-repo";
import { ClaudeSource } from "../src/sources/claude";
import { CodexSource } from "../src/sources/codex";
import { OpenCodeSource } from "../src/sources/opencode";
import { buildFull } from "./fixtures/build";

const now = new Date("2026-10-10T20:00:00Z");
const roots: string[] = [];
const PROVIDERS = Object.keys(PROVIDER_KINDS).sort() as Source[];

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A synthetic HOME with all three providers at their default roots. */
function setupHome(): string {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "tf-providers-"));
  roots.push(home);
  buildFull(join(home, ".claude"), now);
  renameSync(join(home, ".claude", "codex"), join(home, ".codex")); // Codex default root is ~/.codex
  writeOpenCode(join(home, ".local", "share", "opencode"));
  return home;
}

/** The minimal OpenCode SQLite store, as test/opencode.test.ts builds it. */
function writeOpenCode(base: string): void {
  mkdirSync(base, { recursive: true });
  const db = new DatabaseSync(join(base, "opencode.db"));
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_updated INTEGER, data TEXT);`);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_demo", "/srv/demo", "OpenCode fixture", +now);
  const message = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  message.run("user", "ses_demo", +now - 2, +now - 2, JSON.stringify({ role: "user" }));
  message.run("assistant", "ses_demo", +now - 1, +now, JSON.stringify({ role: "assistant", providerID: "opencode-go", modelID: "gpt-5.5", time: { created: +now - 1 }, tokens: { input: 1000, output: 20, reasoning: 10, cache: { read: 2000, write: 30 } } }));
  db.close();
}

/** A minimal env: no real HOME, no ambient overrides, a fixed clock and a synthetic cache. */
function envFor(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CACHE_HOME: join(home, "cache"),
    TOKEN_FURNACE_NOW: now.toISOString(),
    TOKEN_FURNACE_WORKERS: "0",
    CLAUDE_CONFIG_DIR: undefined,
    CODEX_HOME: undefined,
    OPENCODE_DATA_DIR: undefined,
    XDG_DATA_HOME: undefined,
  };
}

const options = { weeklyBudget: null, now };

it("detects default roots under a synthetic HOME, including the OpenCode XDG path", async () => {
  const home = setupHome();
  const env = envFor(home);
  expect(new ClaudeSource(env).base()).toBe(join(home, ".claude"));
  expect(new CodexSource(env).base()).toBe(join(home, ".codex"));
  expect(new OpenCodeSource(env).base()).toBe(join(home, ".local", "share", "opencode"));
  const app = compose(env, { noCache: true });
  await app.reports.refresh();
  expect(Object.keys(app.reports.getReport(7, "all", options)!.burns).sort()).toEqual([...PROVIDERS]);
});

it("lets explicit CLAUDE_CONFIG_DIR, CODEX_HOME and OPENCODE_DATA_DIR override defaults and XDG", async () => {
  const home = setupHome();
  const claudeDir = join(home, "explicit-claude");
  const codexDir = join(home, "explicit-codex");
  const opencodeDir = join(home, "explicit-opencode");
  const xdg = join(home, "xdg");
  renameSync(join(home, ".claude"), claudeDir);
  renameSync(join(home, ".codex"), codexDir);
  renameSync(join(home, ".local", "share", "opencode"), opencodeDir);
  const env = { ...envFor(home), CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, OPENCODE_DATA_DIR: opencodeDir, XDG_DATA_HOME: xdg };
  expect(new ClaudeSource(env).base()).toBe(claudeDir);
  expect(new CodexSource(env).base()).toBe(codexDir);
  expect(new OpenCodeSource(env).base()).toBe(opencodeDir); // OPENCODE_DATA_DIR beats XDG_DATA_HOME
  expect(new OpenCodeSource({ ...envFor(home), XDG_DATA_HOME: xdg }).base()).toBe(join(xdg, "opencode"));
  const app = compose(env, { noCache: true });
  await app.reports.refresh();
  expect(Object.keys(app.reports.getReport(7, "all", options)!.burns).sort()).toEqual(["claude:explicit-claude", "codex", "opencode"]);
  mkdirSync(xdg, { recursive: true });
  renameSync(opencodeDir, join(xdg, "opencode"));
  const xdgEnv = { ...envFor(home), CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, OPENCODE_DATA_DIR: undefined, XDG_DATA_HOME: xdg };
  const xdgApp = compose(xdgEnv, { noCache: true });
  await xdgApp.reports.refresh();
  expect(xdgApp.reports.getReport(7, "opencode", options)!.total).toBeGreaterThan(0);
});

it("reports all three providers with burns and timelines, and each filter matches its isolated-provider report", async () => {
  const home = setupHome();
  const app = compose(envFor(home), { noCache: true });
  await app.reports.refresh();
  const all = app.reports.getReport(7, "all", options)!;
  expect(all.turns).toBeGreaterThan(0);
  const OVERRIDE = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", opencode: "OPENCODE_DATA_DIR" } as const;
  let sum = 0;
  for (const source of PROVIDERS) {
    expect(all.burns[source]).toBeDefined();
    expect(all.timelines?.[source]?.length).toBeGreaterThan(0);
    const filtered = app.reports.getReport(7, source, options)!;
    expect(filtered.total).toBeGreaterThan(0);
    expect(Object.keys(filtered.burns)).toEqual([source]);
    sum += filtered.total;
    const others = PROVIDERS.filter((p) => p !== source);
    const soloEnv = envFor(home);
    for (const other of others) soloEnv[OVERRIDE[other]] = join(home, `missing-${other}`);
    const solo = compose(soloEnv, { noCache: true });
    await solo.reports.refresh();
    const soloReport = solo.reports.getReport(7, source, options)!;
    expect(filtered.total).toBe(soloReport.total);
    expect(filtered.turns).toBe(soloReport.turns);
  }
  expect(sum).toBe(all.total); // mixed totals agree per-provider with each solo (missing-siblings) report
});

it("removing OpenCode preserves the Claude and Codex totals", async () => {
  const home = setupHome();
  const app = compose(envFor(home), { noCache: true });
  await app.reports.refresh();
  const claude = app.reports.getReport(7, "claude", options)!.total;
  const codex = app.reports.getReport(7, "codex", options)!.total;
  rmSync(join(home, ".local"), { recursive: true, force: true });
  await app.reports.refresh();
  expect(app.reports.getReport(7, "all", options)!.burns.opencode).toBeUndefined();
  expect(app.reports.getReport(7, "claude", options)!.total).toBe(claude);
  expect(app.reports.getReport(7, "codex", options)!.total).toBe(codex);
});

it("preserves all three providers across a persistent warm cache", async () => {
  const env = envFor(setupHome());
  const first = compose(env);
  await first.reports.refresh();
  const before = first.reports.getReport(7, "all", options)!;
  (first.repo as SqliteSessionRepository).close();
  const second = compose(env);
  await second.reports.refresh();
  expect(second.reports.progress.filesTotal).toBe(0);
  const after = second.reports.getReport(7, "all", options)!;
  expect(Object.keys(after.burns).sort()).toEqual([...PROVIDERS]);
  expect(after.total).toBe(before.total);
  expect(after.turns).toBe(before.turns);
  for (const source of PROVIDERS) expect(after.timelines?.[source]?.length).toBe(before.timelines?.[source]?.length);
  (second.repo as SqliteSessionRepository).close();
});
