/** The worker-thread scan gives the same Report as the in-process scan. */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsup";
import { beforeAll, describe, expect, it } from "vitest";
import { ClaudeSource } from "../src/sources/claude";
import { CodexSource } from "../src/sources/codex";
import { MemorySessionRepository } from "../src/repo/memory-repo";
import { ReportService } from "../src/services/report-service";
import { assistant, buildFull } from "./fixtures/build";
import { fixedNow, harnessEnv } from "./harness";

const now = fixedNow();
const root = mkdtempSync(join(tmpdir(), "tf-pool-"));
buildFull(root, now);
const many = join(root, "projects", "many");
mkdirSync(many, { recursive: true });
for (let i = 0; i < 30; i++) {
  writeFileSync(join(many, `s-${i}.jsonl`), `${assistant(new Date(now.getTime() - (i + 1) * 60_000), 50_000)}\n`);
}
// Codex rollouts with rate_limits, some with identical mtime to test tie-breaking parity
const codexDir = join(root, "codex", "sessions", "2026", "10");
mkdirSync(codexDir, { recursive: true });
const resetTime = Math.floor(now.getTime() / 1000) + 86_400;
const reading = (used: number) =>
  JSON.stringify({
    payload: { rate_limits: { primary: { window_minutes: 10080, used_percent: used, resets_at: resetTime } } },
  });
const codexA = join(codexDir, "rollout-2026-10-09T01-00-00-a.jsonl");
const codexB = join(codexDir, "rollout-2026-10-09T01-00-00-b.jsonl");
writeFileSync(codexA, reading(5) + "\n");
writeFileSync(codexB, reading(15) + "\n");
const later = new Date("2100-01-01T00:00:00Z");
utimesSync(codexA, later, later);
utimesSync(codexB, later, later);
const env = harnessEnv(root, now);
let workerUrl: URL;

beforeAll(async () => {
  // The worker is a built script: bundle it the way `npm run build` does, into a scratch folder.
  const out = mkdtempSync(join(tmpdir(), "tf-worker-"));
  await build({
    entry: { "scan-worker": "src/scan-worker.ts" },
    outDir: out,
    format: ["esm"],
    platform: "node",
    target: "node22",
    silent: true,
    clean: false,
    dts: false,
  });
  workerUrl = pathToFileURL(join(out, "scan-worker.js"));
}, 60_000);

function service(workers: { url: URL; size: number } | null): ReportService {
  const sources = [new ClaudeSource(env), new CodexSource(env)];
  return new ReportService(sources, new MemorySessionRepository(), env, workers);
}

describe("worker-thread scan", () => {
  it("builds the same Report as the main-thread scan, with progress", async () => {
    const inline = service(null);
    await inline.refresh();
    const threaded = service({ url: workerUrl, size: 4 });
    const seen: number[] = [];
    await threaded.refresh((p) => seen.push(p.filesDone));

    const opts = { weeklyBudget: null, now };
    const threadedReport = threaded.getReport(7, "all", opts);
    const inlineReport = inline.getReport(7, "all", opts);
    expect(threadedReport).toEqual(inlineReport);
    expect(inlineReport?.burns.codex?.used).toBe(5);
    expect(threadedReport?.burns.codex?.used).toBe(5);
    expect(threaded.progress.filesTotal).toBeGreaterThan(30);
    expect(threaded.progress.filesDone).toBe(threaded.progress.filesTotal);
    expect(seen.length).toBeGreaterThan(30);
  }, 60_000);

  it.each([0, 1])(
    "falls back to in-process parsing and records identical results when worker exits with code %i",
    async (exitCode) => {
      const crashDir = mkdtempSync(join(tmpdir(), "tf-crash-worker-"));
      const crashWorkerPath = join(crashDir, `crash-worker-${exitCode}.mjs`);
      writeFileSync(crashWorkerPath, `process.exit(${exitCode});\n`);
      const crashUrl = pathToFileURL(crashWorkerPath);

      const inline = service(null);
      await inline.refresh();

      const fallingBackService = service({ url: crashUrl, size: 2 });
      await fallingBackService.refresh();

      const opts = { weeklyBudget: null, now };
      const expectedReport = inline.getReport(7, "all", opts);
      const report = fallingBackService.getReport(7, "all", opts);
      expect(report).toEqual(expectedReport);
      expect(fallingBackService.progress.filesDone).toBe(fallingBackService.progress.filesTotal);
      expect(fallingBackService.progress.filesTotal).toBeGreaterThan(30);
    },
    60_000,
  );

  it("rejects refresh when fallback in-process parsing throws", async () => {
    const crashDir = mkdtempSync(join(tmpdir(), "tf-crash-worker-"));
    const crashWorkerPath = join(crashDir, "crash-worker.mjs");
    writeFileSync(crashWorkerPath, "process.exit(1);\n");
    const crashUrl = pathToFileURL(crashWorkerPath);

    const throwingSource = new ClaudeSource(env);
    throwingSource.parse = () => {
      throw new Error("unreadable transcript");
    };
    const failingService = new ReportService(
      [throwingSource, new CodexSource(env)],
      new MemorySessionRepository(),
      env,
      { url: crashUrl, size: 2 },
    );

    await expect(failingService.refresh()).rejects.toThrow("unreadable transcript");
  }, 60_000);

  it.each([1, 4])("parses single pending file with worker (size %i) when main-thread throws", async (size) => {
    const oneDir = mkdtempSync(join(tmpdir(), "tf-one-"));
    const singleEnv = harnessEnv(oneDir, now);
    const file = join(oneDir, "projects", "single", "session.jsonl");
    mkdirSync(join(oneDir, "projects", "single"), { recursive: true });
    writeFileSync(file, `${assistant(new Date(now.getTime() - 60_000), 12_345)}\n`);

    const expectedService = new ReportService(
      [new ClaudeSource(singleEnv)],
      new MemorySessionRepository(),
      singleEnv,
      null,
    );
    await expectedService.refresh();
    const expectedReport = expectedService.getReport(7, "claude", { weeklyBudget: null, now });

    const failingSource = new ClaudeSource(singleEnv);
    failingSource.parse = () => {
      throw new Error("main thread must not parse this file");
    };
    const workerService = new ReportService(
      [failingSource],
      new MemorySessionRepository(),
      singleEnv,
      { url: workerUrl, size },
    );
    await workerService.refresh();

    expect(workerService.progress.filesTotal).toBe(1);
    expect(workerService.progress.filesDone).toBe(1);
    expect(workerService.getReport(7, "claude", { weeklyBudget: null, now })).toEqual(expectedReport);
  }, 60_000);
});
