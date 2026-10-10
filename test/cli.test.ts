/**
 * The CLI against the fixtures. The doctor and full text are compared with test/golden/*.txt,
 * which scripts/burn.py wrote on this same fixture before PRD-003 deleted it.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { compose } from "../src/compose";
import { assistant, buildFull, user } from "./fixtures/build";
import { fixedNow, harnessEnv, tsReport } from "./harness";

const HOUR = 3_600_000;
const MINUTE = 60_000;

const now = fixedNow();
const leaksRoot = mkdtempSync(join(tmpdir(), "tf-cli-leaks-"));
const cleanRoot = mkdtempSync(join(tmpdir(), "tf-cli-clean-"));
const emptyRoot = mkdtempSync(join(tmpdir(), "tf-cli-empty-"));
const htmlPath = join(leaksRoot, "out", "report.html");

buildFull(leaksRoot, now);
buildClean(cleanRoot, now);

/** One healthy session and settings that pass every check: the doctor exits 0 here. */
function buildClean(root: string, at: Date): void {
  const lines = [user(new Date(at.getTime() - HOUR), "go")];
  for (let i = 0; i < 10; i++) {
    lines.push(assistant(new Date(at.getTime() - HOUR + i * MINUTE), 200_000));
  }
  write(join(root, "projects", "demo", "s-clean.jsonl"), lines);
  writeJson(join(root, "settings.json"), {
    autoCompactWindow: 200_000,
    env: {
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "3",
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
      CLAUDE_CODE_SUBAGENT_MODEL: "sonnet",
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "4",
    },
  });
}

function write(path: string, lines: string[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function env(root: string): NodeJS.ProcessEnv {
  return { ...harnessEnv(root, now), TOKEN_FURNACE_NOW: now.toISOString() };
}

/** The clock moves the weekly reset label and the fixture's own paths; neither is the verdict. */
function mask(text: string, root: string): string {
  return text.replaceAll(root, "<root>").replace(/(weekly reset )\w{3} \d\d:\d\d/g, "$1<when>");
}

/** Run the CLI with stdout and stderr captured. */
async function run(argv: string[], root: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv, compose(env(root))), out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

const golden = (name: string): string => readFileSync(join(import.meta.dirname, "golden", name), "utf8");

describe("--json", () => {
  it("prints toView(buildReport(...)) and nothing else on stdout", async () => {
    const run1 = await run(["--json", "--plan-usage"], leaksRoot);
    expect(run1.err).toBe("");
    expect(run1.code).toBe(0);
    expect(run1.out.endsWith("\n")).toBe(true);
    expect(run1.out.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(run1.out)).toEqual(tsReport(env(leaksRoot), now, 7, null, "all"));
  });

  it("writes the no-data notice to stderr, so stdout stays the Report alone", async () => {
    const run1 = await run(["--json"], emptyRoot);
    expect(run1.out).toBe("");
    expect(run1.err).toContain("No transcripts found");
    expect(run1.code).toBe(1);
  });
});

describe("the doctor verdict", () => {
  it("matches the burn.py golden on the leaks fixture and exits 1", async () => {
    const run1 = await run([], leaksRoot);
    expect(mask(run1.out, leaksRoot)).toBe(mask(golden("doctor.txt"), leaksRoot));
    expect(run1.code).toBe(1);
  });

  it("exits 1 with no data", async () => {
    const run1 = await run([], emptyRoot);
    expect(run1.out).toBe("No transcripts found. Try --list-sources.\n");
    expect(run1.code).toBe(1);
  });

  it("exits 0 on a clean fixture", async () => {
    const run1 = await run([], cleanRoot);
    expect(run1.out).toContain("Verdict: healthy. No common token leaks in the last 24 h.");
    expect(run1.code).toBe(0);
  });
});

describe("--full", () => {
  it("matches the burn.py golden text report and exits 0", async () => {
    const run1 = await run(["--full"], leaksRoot);
    expect(mask(run1.out, leaksRoot)).toBe(mask(golden("full.txt"), leaksRoot));
    expect(run1.code).toBe(0);
  });
});

describe("network", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("makes no call without --plan-usage", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const run1 = await run([], leaksRoot);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(run1.code).toBe(1);
    // Without the opt-in the report says the subscription reading was unavailable.
    expect(run1.out).toContain("the subscription usage was unavailable");
  });
});

describe("--html", () => {
  it("writes one self-contained page with the report inlined", async () => {
    const run1 = await run(["--html", htmlPath], leaksRoot);
    expect(run1.code).toBe(1);
    expect(run1.out).toContain(`Report: ${htmlPath}`);
    const page = readFileSync(htmlPath, "utf8");
    expect(page).not.toContain("/*REPORT*/null"); // the report replaced the placeholder
    expect(page).toContain("window.__REPORT__ = {");
    // The leak list the page draws is in the file, so it shows with no server and no network.
    expect(page).toContain("Sessions compact too late");
    expect(page).toContain("The caller reads files and logs itself");
    expect(page).toContain("<script"); // the page itself, not only data
  });
});

describe("--list-sources", () => {
  it("names each agent, its path and its transcript count", async () => {
    const run1 = await run(["--list-sources"], leaksRoot);
    expect(run1.code).toBe(0);
    expect(run1.out).toMatch(/^ {2}claude\s+\S*projects\s+3 transcripts$/m);
    expect(run1.out).toMatch(/^ {2}codex\s+\S*codex\/sessions\s+1 transcripts$/m);
    const missing = await run(["--list-sources"], emptyRoot);
    expect(missing.out).toContain("not installed");
  });
});

describe("usage errors", () => {
  it("prints --help and rejects a bad days argument with 2", async () => {
    const run1 = await run(["--help"], leaksRoot);
    expect(run1.code).toBe(0);
    expect(run1.out).toContain("Usage: token-furnace");
    expect((await run(["x"], leaksRoot)).code).toBe(2);
    expect((await run(["--source", "gemini"], leaksRoot)).code).toBe(2);
  });
});