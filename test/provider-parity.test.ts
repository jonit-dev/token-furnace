import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compose, type App } from "../src/compose";
import { DatabaseSync } from "node:sqlite";
import { CodexSource } from "../src/sources/codex";

const now = new Date("2026-10-10T12:00:00Z");
const roots: string[] = [];
const apps: App[] = [];
const usage = { input_tokens: 400_000, cached_input_tokens: 300_000, output_tokens: 200, reasoning_output_tokens: 100, total_tokens: 400_200 };
const token = (total = 400_200) => ({ type: "event_msg", timestamp: now.toISOString(), payload: {
  type: "token_count", info: { last_token_usage: usage, total_token_usage: { ...usage, total_tokens: total } },
} });
const prompt = { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Find the bug" }] } };

function fixture(records: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "tf-providers-"));
  roots.push(root);
  const home = join(root, "codex");
  mkdirSync(join(home, "sessions"), { recursive: true });
  const path = join(home, "sessions", "rollout-parity.jsonl");
  writeFileSync(path, [
    { type: "session_meta", payload: { id: "codex123-session", cwd: "/srv/api" } },
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    ...records,
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const env = { HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: home, TOKEN_FURNACE_WORKERS: "0" };
  return { root, home, env, path, parsed: () => new CodexSource(env).parse(path) };
}

function appFor(env: NodeJS.ProcessEnv, opts?: { noCache?: boolean }): App {
  const app = compose(env, opts);
  apps.push(app);
  return app;
}

afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex provider parity", () => {
  it("reparses unchanged transcripts from the old parser cache", async () => {
    const f = fixture([prompt, token()]);
    const cacheDir = join(f.root, "cache");
    const env = { ...f.env, XDG_CACHE_HOME: cacheDir };
    const path = join(cacheDir, "token-furnace", "cache.sqlite");
    mkdirSync(join(cacheDir, "token-furnace"), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = 1;
      CREATE TABLE files (path TEXT PRIMARY KEY, source TEXT, mtime_ns INTEGER, size INTEGER, title TEXT, bad_lines INTEGER DEFAULT 0);
      CREATE TABLE turns (path TEXT, seq INTEGER, project TEXT, session TEXT, model TEXT, at INTEGER, base_in INTEGER, cache_read INTEGER, cache_write INTEGER, output INTEGER, tools TEXT, reads INTEGER, wakes TEXT, PRIMARY KEY(path, seq));`);
    const [file] = new CodexSource(env).files();
    db.prepare("INSERT INTO files (path, source, mtime_ns, size) VALUES (?, ?, ?, ?)").run(file.path, "codex", file.mtimeMs, file.size);
    db.close();
    const app = appFor(env);
    try {
      await app.reports.refresh();
      expect(app.reports.getReport(7, "all", { now, weeklyBudget: null })?.turns).toBe(1);
      expect(app.repo.changed([file])).toEqual([]);
    } finally { app.close(); }
  });

  it.each([
    ["shell", JSON.stringify({ command: "cat src/main.ts" })],
    ["exec_command", JSON.stringify({ cmd: "rg bug src" })],
    ["shell", JSON.stringify({ command: ["cat src/main.ts", "git status"] })],
  ])("counts reads inside %s JSON arguments", (name, args) => {
    const f = fixture([{ type: "response_item", payload: { type: "function_call", name, arguments: args } }, token()]);
    expect(f.parsed().turns[0].reads).toBe(1);
  });

  it("includes custom tool calls in tool metrics", () => {
    const f = fixture([{ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "text(await tools.exec_command({cmd: 'cat src/main.ts'}))" } }, token()]);
    expect(f.parsed().turns[0].tools).toEqual(["exec"]);
  });

  it("counts executed commands inside code-mode wrappers without duplicating direct calls", () => {
    const f = fixture([
      { type: "response_item", payload: { type: "function_call", call_id: "direct", name: "exec_command", arguments: '{"cmd":"cat direct.ts"}' } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "direct", command: ["/bin/zsh", "-lc", "cat direct.ts"] } } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "code invoking shell commands" } },
      ...["nested1", "nested2"].map((id) => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id, command: ["/bin/zsh", "-lc", "rg bug src"] } } })),
      token(),
    ]);
    expect(f.parsed().turns[0].reads).toBe(3);
    expect(f.parsed().turns[0].tools.filter((tool) => tool === "exec_command")).toHaveLength(3);
  });

  it("keeps large modern Codex records through the optimized line filter", () => {
    const pad = "x".repeat(8_192);
    const f = fixture([
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Find the bug " + pad }] } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: pad } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "nested", command: ["/bin/zsh", "-lc", "cat src/main.ts"], aggregated_output: pad } } },
      token(),
    ]);
    expect(f.parsed().turns[0].wakes).toEqual(["human"]);
    expect(f.parsed().turns[0].tools).toEqual(["exec", "exec_command"]);
    expect(f.parsed().turns[0].reads).toBe(1);
  });

  it("counts response-item human prompts when user_message events are absent", () => {
    const f = fixture([prompt, token()]);
    expect(f.parsed().turns[0].wakes).toEqual(["human"]);
  });

  it("counts a prompt once when both message formats are logged", () => {
    const f = fixture([prompt, { type: "event_msg", payload: { type: "user_message", message: "Find the bug" } }, token()]);
    expect(f.parsed().turns[0].wakes).toEqual(["human"]);
  });

  it("keeps unmatched fallback prompts alongside explicit task wakes", () => {
    const f = fixture([prompt, { type: "event_msg", payload: { type: "user_message", message: "<task-notification>done</task-notification>" } }, token()]);
    expect(f.parsed().turns[0].wakes.sort()).toEqual(["human", "task"]);
  });

  it("does not add reasoning tokens already included in output_tokens", () => {
    const f = fixture([token()]);
    expect(f.parsed().turns[0].output).toBe(200);
  });

  it("ignores quota-only updates repeating cumulative usage but keeps equal-cost new turns", () => {
    const f = fixture([prompt, token(), token(), token(800_400)]);
    expect(f.parsed().turns).toHaveLength(2);
    expect(f.parsed().turns[1].wakes).toEqual([]);
  });

  it("delivers Codex-specific compaction fixes even when Claude's setting is already OK", async () => {
    const f = fixture([prompt, token()]);
    mkdirSync(join(f.env.CLAUDE_CONFIG_DIR, "projects"), { recursive: true });
    writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, "settings.json"), '{"autoCompactWindow":400000}');
    const app = appFor(f.env, { noCache: true });
    await app.reports.refresh();
    const report = app.reports.getReport(7, "all", { now, weeklyBudget: null })!;
    expect(report.active.map((s) => s.source)).toEqual(["codex"]);
    expect(report.baseline.find((r) => r.name === "Turns per human prompt")?.now_24h).toBe("1");
    const issue = report.issues.find((i) => i.title === "Sessions compact too late")!;
    expect(issue.fix).toContain("model_auto_compact_token_limit");
    expect(issue.prompt).toContain("~/.codex/config.toml");
    expect(issue.prompt).not.toContain("~/.claude");
    expect(issue.prompt).not.toContain("already fixed");
  });

  it("reports whole-window hot spend as a percentage rather than a token count", async () => {
    const f = fixture([prompt, token()]);
    const app = appFor(f.env, { noCache: true });
    await app.reports.refresh();
    const report = app.reports.getReport(7, "all", { now, weeklyBudget: null })!;
    const row = report.baseline.find((r) => r.source === "codex" && r.name === "Spend on turns over 300k")!;
    expect(row.now_24h).toBe("100%");
    expect(row.value_7d).toBe("100%");
  });
});
