/** The live server: the Report over HTTP, the raw page for hot reload, and the Host check. */

import { request } from "node:http";
import { Server as NetServer } from "node:net";
import { existsSync, mkdirSync, realpathSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compose } from "../src/compose";
import { startServer, type LiveServer } from "../src/server";
import { buildClaudeInstall, buildFull, saveUsageReading } from "./fixtures/build";
import { fixedNow, harnessEnv, tsReport } from "./harness";

const now = fixedNow();
const root = mkdtempSync(join(realpathSync(tmpdir()), "tf-server-"));
buildFull(root, now);
// A saved subscription reading: the default run makes no network call and still has a Claude week.
saveUsageReading(root, now);
const env = { ...harnessEnv(root, now), TOKEN_FURNACE_NOW: now.toISOString(), TOKEN_FURNACE_NO_CACHE: "1" };
const app = compose(env);

let live: LiveServer;
const listen = vi.spyOn(NetServer.prototype, "listen");

beforeAll(async () => {
  live = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
});

afterAll(async () => { await live.close(); listen.mockRestore(); });

function get(path: string, host = `127.0.0.1:${live.port}`): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port: live.port, path, headers: { Host: host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

describe("serve", () => {
  it("binds the native server to 127.0.0.1 only", () => {
    expect(listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
  });

  it("returns the Report on /api/report", async () => {
    const response = await get("/api/report");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(tsReport(env, now, 7, null, "all"));
    // No plan-usage call by default; the saved reading gives Claude a week, rate_limits gives Codex's.
    const report = JSON.parse(response.body);
    expect(report.burns.claude.weekBurndown).not.toBeNull();
    expect(report.burns.codex.weekBurndown).not.toBeNull();
  });

  it("takes days and source from the query", async () => {
    const response = await get("/api/report?days=2&source=claude");
    expect(JSON.parse(response.body)).toEqual(tsReport(env, now, 2, null, "claude"));
  });

  it("filters a discovered Claude install and rejects an unknown source", async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), "tf-server-installs-"));
    buildClaudeInstall(home, ".claude", { now });
    buildClaudeInstall(home, ".cc-work", { now, session: "work" });
    const custom = compose({ HOME: home, XDG_CACHE_HOME: join(home, "cache"), TOKEN_FURNACE_NOW: now.toISOString() }, { noCache: true });
    const server = await startServer(custom, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
    try {
      for (let i = 0; i < 100 && !custom.reports.hasScanned; i++) await new Promise((next) => setImmediate(next));
      const filtered = await new Promise<{ status: number; body: string }>((done, fail) => {
        const req = request({ host: "127.0.0.1", port: server.port, path: "/api/report?source=claude:cc-work", headers: { Host: `127.0.0.1:${server.port}` } }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => done({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", fail);
        req.end();
      });
      expect(filtered.status).toBe(200);
      expect(JSON.parse(filtered.body).topSessions.every((session: { source: string }) => session.source === "claude:cc-work")).toBe(true);

      const unknown = await new Promise<{ status: number }>((done, fail) => {
        const req = request({ host: "127.0.0.1", port: server.port, path: "/api/report?source=claude:nope", headers: { Host: `127.0.0.1:${server.port}` } }, (res) => {
          res.resume();
          res.on("end", () => done({ status: res.statusCode ?? 0 }));
        });
        req.on("error", fail);
        req.end();
      });
      expect(unknown.status).toBe(400);
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a Host that is not this loopback server", async () => {
    expect((await get("/api/report", `evil.example:${live.port}`)).status).toBe(403);
    expect((await get("/", `evil.example:${live.port}`)).status).toBe(403);
    expect((await get("/dashboard.html", `evil.example:${live.port}`)).status).toBe(403);
  });

  it("accepts localhost on the same port", async () => {
    expect((await get("/api/report", `localhost:${live.port}`)).status).toBe(200);
  });

  it("serves the raw page for hot reload, and the page with the report inlined", async () => {
    const raw = await get("/dashboard.html");
    expect(raw.body).toContain("/*REPORT*/null"); // no rebuild
    const page = await get("/", `localhost:${live.port}`);
    expect(page.body).not.toContain("/*REPORT*/null");
    expect(page.body).toContain("Sessions compact too late");
  });
});

describe("quota refresh", () => {
  const servers: LiveServer[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  /** Wait, with a bound, until a check passes. */
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !check(); i++) await new Promise((next) => setImmediate(next));
    expect(check()).toBe(true);
  }

  function read(server: LiveServer, path: string): Promise<{ status: number; body: string }> {
    return new Promise((done, fail) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path, headers: { Host: `127.0.0.1:${server.port}` } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => done({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", fail);
      req.end();
    });
  }

  function used(body: string): number | null {
    return JSON.parse(body).burns.claude.used;
  }

  /** A fresh fixture with a login, at an instant `offsetMs` after `now` so the minute gate lets a call through. */
  function quotaRoot(offsetMs: number) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "tf-quota-"));
    buildFull(root, now);
    writeFileSync(join(root, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test" } }));
    const at = new Date(now.getTime() + offsetMs);
    return { root, at, env: { ...harnessEnv(root, now), TOKEN_FURNACE_NOW: at.toISOString() } };
  }

  async function boot(env: NodeJS.ProcessEnv): Promise<LiveServer> {
    const server = await startServer(compose(env), {
      days: 7,
      source: "all",
      weeklyBudget: null,
      planUsage: true,
      port: 0,
    });
    servers.push(server);
    for (let i = 0; i < 500; i++) {
      if (JSON.parse((await read(server, "/api/status")).body).phase === "ready") return server;
      await new Promise((next) => setTimeout(next, 5));
    }
    throw new Error("scan did not finish");
  }

  /** Poll the report until it shows `want`, or the bound runs out. */
  async function reportUntil(server: LiveServer, want: number): Promise<number | null> {
    let seen: number | null = null;
    for (let i = 0; i < 500 && seen !== want; i++) {
      await new Promise((next) => setTimeout(next, 5));
      seen = used((await read(server, "/api/report")).body);
    }
    return seen;
  }

  it("answers while the quota fetch is in flight, then serves the fresh reading", async () => {
    const { at, env } = quotaRoot(0);
    let release: (value: unknown) => void = () => {};
    const fetchMock = vi.fn(() => new Promise((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const server = await boot(env);

    const first = await read(server, "/api/report");
    expect(first.status).toBe(200);
    expect(used(first.body)).toBeNull(); // no saved reading: the report did not wait for the network
    await until(() => fetchMock.mock.calls.length === 1); // the background fetch started and is still unsettled

    release(sevenDay(77, at));
    expect(used((await read(server, "/api/report")).body)).toBe(77);
  });

  it("keeps the saved reading when the quota fetch rejects", async () => {
    const { root, at, env } = quotaRoot(120_000);
    saveUsageReading(root, new Date(at.getTime() - 1_000_000)); // stale: tries the network, resets still ahead
    const fetchMock = vi.fn(() => Promise.reject(new Error("offline")));
    vi.stubGlobal("fetch", fetchMock);
    const server = await boot(env);

    const first = await read(server, "/api/report");
    expect(used(first.body)).toBe(40);
    await until(() => fetchMock.mock.calls.length === 1);

    const next = await read(server, "/api/report");
    expect(next.status).toBe(200);
    expect(used(next.body)).toBe(40); // the failed call kept the reading
  });

  it("keeps a no-cache result in memory without writing a cache", async () => {
    const { root, at, env } = quotaRoot(240_000);
    const noCache = { ...env, TOKEN_FURNACE_NO_CACHE: "1" };
    let release: (value: unknown) => void = () => {};
    const fetchMock = vi.fn(() => new Promise((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const server = await boot(noCache);

    expect(used((await read(server, "/api/report")).body)).toBeNull();
    await until(() => fetchMock.mock.calls.length === 1);
    release(sevenDay(88, at));

    expect(await reportUntil(server, 88)).toBe(88);
    expect(existsSync(join(root, "token-furnace", "usage.json"))).toBe(false);
  });

  it("makes one fetch for concurrent requests", async () => {
    const { at, env } = quotaRoot(360_000);
    let release: (value: unknown) => void = () => {};
    const fetchMock = vi.fn(() => new Promise((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const server = await boot(env);

    const replies = await Promise.all([read(server, "/api/report"), read(server, "/api/report"), read(server, "/api/report")]);
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    await until(() => fetchMock.mock.calls.length === 1);
    await new Promise((next) => setTimeout(next, 20));
    expect(fetchMock.mock.calls.length).toBe(1);

    release(sevenDay(55, at));
    expect(await reportUntil(server, 55)).toBe(55);
  });
});

function sevenDay(utilization: number, now: Date): Response {
  const resets = now.getTime() / 1000 + 3 * 86_400;
  return new Response(JSON.stringify({ seven_day: { utilization, resets_at: resets } }), { status: 200 });
}
describe("configuration repair endpoint", () => {
  it("rejects unconfirmed or cross-origin writes and applies the shared CLI repair after confirmation", async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), "tf-server-fix-"));
    const app = compose({ HOME: home }, { noCache: true });
    const server = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
    const post = (headers: Record<string, string>) => new Promise<{ status: number; body: string }>((done, reject) => {
      const req = request(`${server.url}/api/fix-config`, { method: "POST", headers }, (res) => {
        let body = "";
        res.on("data", (data) => { body += data; });
        res.on("end", () => done({ status: res.statusCode!, body }));
      });
      req.on("error", reject); req.end();
    });
    try {
      expect((await post({})).status).toBe(403);
      expect((await post({ "X-Token-Furnace-Confirm": "true", Origin: "https://evil.example" })).status).toBe(403);
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
      expect((await post({ "X-Token-Furnace-Confirm": "true", "X-Token-Furnace-Repairs": "unknown" })).status).toBe(400);
      expect((await post({ "X-Token-Furnace-Confirm": "true", "X-Token-Furnace-Repairs": "codex-context" })).status).toBe(200);
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).not.toContain("[agents]");
      const result = await post({ "X-Token-Furnace-Confirm": "true", Origin: server.url });
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body).ok).toBe(true);
      expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).autoCompactWindow).toBe(400000);
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("model_auto_compact_token_limit = 300000");
      expect((await post({ "X-Token-Furnace-Confirm": "true", "X-Token-Furnace-Include-Depth": "true" })).status).toBe(200);
      expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1");
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("max_depth = 1");
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("lists only repairs that would still change a file", async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), "tf-server-pending-"));
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    const app = compose({ HOME: home }, { noCache: true });
    const server = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
    const pending = async () => ((await (await fetch(`${server.url}/api/fix-config`)).json()) as { pending: string[] }).pending;
    try {
      expect(await pending()).toHaveLength(9);
      rmSync(join(home, ".codex"), { recursive: true });
      expect((await pending()).every((id) => id.startsWith("claude-"))).toBe(true); // Claude-only: no Codex repairs
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
      const done = await fetch(`${server.url}/api/fix-config`, { method: "POST", headers: { "X-Token-Furnace-Confirm": "true", "X-Token-Furnace-Repairs": "claude-context,claude-workers,codex-context" } });
      expect(done.status).toBe(200);
      expect(await pending()).toEqual(["claude-tools", "claude-model", "claude-depth", "codex-workers", "codex-effort", "codex-depth"]);
      const before = readFileSync(join(home, ".claude", "settings.json"), "utf8");
      await pending();
      expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(before); // listing never writes
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
