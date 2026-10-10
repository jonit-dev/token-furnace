#!/usr/bin/env node
/**
 * PRD-009 benchmark harness: reusable evaluator for the local transcript scan.
 *
 * It freezes the real Claude/Codex transcript corpora into a private reflink snapshot, records a
 * deterministic manifest and clock, times the built CLI from process start to a complete JSON
 * report, and compares candidate bytes with the baseline oracle by default. It prints only the
 * timing, corpus size, report hash and exit code; transcript text, titles and report JSON never
 * reach the terminal.
 *
 *   node scripts/bench-scan.mjs snapshot            freeze corpus, write manifest and pointer
 *   node scripts/bench-scan.mjs reindex             rebuild a manifest from the frozen destination once
 *   node scripts/bench-scan.mjs run --mode cold --runs 1 --record-oracle
 *   node scripts/bench-scan.mjs run --mode warm
 *   node scripts/bench-scan.mjs verify              candidate cold runs vs the oracle, each under 10 s
 *   node scripts/bench-scan.mjs status              snapshot, manifest and oracle summary
 *   node scripts/bench-scan.mjs self-test           synthetic check of freeze/parity/failure/speed gates
 *
 * `run` exits non-zero on any timeout, invalid report shape or oracle mismatch (not on speed, since a
 * baseline is slow by design). `verify` adds the per-run under-10-second speed gate.
 *
 * Options: --snapshot DIR, --cli FILE, --node FILE, --base DIR, --runs N, --timeout SEC,
 *          --record-oracle, --nocache. `--force` only applies to the `snapshot` command.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { cpus, homedir, loadavg, tmpdir, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const WORKTREE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = join(process.env.BENCH_TMPDIR || join(homedir(), ".cache"), "token-furnace-bench");
const NODE24 = "/home/joao/.nvm/versions/node/v24.16.0/bin/node";
const TIMEOUT_MS = 240_000;
const SPEED_LIMIT_S = 10;
const WORKERS = "8";
const MAX_BUFFER = 512 * 1024 * 1024;
const CLOCK_PAD_MS = 60_000;
const MANIFEST_VERSION = 1;

/** Env vars an isolated run must not inherit from the developer's shell. */
const CLEARED = [
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
  "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY",
  "TOKEN_FURNACE_WEEKLY_BUDGET",
  "TOKEN_FURNACE_USAGE_URL",
  "npm_config_package",
];

const fail = (message) => {
  process.stderr.write(`bench-scan: ${message}\n`);
  process.exit(1);
};
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const shortHash = (buffer) => sha256(buffer).slice(0, 12);
const dir = (path) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // a chmod we cannot apply is not worth failing the run
  }
  return path;
};

/**
 * Every regular file under root, following symlinks, with path/size/mtime. Skips broken links and
 * refuses to re-enter a directory it already visited (identity by real path), so a symlink cycle
 * cannot loop forever.
 */
function walk(root, source) {
  const out = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    let real;
    try {
      real = realpathSync(current);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      let stat;
      try {
        stat = statSync(path); // follows symlinks, so a link is frozen as its target's bytes
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(path);
      else if (stat.isFile()) {
        out.push({ path, rel: relative(root, path), size: stat.size, mtimeMs: stat.mtimeMs, source });
      }
    }
  }
  return out;
}

/** Reflink-copy one tree at private (0600) permissions. Never hardlinks. mtime must be preserved. */
function copyTree(srcRoot, dstRoot, source = "") {
  const files = walk(srcRoot, source);
  for (const file of files) {
    const dst = join(dstRoot, file.rel);
    dir(dirname(dst));
    copyFileSync(file.path, dst, constants.COPYFILE_FICLONE);
    try {
      chmodSync(dst, 0o600);
    } catch {
      /* ignore */
    }
    // mtime is part of the frozen contract, not a nicety: a failed set fails the freeze
    utimesSync(dst, new Date(file.mtimeMs), new Date(file.mtimeMs));
  }
  return files;
}

/** The private snapshot root: an explicit flag, else the pointer file, else null. */
function resolveSnapshot(cli) {
  if (cli.snapshot) return resolve(cli.snapshot);
  const pointer = join(cli.base, ".snapshot");
  if (existsSync(pointer)) return readFileSync(pointer, "utf8").trim();
  return null;
}

/** Create a fresh mkdtemp 0700 snapshot of both corpora and write its manifest and pointer. */
function snapshot(cli, roots = {}) {
  const base = dir(cli.base);
  const claudeRoot = roots.claude || process.env.BENCH_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");
  const codexRoot = roots.codex || process.env.BENCH_CODEX_SESSIONS || join(homedir(), ".codex", "sessions");
  for (const root of [claudeRoot, codexRoot]) {
    if (!existsSync(root)) fail(`corpus root not found: ${root}`);
  }

  const snap = mkdtempSync(join(base, "snap-"));
  try {
    chmodSync(snap, 0o700);
  } catch {
    /* ignore */
  }
  for (const sub of ["claude", "codex", "home", "cache", "oracle", "logs"]) dir(join(snap, sub));

  const claude = copyTree(claudeRoot, join(snap, "claude", "projects"), "claude");
  const codex = copyTree(codexRoot, join(snap, "codex", "sessions"), "codex");

  // Record the frozen copy, never the live source: a source append during the copy must not
  // desync the manifest from the bytes actually frozen.
  const frozen = [
    ...walk(join(snap, "claude", "projects"), "claude"),
    ...walk(join(snap, "codex", "sessions"), "codex"),
  ];
  const expectedFiles = claude.length + codex.length;
  if (frozen.length !== expectedFiles) fail(`freeze count mismatch: ${frozen.length} copied vs ${expectedFiles} listed`);

  const sourceSummary = (name) => {
    const list = frozen.filter((file) => file.source === name);
    return { name, root: name === "claude" ? claudeRoot : codexRoot, files: list.length, bytes: list.reduce((sum, file) => sum + file.size, 0) };
  };
  const maxMtime = frozen.reduce((max, file) => Math.max(max, file.mtimeMs), 0);
  const manifest = {
    version: MANIFEST_VERSION,
    created: new Date().toISOString(),
    clock: new Date(maxMtime + CLOCK_PAD_MS).toISOString(),
    sources: [sourceSummary("claude"), sourceSummary("codex")],
    files: frozen.map(({ source, rel, size, mtimeMs }) => ({ source, rel, size, mtimeMs })),
    filesTotal: frozen.length,
    bytesTotal: frozen.reduce((sum, file) => sum + file.size, 0),
  };
  writeFileSync(join(snap, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(cli.base, ".snapshot"), `${snap}\n`);

  const line = `snapshot path=${snap} files=${manifest.filesTotal} bytes=${manifest.bytesTotal} clock=${manifest.clock}`;
  process.stdout.write(`${line}\n`);
  return snap;
}

function readManifest(snap) {
  const path = join(snap, "manifest.json");
  if (!existsSync(path)) fail(`no manifest at ${path}; run the snapshot command first`);
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * One-time recovery: rebuild the manifest from the bytes already frozen on disk. Keeps the original
 * clock and creation time, backs up the old manifest at 0600, and never touches transcripts or the
 * oracle. Needed when a manifest was written from live-source stats instead of the frozen copy.
 */
function reindex(options) {
  const snap = resolveSnapshot(options);
  if (!snap) fail("no snapshot; run `snapshot` first");
  const path = join(snap, "manifest.json");
  if (!existsSync(path)) fail(`no manifest at ${path}; run the snapshot command first`);
  const old = JSON.parse(readFileSync(path, "utf8"));
  const frozen = [];
  for (const source of ["claude", "codex"]) frozen.push(...walk(join(snap, SNAPSHOT_SUBDIR[source]), source));
  const backup = `${path}.bak-${Date.now()}`;
  writeFileSync(backup, readFileSync(path));
  try {
    chmodSync(backup, 0o600);
  } catch {
    /* ignore */
  }
  const sourceSummary = (name) => {
    const list = frozen.filter((file) => file.source === name);
    return { name, root: old.sources?.find((s) => s.name === name)?.root || "", files: list.length, bytes: list.reduce((sum, file) => sum + file.size, 0) };
  };
  const manifest = {
    version: old.version ?? MANIFEST_VERSION,
    created: old.created ?? new Date().toISOString(),
    clock: old.clock,
    sources: [sourceSummary("claude"), sourceSummary("codex")],
    files: frozen.map(({ source, rel, size, mtimeMs }) => ({ source, rel, size, mtimeMs })),
    filesTotal: frozen.length,
    bytesTotal: frozen.reduce((sum, file) => sum + file.size, 0),
  };
  writeFileSync(path, JSON.stringify(manifest));
  process.stdout.write(`reindex path=${snap} files=${manifest.filesTotal} bytes=${manifest.bytesTotal} clock=${manifest.clock} backup=${backup}\n`);
}

/** Where each frozen source lives inside the snapshot, matching the `snapshot` layout. */
const SNAPSHOT_SUBDIR = { claude: join("claude", "projects"), codex: join("codex", "sessions") };

/** A full sha256 over every file in a bundle (dist), path order fixed for reproducibility. */
function hashBundle(root) {
  const files = walk(root, "").sort((a, b) => a.rel.localeCompare(b.rel));
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.rel);
    digest.update("\0");
    digest.update(readFileSync(file.path));
    digest.update("\0");
  }
  return digest.digest("hex");
}

/**
 * Re-check the frozen snapshot against its manifest before any timed run, so a run can never score a
 * corpus that drifted after the freeze. The key is source+rel, so two sources that share a relative
 * path are never confused, and the compared metadata (size and mtime) is the frozen manifest's, never
 * the live source's. Failure messages name only entry indexes, never transcript paths or content.
 */
function validateFrozen(snap, manifest) {
  const actual = [];
  for (const source of ["claude", "codex"]) {
    actual.push(...walk(join(snap, SNAPSHOT_SUBDIR[source]), source));
  }
  if (actual.length !== manifest.files.length) {
    throw new Error(`frozen validation: ${actual.length} files on disk vs ${manifest.files.length} in manifest`);
  }
  const byKey = new Map();
  for (const file of actual) byKey.set(`${file.source}\0${file.rel}`, file);
  for (const [i, file] of manifest.files.entries()) {
    const at = byKey.get(`${file.source}\0${file.rel}`);
    if (!at) throw new Error(`frozen validation: entry ${i} not found in snapshot`);
    if (at.size !== file.size) throw new Error(`frozen validation: entry ${i} size changed since freeze`);
    if (Math.abs(at.mtimeMs - file.mtimeMs) >= 1) throw new Error(`frozen validation: entry ${i} mtime changed since freeze`);
  }
}

/** Turn a validation failure into the harness exit path. */
function assertFrozen(snap, manifest) {
  try {
    validateFrozen(snap, manifest);
  } catch (error) {
    fail(error.message);
  }
}

/** The isolated environment for one run: snapshot config dirs, a private cache, a frozen clock. */
function runEnv(snap, cacheDir, manifest) {
  const env = { ...process.env, HOME: join(snap, "home"), XDG_CACHE_HOME: cacheDir };
  for (const key of CLEARED) delete env[key];
  env.CLAUDE_CONFIG_DIR = join(snap, "claude");
  env.CODEX_HOME = join(snap, "codex");
  env.TOKEN_FURNACE_NOW = manifest.clock;
  env.TOKEN_FURNACE_NO_CACHE = "0";
  env.TOKEN_FURNACE_WORKERS = WORKERS; // pinned so a run does not inherit the shell's worker count
  env.npm_config_update_notifier = "false";
  return env;
}

/** A weak report is not a report: reject a zero-session, zero-turn or zero-token shape. */
function shapeOk(parsed) {
  return (
    parsed != null &&
    typeof parsed.generated === "string" &&
    typeof parsed.sessions === "number" && parsed.sessions > 0 &&
    typeof parsed.turns === "number" && parsed.turns > 0 &&
    typeof parsed.total === "number" && parsed.total > 0 &&
    Array.isArray(parsed.issues)
  );
}

/** One timed CLI run. Returns timing, hash and validity; never prints report content. */
function runOnce({ snap, manifest, cliPath, nodeBin, mode, timeoutMs, nocache }) {
  const cacheRoot = dir(join(snap, "cache"));
  const cacheDir = mode === "warm" ? dir(join(cacheRoot, "warm")) : (() => {
    const fresh = mkdtempSync(join(cacheRoot, "cold-"));
    try {
      chmodSync(fresh, 0o700);
    } catch {
      /* ignore */
    }
    return fresh;
  })();

  const args = [cliPath, "--json", "--no-plan-usage"];
  if (nocache) args.push("--no-cache");
  const started = process.hrtime.bigint();
  const res = spawnSync(nodeBin, args, {
    cwd: WORKTREE,
    env: runEnv(snap, cacheDir, manifest),
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER,
    encoding: "buffer",
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;

  const out = res.stdout ? Buffer.from(res.stdout) : Buffer.alloc(0);
  const err = res.stderr ? Buffer.from(res.stderr) : Buffer.alloc(0);
  const stamp = `${mode}-${Date.now()}`;
  writeFileSync(join(snap, "logs", `${stamp}.out`), out);
  writeFileSync(join(snap, "logs", `${stamp}.err`), err);

  const timedOut = res.error?.code === "ETIMEDOUT" || res.signal === "SIGKILL";
  let parsedOk = false;
  if (out.length) {
    try {
      parsedOk = shapeOk(JSON.parse(out.toString("utf8")));
    } catch {
      parsedOk = false; // content never leaves this process
    }
  }
  return {
    mode,
    seconds,
    exit: timedOut ? "TIMEOUT" : String(res.status),
    signal: res.signal || null,
    timedOut,
    parsedOk,
    hash: shortHash(out),
    out,
    bytes: out.length,
  };
}

function loadSummary() {
  const [one, five] = loadavg();
  return { load1: Number(one.toFixed(2)), load5: Number(five.toFixed(2)), cpus: cpus().length, memGB: Math.round(totalmem() / 1e9) };
}

/** Compare candidate bytes with the oracle bytes; returns match state and first-diff offset. */
function compareBytes(oracle, out) {
  if (oracle.equals(out)) return { state: "match" };
  const limit = Math.min(oracle.length, out.length);
  let at = limit;
  for (let i = 0; i < limit; i++) {
    if (oracle[i] !== out[i]) {
      at = i;
      break;
    }
  }
  return { state: "mismatch", at };
}

/** compareBytes against the oracle file on disk, or "absent" when none was recorded. */
function compareOracle(snap, out) {
  const oraclePath = join(snap, "oracle", "report.json");
  if (!existsSync(oraclePath)) return { state: "absent" };
  return compareBytes(readFileSync(oraclePath), out);
}

/** Results that must fail a run: timeout, invalid report or oracle mismatch. `speed` adds the 10 s gate. */
function failures(results, { speed = false } = {}) {
  return results.filter(
    (r) => r.exit !== "0" || r.timedOut || !r.parsedOk || r.oracle?.state === "mismatch" || (speed && (r.seconds >= SPEED_LIMIT_S || r.oracle?.state !== "match")),
  );
}

/** Baseline or candidate runs. Records the oracle only when asked and never silently. */
function runRuns(options) {
  const snap = resolveSnapshot(options);
  if (!snap) fail("no snapshot; run `snapshot` first (or pass --snapshot)");
  const manifest = readManifest(snap);
  assertFrozen(snap, manifest);
  const cliPath = options.cli || join(WORKTREE, "dist", "cli.js");
  if (!existsSync(cliPath)) fail(`no built CLI at ${cliPath}; run npm ci && npm run build`);
  const distHash = hashBundle(dirname(cliPath));
  const nodeBin = options.node || process.env.BENCH_NODE || (existsSync(NODE24) ? NODE24 : process.execPath);
  const timeoutMs = (Number(options.timeout) || TIMEOUT_MS / 1000) * 1000;
  const runs = Math.max(1, Number(options.runs) || 1);
  const mode = options.mode || "cold";
  const oraclePath = join(snap, "oracle", "report.json");
  const oracleExists = existsSync(oraclePath);

  if (!oracleExists && !options.recordOracle) process.stderr.write("bench-scan: warning: no baseline oracle; runs cannot be compared (record one with --record-oracle)\n");
  // the oracle is immutable: never overwrite one, regardless of flags
  if (oracleExists && options.recordOracle) fail("oracle already exists for this snapshot; refusing to overwrite");

  const load = loadSummary();
  process.stdout.write(
    `bench node=${nodeBin} dist=${distHash} snap=${snap} files=${manifest.filesTotal} bytes=${manifest.bytesTotal} clock=${manifest.clock} load1=${load.load1} cpus=${load.cpus}\n`,
  );

  if (mode === "warm") {
    const prime = runOnce({ snap, manifest, cliPath, nodeBin, mode: "warm", timeoutMs, nocache: options.nocache });
    if (prime.exit !== "0" || prime.timedOut || !prime.parsedOk || compareOracle(snap, prime.out).state === "mismatch") fail(`warm prime failed (exit=${prime.exit}, parsed=${prime.parsedOk}); cache was not warmed`);
  }

  const results = [];
  let oracleWritten = false;
  for (let i = 0; i < runs; i++) {
    const result = runOnce({ snap, manifest, cliPath, nodeBin, mode, timeoutMs, nocache: options.nocache });
    let oracle = { state: "absent" };
    if (result.parsedOk && result.exit === "0") {
      if (!oracleExists && options.recordOracle && !oracleWritten) {
        writeFileSync(oraclePath, result.out);
        writeFileSync(
          join(snap, "oracle", "meta.json"),
          JSON.stringify({ mode, hash: sha256(result.out), seconds: result.seconds, node: nodeBin, dist: distHash, files: manifest.filesTotal, bytes: manifest.bytesTotal, clock: manifest.clock, recorded: new Date().toISOString() }),
        );
        oracle = { state: "recorded" };
        oracleWritten = true;
      } else {
        oracle = compareOracle(snap, result.out);
      }
    }
    result.oracle = oracle;
    process.stdout.write(
      `run mode=${mode} seconds=${result.seconds.toFixed(3)} files=${manifest.filesTotal} bytes=${manifest.bytesTotal} sha256=${result.hash} exit=${result.exit} oracle=${oracle.state}${oracle.at != null ? `@${oracle.at}` : ""} parsed=${result.parsedOk}\n`,
    );
    results.push(result);
  }
  return results;
}

function status(options) {
  const snap = resolveSnapshot(options);
  if (!snap) fail("no snapshot; run `snapshot` first");
  const manifest = readManifest(snap);
  assertFrozen(snap, manifest);
  const oraclePath = join(snap, "oracle", "report.json");
  const oracle = existsSync(oraclePath) ? `sha256=${shortHash(readFileSync(oraclePath))}` : "none";
  const cliPath = options.cli || join(WORKTREE, "dist", "cli.js");
  const dist = existsSync(cliPath) ? hashBundle(dirname(cliPath)) : "missing";
  process.stdout.write(`status snap=${snap} files=${manifest.filesTotal} bytes=${manifest.bytesTotal} clock=${manifest.clock} oracle=${oracle} dist=${dist} eval=${shortHash(readFileSync(fileURLToPath(import.meta.url)))}\n`);
}

/**
 * A tiny synthetic self-check: freeze count/bytes/source-identity, mtime preservation, a stable
 * re-copy, frozen-manifest validation, and the failure/parity/speed/shape gates. It builds its own
 * throwaway transcripts and never reads or prints real ones.
 */
function selfTest() {
  const base = mkdtempSync(join(tmpdir(), "tf-bench-selftest-"));
  try {
    const claudeProjects = join(base, "src", "claude", "projects");
    const codexSessions = join(base, "src", "codex", "sessions");
    const claudeRoot = join(claudeProjects, "p");
    const codexRoot = join(codexSessions, "2026", "01");
    dir(claudeRoot);
    dir(codexRoot);
    writeFileSync(join(claudeRoot, "a.jsonl"), '{"type":"user"}\n{"type":"assistant"}\n');
    writeFileSync(join(claudeRoot, "b.jsonl"), "{}\n");
    writeFileSync(join(codexRoot, "rollout-1.jsonl"), "not json\n{}\n");
    // identical relative path ("shared/collide.jsonl") and size in both sources: only a source+rel
    // key can tell them apart, and a change to one must not be excused by the other's match
    dir(join(claudeProjects, "shared"));
    dir(join(codexSessions, "shared"));
    writeFileSync(join(claudeProjects, "shared", "collide.jsonl"), "same-bytes\n");
    writeFileSync(join(codexSessions, "shared", "collide.jsonl"), "same-bytes\n");
    const cli = { base: join(base, "bench"), snapshot: null };
    const snap = snapshot(cli, { claude: claudeProjects, codex: codexSessions });
    const manifest = readManifest(snap);
    const freezeOk =
      manifest.filesTotal === 5 &&
      manifest.sources[0].files === 3 &&
      manifest.sources[1].files === 2 &&
      manifest.sources[0].bytes ===
        statSync(join(claudeRoot, "a.jsonl")).size + statSync(join(claudeRoot, "b.jsonl")).size + statSync(join(claudeProjects, "shared", "collide.jsonl")).size &&
      // every frozen file carries its real source identity, never an empty string
      manifest.files.every((f) => f.source === "claude" || f.source === "codex") &&
      manifest.files.filter((f) => f.source === "claude").length === 3 &&
      manifest.files.filter((f) => f.source === "codex").length === 2 &&
      // mtime preserved within a millisecond
      Math.abs(statSync(join(snap, "claude", "projects", "p", "a.jsonl")).mtimeMs - statSync(join(claudeRoot, "a.jsonl")).mtimeMs) < 1 &&
      // a re-copy into a fresh destination is byte-identical (frozen corpus)
      (() => {
        const before = sha256(readFileSync(join(snap, "claude", "projects", "p", "a.jsonl")));
        const again = copyTree(join(snap, "claude", "projects"), join(base, "recopy"), "claude");
        return sha256(readFileSync(join(base, "recopy", "p", "a.jsonl"))) === before && again.length === 3;
      })();
    validateFrozen(snap, manifest); // the clean freeze must satisfy its own manifest
    // a modified frozen file must be rejected even though its rel+size collides with the other source
    const collisionPath = join(snap, "codex", "sessions", "shared", "collide.jsonl");
    utimesSync(collisionPath, new Date(Date.now() + 120000), new Date(Date.now() + 120000));
    let modifiedRejected = false;
    try {
      validateFrozen(snap, manifest);
    } catch {
      modifiedRejected = true;
    }
    utimesSync(collisionPath, statSync(join(codexSessions, "shared", "collide.jsonl")).mtime, statSync(join(codexSessions, "shared", "collide.jsonl")).mtime);

    // gate logic, synthetic only: no CLI launch and no transcript bytes
    const run = (over) => ({ exit: "0", timedOut: false, parsedOk: true, seconds: 1, oracle: { state: "match" }, ...over });
    const failureOk =
      failures([]).length === 0 &&
      failures([run({})]).length === 0 &&
      failures([run({ timedOut: true })]).length === 1 &&
      failures([run({ exit: "1" })]).length === 1 &&
      failures([run({ oracle: { state: "absent" } })], { speed: true }).length === 1 &&
      failures([run({ parsedOk: false })]).length === 1 &&
      failures([run({ oracle: { state: "mismatch", at: 3 } })]).length === 1 &&
      failures([run({ seconds: 12 })]).length === 0 &&
      failures([run({ seconds: 12 })], { speed: true }).length === 1 &&
      failures([run({ seconds: 9.5 })], { speed: true }).length === 0;
    const parityOk =
      compareBytes(Buffer.from("abc"), Buffer.from("abc")).state === "match" &&
      compareBytes(Buffer.from("abc"), Buffer.from("abd")).state === "mismatch" &&
      compareBytes(Buffer.from("abc"), Buffer.from("abd")).at === 2;
    const shapeGateOk =
      shapeOk({ generated: "x", sessions: 2, turns: 3, total: 5, issues: [] }) &&
      !shapeOk({ generated: "x", sessions: 0, turns: 3, total: 5, issues: [] }) &&
      !shapeOk({ generated: "x", sessions: 2, turns: 0, total: 5, issues: [] }) &&
      !shapeOk({ generated: "x", sessions: 2, turns: 3, total: 0, issues: [] });

    const ok = freezeOk && modifiedRejected && failureOk && parityOk && shapeGateOk;
    process.stdout.write(
      `${ok ? "self-test ok" : "self-test FAIL"} freeze=${freezeOk} reject=${modifiedRejected} failure=${failureOk} parity=${parityOk} shape=${shapeGateOk} files=${manifest.filesTotal} clock=${manifest.clock}\n`,
    );
    return ok ? 0 : 1;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const parsed = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    snapshot: { type: "string" },
    cli: { type: "string" },
    node: { type: "string" },
    base: { type: "string" },
    mode: { type: "string" },
    runs: { type: "string" },
    timeout: { type: "string" },
    "record-oracle": { type: "boolean" },
    force: { type: "boolean" },
    nocache: { type: "boolean" },
  },
});

const options = {
  ...parsed.values,
  base: parsed.values.base ? resolve(parsed.values.base) : DEFAULT_BASE,
  recordOracle: parsed.values["record-oracle"],
};
const command = parsed.positionals[0] || "status";

if (command === "snapshot") {
  if (resolveSnapshot(options) && !options.force) fail("a snapshot pointer already exists; pass --force to freeze a new one");
  snapshot(options);
} else if (command === "reindex") {
  reindex(options);
} else if (command === "run") {
  const results = runRuns(options);
  const valid = results.filter((r) => r.parsedOk).map((r) => r.seconds);
  if (valid.length) {
    const sorted = [...valid].sort((a, b) => a - b);
    process.stdout.write(`summary valid=${valid.length}/${results.length} min=${sorted[0].toFixed(3)} median=${sorted[sorted.length >> 1].toFixed(3)}\n`);
  }
  const bad = failures(results);
  if (bad.length) {
    process.stdout.write(`run FAIL ${bad.length}/${results.length}\n`);
    process.exitCode = 1;
  }
} else if (command === "verify") {
  const snap = resolveSnapshot(options);
  if (snap && !existsSync(join(snap, "oracle", "report.json"))) fail("verify needs a recorded oracle; run `run --record-oracle` first");
  const results = runRuns({ ...options, mode: "cold", recordOracle: false });
  const bad = failures(results, { speed: true });
  process.stdout.write(`verify ${bad.length === 0 ? "parity+speed ok" : `FAIL ${bad.length}`}\n`);
  if (bad.length) process.exitCode = 1;
} else if (command === "status") {
  status(options);
} else if (command === "self-test") {
  process.exitCode = selfTest();
} else {
  fail(`unknown command "${command}"`);
}
