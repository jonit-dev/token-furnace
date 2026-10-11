import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compose } from "../src/compose";
import { startServer, type LiveServer } from "../src/server";

const roots: string[] = [];
const servers: LiveServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "tf-budget-http-"));
  roots.push(root);
  const app = compose({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") }, { noCache: true });
  const server = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
  servers.push(server);
  const initial = await fetch(`${server.url}/api/budgets`);
  const raw = await initial.text();
  const body = raw.trimStart().startsWith("{") ? JSON.parse(raw) as { mutationToken: string; revision: number } : { mutationToken: "", revision: -1 };
  return { server, initial, body };
}

describe("budget HTTP controls", () => {
  it("preserves a cached meter observation time and makes stale Auto unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-stale-"));
    roots.push(root);
    const cache = join(root, "cache", "token-furnace");
    mkdirSync(cache, { recursive: true });
    const now = Date.now();
    const observed = new Date(now - 6 * 60_000);
    writeFileSync(join(cache, "usage.json"), JSON.stringify({ fetched: observed.getTime() / 1000, account: "account-1", seven_day: { utilization: 40, resets_at: now / 1000 + 3 * 86_400 } }));
    const app = compose({ HOME: root, XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") }, { noCache: true });
    const server = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
    servers.push(server);
    const initial = await (await fetch(`${server.url}/api/budgets`)).json() as { mutationToken: string; revision: number; sources: Array<{ source: string; meter: { observedAt: string } | null }> };
    const claude = initial.sources.find((source) => source.source === "claude")!;
    expect(new Date(claude.meter!.observedAt).getTime()).toBe(observed.getTime());
    const headers = { "content-type": "application/json", "x-token-furnace-mutation": initial.mutationToken, origin: server.url };
    const saved = await fetch(`${server.url}/api/budgets`, { method: "POST", headers, body: JSON.stringify({ expectedRevision: initial.revision, policies: [{ scope: { kind: "source", source: "claude" }, mode: "auto", unit: "percentage-per-hour", limit: null, deadline: null }] }) });
    expect(saved.status).toBe(200);
    const after = await (await fetch(`${server.url}/api/budgets`)).json() as { sources: Array<{ source: string; status: string }> };
    expect(after.sources.find((source) => source.source === "claude")?.status).toBe("Usage unavailable");
  });

  it("returns all source controls and requires the same-origin mutation token", async () => {
    const { server, initial, body } = await boot();
    expect(initial.status).toBe(200);
    expect(body.revision).toBe(0);
    expect(body.mutationToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const snapshot = body as typeof body & { sources: Array<{ source: string }> };
    expect(snapshot.sources.map((source) => source.source).sort()).toEqual(["claude", "codex", "opencode"]);

    const payload = JSON.stringify({ expectedRevision: 0, policies: [{
      scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-total", limit: 100,
      deadline: "2099-10-11T12:00:00.000Z",
    }] });
    const denied = await fetch(`${server.url}/api/budgets`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    expect(denied.status).toBe(403);
    const saved = await fetch(`${server.url}/api/budgets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-token-furnace-mutation": body.mutationToken, origin: server.url },
      body: payload,
    });
    expect(saved.status).toBe(200);
    expect((await saved.json() as { revision: number }).revision).toBe(1);

    const stale = await fetch(`${server.url}/api/budgets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-token-furnace-mutation": body.mutationToken, origin: server.url },
      body: payload,
    });
    expect(stale.status).toBe(409);
    const crossSite = await fetch(`${server.url}/api/budgets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-token-furnace-mutation": body.mutationToken, origin: "https://evil.example" },
      body: JSON.stringify({ expectedRevision: 1, policies: [] }),
    });
    expect(crossSite.status).toBe(403);
  });

  it("keeps stop preview read-only and persists commit, operation, and unlock", async () => {
    const { server, body } = await boot();
    const headers = { "content-type": "application/json", "x-token-furnace-mutation": body.mutationToken, origin: server.url };
    const previewResponse = await fetch(`${server.url}/api/budgets/stop-preview`, {
      method: "POST", headers, body: JSON.stringify({ scope: { kind: "provider", provider: "anthropic" } }),
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { id: string; fingerprint: string };
    const stopped = await fetch(`${server.url}/api/budgets/stop`, {
      method: "POST", headers, body: JSON.stringify({ previewId: preview.id, fingerprint: preview.fingerprint, outcomes: [] }),
    });
    expect(stopped.status).toBe(200);
    const operation = await stopped.json() as { id: string; status: string };
    expect(operation.status).toBe("partial");
    expect((await fetch(`${server.url}/api/budgets/operations/${operation.id}`)).status).toBe(200);
    const replay = await fetch(`${server.url}/api/budgets/stop`, {
      method: "POST", headers, body: JSON.stringify({ previewId: preview.id, fingerprint: preview.fingerprint, outcomes: [] }),
    });
    expect(replay.status).toBe(409);
    const unlocked = await fetch(`${server.url}/api/budgets/unlock`, {
      method: "POST", headers, body: JSON.stringify({ scope: { kind: "provider", provider: "anthropic" } }),
    });
    expect(unlocked.status).toBe(200);
  });
});
