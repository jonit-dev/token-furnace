/** PRD-008: the first scan never blocks the server, and the page shows progress while it runs. */

import { mkdirSync, realpathSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose } from "../src/compose";
import { startServer, type LiveServer } from "../src/server";
import { assistant, buildFull } from "./fixtures/build";
import { fixedNow, harnessEnv, tsReport } from "./harness";

const now = fixedNow();
const root = mkdtempSync(join(realpathSync(tmpdir()), "tf-progress-"));
buildFull(root, now);
// Forty more small sessions, so the scan has many files and yields many times.
const many = join(root, "projects", "many");
mkdirSync(many, { recursive: true });
for (let i = 0; i < 40; i++) {
  const when = new Date(now.getTime() - (i + 1) * 60_000);
  writeFileSync(join(many, `s-${i}.jsonl`), `${assistant(when, 50_000)}\n`);
}
const env = { ...harnessEnv(root, now), TOKEN_FURNACE_NOW: now.toISOString() };
const app = compose(env);

// Each parse costs 25 ms, so the scan yields to the event loop every other file, like a big cold scan.
for (const source of app.sources) {
  const parse = source.parse.bind(source);
  source.parse = (path: string) => {
    const until = Date.now() + 25;
    while (Date.now() < until) {
      /* busy: a stand-in for parsing a large transcript */
    }
    return parse(path);
  };
}

let live: LiveServer;
beforeAll(async () => {
  live = await startServer(app, { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
});
afterAll(() => live.close());

function get(path: string): Promise<{ status: number; body: string; ms: number }> {
  const started = Date.now();
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port: live.port, path, headers: { Host: `127.0.0.1:${live.port}` } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, body, ms: Date.now() - started }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

describe("first scan", () => {
  it("answers /api/status, /api/report and / while scanning", async () => {
    expect(app.reports.hasScanned).toBe(false);

    // Together, so a slow file in the middle of the scan cannot let it finish between two reads.
    const [status, report, page] = await Promise.all([get("/api/status"), get("/api/report"), get("/")]);
    expect(status.status).toBe(200);
    expect(status.ms).toBeLessThan(200); // match PRD-008's response-time limit
    const first = JSON.parse(status.body);
    expect(first.phase).toBe("scanning");
    expect(first.filesTotal).toBeGreaterThan(1);

    expect(report.status).toBe(202);
    expect(JSON.parse(report.body).status).toBe("scanning");

    expect(page.status).toBe(200);
    expect(page.body).toContain("Please wait");
    expect(page.body).toContain("/api/status");
    expect(page.body).toContain("location.reload()");
    expect(page.body).toContain("progressbar");
  });

  it("makes progress, then serves the same Report as a blocking scan", async () => {
    let status = JSON.parse((await get("/api/status")).body);
    const seen = new Set<number>([status.filesDone]);
    for (let i = 0; i < 200 && status.phase !== "ready"; i++) {
      await new Promise((next) => setTimeout(next, 10));
      status = JSON.parse((await get("/api/status")).body);
      seen.add(status.filesDone);
    }
    expect(status.phase).toBe("ready");
    expect(seen.size).toBeGreaterThan(1); // filesDone rose between reads

    const report = await get("/api/report");
    expect(report.status).toBe(200);
    expect(JSON.parse(report.body)).toEqual(tsReport(env, now, 7, null, "all"));
    const page = await get("/");
    expect(page.body).toContain("window.__REPORT__ = {");
  });
});
