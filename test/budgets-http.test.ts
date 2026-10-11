import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compose } from "../src/compose";
import { startServer, type LiveServer } from "../src/server";
import type { ControlTarget } from "../src/services/agent-control";

const roots: string[] = [];
const servers: LiveServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function syntheticTarget(): ControlTarget {
  return {
    id: "http-synthetic-target",
    source: "claude",
    provider: "anthropic",
    model: "claude-opus",
    pid: 424242,
    processStartTime: 1,
    ownerUid: 7,
    ownerSid: "S-1-5-21-http-test",
    executable: "/usr/bin/token-furnace-http-test-agent",
    exclusive: true,
  };
}

async function boot(withTarget = false) {
  const root = mkdtempSync(join(tmpdir(), "tf-budget-http-"));
  roots.push(root);
  const app = compose({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") }, { noCache: true });
  const target = withTarget ? syntheticTarget() : null;
  vi.spyOn(app.control, "preview").mockReturnValue({ targets: target ? [target] : [], unverified: [], collateral: [] });
  const stop = vi.spyOn(app.control, "stop").mockResolvedValue(target ? [{ targetId: target.id, status: "terminated" }] : []);
  const server = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
  servers.push(server);
  const initial = await fetch(`${server.url}/api/budgets`);
  const raw = await initial.text();
  const body = raw.trimStart().startsWith("{") ? JSON.parse(raw) as { mutationToken: string; revision: number } : { mutationToken: "", revision: -1 };
  return { server, initial, body, stop };
}

function postWithHost(url: string, headers: Record<string, string>, body: string): Promise<number> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname,
      method: "POST",
      headers: { ...headers, host: "evil.example" },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

describe("budget HTTP controls", () => {
  it("serves the Budgets tab on a first run with no transcript report", async () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-empty-"));
    roots.push(root);
    const app = compose({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") }, { noCache: true });
    await app.reports.refresh();
    const server = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
    servers.push(server);
    const response = await fetch(`${server.url}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("budgets");
    expect(html).not.toContain("No assistant turns.");
  });

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

  it("rejects untrusted mutation requests without changing policy or cancelling a target", async () => {
    const { server, body, stop } = await boot(true);
    const validHeaders = { "content-type": "application/json", "x-token-furnace-mutation": body.mutationToken, origin: server.url };
    const payload = JSON.stringify({ expectedRevision: 0, policies: [] });
    const previewResponse = await fetch(`${server.url}/api/budgets/stop-preview`, {
      method: "POST", headers: validHeaders, body: JSON.stringify({ scope: { kind: "provider", provider: "anthropic" } }),
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { id: string; fingerprint: string };
    const stopPayload = JSON.stringify({ previewId: preview.id, fingerprint: preview.fingerprint, force: true, forceConfirm: true, outcomes: [] });
    const before = await (await fetch(`${server.url}/api/budgets`)).json() as { revision: number; policies: unknown[]; stops: unknown[] };
    const expectUnchanged = async (label: string) => {
      const after = await (await fetch(`${server.url}/api/budgets`)).json() as { revision: number; policies: unknown[]; stops: unknown[] };
      expect(after.revision, label).toBe(before.revision);
      expect(after.policies, label).toEqual(before.policies);
      expect(after.stops, label).toEqual(before.stops);
      expect(stop, label).not.toHaveBeenCalled();
    };
    const rejected = [
      { name: "host", headers: { ...validHeaders, host: "evil.example" }, expected: 403 },
      { name: "origin", headers: { ...validHeaders, origin: "https://evil.example" }, expected: 403 },
      { name: "token", headers: { ...validHeaders, "x-token-furnace-mutation": "wrong-token" }, expected: 403 },
      { name: "content type", headers: { ...validHeaders, "content-type": "text/plain" }, expected: 415 },
    ];
    for (const attempt of rejected) {
      const policyStatus = attempt.name === "host"
        ? await postWithHost(`${server.url}/api/budgets`, attempt.headers, payload)
        : (await fetch(`${server.url}/api/budgets`, { method: "POST", headers: attempt.headers, body: payload })).status;
      expect(policyStatus, `${attempt.name} policy`).toBe(attempt.expected);
      const stopStatus = attempt.name === "host"
        ? await postWithHost(`${server.url}/api/budgets/stop`, attempt.headers, stopPayload)
        : (await fetch(`${server.url}/api/budgets/stop`, { method: "POST", headers: attempt.headers, body: stopPayload })).status;
      expect(stopStatus, `${attempt.name} stop`).toBe(attempt.expected);
      await expectUnchanged(attempt.name);
    }
    const unsupported = await fetch(`${server.url}/api/budgets/stop-preview`, {
      method: "POST",
      headers: validHeaders,
      body: JSON.stringify({ scope: { kind: "unsupported", source: "claude" } }),
    });
    expect(unsupported.status).toBe(400);
    await expectUnchanged("unsupported selector");
    const committed = await fetch(`${server.url}/api/budgets/stop`, {
      method: "POST", headers: validHeaders, body: stopPayload,
    });
    expect(committed.status).toBe(200);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.calls[0]?.[1]).toBe(true);
  });

  it("rejects stale, altered, and replayed stop confirmations without extra cancellation", async () => {
    const { server, body, stop } = await boot(true);
    const headers = { "content-type": "application/json", "x-token-furnace-mutation": body.mutationToken, origin: server.url };
    const previewResponse = await fetch(`${server.url}/api/budgets/stop-preview`, {
      method: "POST", headers, body: JSON.stringify({ scope: { kind: "provider", provider: "anthropic" } }),
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { id: string; fingerprint: string };
    const altered = await fetch(`${server.url}/api/budgets/stop`, {
      method: "POST", headers, body: JSON.stringify({ previewId: preview.id, fingerprint: `${preview.fingerprint}-altered`, outcomes: [] }),
    });
    expect(altered.status).toBe(409);
    expect(stop).not.toHaveBeenCalled();

    const saved = await fetch(`${server.url}/api/budgets`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 0, policies: [{
        scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-total", limit: 100,
        deadline: "2099-10-11T12:00:00.000Z",
      }] }),
    });
    expect(saved.status).toBe(200);
    const stale = await fetch(`${server.url}/api/budgets/stop`, {
      method: "POST", headers, body: JSON.stringify({ previewId: preview.id, fingerprint: preview.fingerprint, outcomes: [] }),
    });
    expect(stale.status).toBe(409);
    expect(stop).not.toHaveBeenCalled();
    const afterStale = await (await fetch(`${server.url}/api/budgets`)).json() as { revision: number; stops: unknown[] };
    expect(afterStale.revision).toBe(1);
    expect(afterStale.stops).toEqual([]);

    const freshPreviewResponse = await fetch(`${server.url}/api/budgets/stop-preview`, {
      method: "POST", headers, body: JSON.stringify({ scope: { kind: "provider", provider: "anthropic" } }),
    });
    expect(freshPreviewResponse.status).toBe(200);
    const freshPreview = await freshPreviewResponse.json() as { id: string; fingerprint: string };
    const first = await fetch(`${server.url}/api/budgets/stop`, {
      method: "POST", headers, body: JSON.stringify({ previewId: freshPreview.id, fingerprint: freshPreview.fingerprint, outcomes: [] }),
    });
    expect(first.status).toBe(200);
    expect(stop).toHaveBeenCalledTimes(1);
    const replay = await fetch(`${server.url}/api/budgets/stop`, {
      method: "POST", headers, body: JSON.stringify({ previewId: freshPreview.id, fingerprint: freshPreview.fingerprint, outcomes: [] }),
    });
    expect(replay.status).toBe(409);
    expect(stop).toHaveBeenCalledTimes(1);
    const afterReplay = await (await fetch(`${server.url}/api/budgets`)).json() as { revision: number; stops: unknown[] };
    expect(afterReplay.revision).toBe(1);
    expect(afterReplay.stops).toHaveLength(1);
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
