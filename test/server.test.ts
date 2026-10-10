/** The live server: the Report over HTTP, the raw page for hot reload, and the Host check. */

import { request } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose } from "../src/compose";
import { startServer, type LiveServer } from "../src/server";
import { buildFull, saveUsageReading } from "./fixtures/build";
import { fixedNow, harnessEnv, tsReport } from "./harness";

const now = fixedNow();
const root = mkdtempSync(join(tmpdir(), "tf-server-"));
buildFull(root, now);
// A saved subscription reading: the default run makes no network call and still has a Claude week.
saveUsageReading(root, now);
const env = { ...harnessEnv(root, now), TOKEN_FURNACE_NOW: now.toISOString() };
const app = compose(env);

let live: LiveServer;

beforeAll(async () => {
  live = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
});

afterAll(() => live.close());

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
  it("binds 127.0.0.1 only: the LAN address on that port is refused", async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((nic) => nic && !nic.internal && nic.family === "IPv4");
    if (!lan) return; // no network on this machine to try
    const code = await new Promise<string | null>((done) => {
      const socket = connect({ host: lan.address, port: live.port });
      socket.on("connect", () => {
        socket.destroy();
        done(null);
      });
      socket.on("error", (error: NodeJS.ErrnoException) => done(error.code ?? "error"));
    });
    expect(code).toBe("ECONNREFUSED");
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