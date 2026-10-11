import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compose } from "../src/compose";
import { assistant, codexToken } from "./fixtures/build";

const now = new Date("2026-10-11T12:00:00Z");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function setup() {
  const root = mkdtempSync(join(tmpdir(), "tf-agents-"));
  roots.push(root);
  const env = { HOME: root, TOKEN_FURNACE_WORKERS: "0" };
  const app = compose(env, { noCache: true });
  const write = (path: string, records: string[]) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, records.join("\n") + "\n"); };
  return { root, app, write, report: () => app.reports.getReport(7, "all", { now, weeklyBudget: null })! };
}

it("enriches report rows with Claude child models and distinct recent/idle activity, refreshing changed children", async () => {
  const { root, app, write, report } = setup();
  const parent = join(root, ".claude/projects/demo/parent.jsonl");
  const child = join(root, ".claude/projects/demo/parent/subagents/agent-worker.jsonl");
  write(parent, [assistant(now, 1000)]);
  write(child, [assistant(now, 2000).replace('claude-opus-5-5', 'claude-sonnet-5-5')]);
  write(join(child, "../agent-idle.jsonl"), [assistant(new Date(+now - 31 * 60_000), 1000)]);
  await app.reports.refresh();
  let row = report().active[0];
  expect(row.source).toBe("claude");
  expect(row.agents?.activeCount).toBe(2);
  expect(row.agents?.members).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "parent", role: "parent", active: true }),
    expect.objectContaining({ id: "worker", parentId: "parent", role: "subagent", model: "claude-sonnet-5-5", active: true }),
    expect.objectContaining({ id: "idle", active: false }),
  ]));
  write(child, [assistant(new Date(+now - 40 * 60_000), 99999)]);
  row = report().active[0];
  expect(row.agents?.activeCount).toBe(1);
  write(child, [assistant(now, 2000), '{"assistant":']);
  expect(report().active[0].agents?.complete).toBe(false);
});

it("links full Codex IDs through children and grandchildren without mixing providers", async () => {
  const { root, app, write, report } = setup();
  const ids = ["01a12bb9-3741-7411-9879-36b2865f8472", "01a12bb9-3741-7411-9879-36b2865f8473", "01a12bb9-3741-7411-9879-36b2865f8474"];
  for (let i = 0; i < ids.length; i++) {
    write(join(root, `.codex/sessions/rollout-${ids[i]}.jsonl`), [
      JSON.stringify({ type: "session_meta", payload: { id: ids[i], cwd: "/demo", source: i ? { subagent: { thread_spawn: { parent_thread_id: ids[i - 1] } } } : "cli", agent_nickname: i ? "Worker" : undefined } }),
      JSON.stringify({ type: "turn_context", payload: { model: i ? "gpt-6-luna" : "gpt-6.1-sol" } }),
      codexToken(now, 1000, 100, 50),
    ]);
  }
  await app.reports.refresh();
  const rows = report().active;
  expect(rows).toHaveLength(3);
  expect(rows.every(r => r.source === "codex")).toBe(true);
  // Native full IDs remain distinct even when the display prefixes collide.
  const parent = rows.find(r => r.path?.includes(ids[0]))!;
  expect(parent.agents?.activeCount).toBe(3);
  expect(parent.agents?.members.map(m => m.id)).toEqual(ids);
  const child = rows.find(r => r.path?.includes(ids[1]))!;
  expect(child.agents?.members[0]).toMatchObject({ role: "subagent", parentId: ids[0], model: "gpt-6-luna" });
});

it("shows unavailable relationships when Codex metadata is missing", async () => {
  const { root, app, write, report } = setup();
  write(join(root, ".codex/sessions/rollout-missing.jsonl"), [codexToken(now, 1000, 0, 50)]);
  await app.reports.refresh();
  expect(report().active[0].agents).toMatchObject({ complete: false, activeCount: 1, members: [{ role: "unknown", model: null }] });
});
