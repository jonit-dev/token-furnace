#!/usr/bin/env node
/**
 * PRD-007 package smoke test.
 *
 * Packs the built package, checks the tarball manifest, installs the tarball into a temp project,
 * runs the installed CLI over a synthetic transcript under an isolated HOME and a frozen clock,
 * exercises --html, then starts the installed server and fetches its routes. Every child runs on
 * process.execPath, so the same Node runs on 22.13 and 24. No Python, jq or shell tools.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAYS = 7;
const TURNS = 40;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Env the harness clears, so a developer's own settings cannot leak into the run. */
const CLEARED = [
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
  "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY",
  "TOKEN_FURNACE_WEEKLY_BUDGET",
];

const failures = [];
const detailOf = (error) => String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);

function check(ok, label, detail) {
  if (ok) console.log(`ok   ${label}`);
  else {
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
    failures.push(label);
  }
}

/** npm and npx from the same install and the same Node that started this script. */
function npmCmd(name) {
  const exec = process.env.npm_execpath; // set when launched by `npm run`
  if (exec) {
    const cli = join(dirname(exec), name === "npm" ? "npm-cli.js" : "npx-cli.js");
    if (existsSync(cli)) return { cmd: process.execPath, args: [cli] };
  }
  return { cmd: name, args: [] };
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    killSignal: "SIGKILL",
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.signal) throw new Error(`\`${cmd} ${args.join(" ")}\` killed by ${res.signal}`);
  if (res.status !== 0) {
    const tail = `${res.stdout || ""}\n${res.stderr || ""}`.trim().split("\n").slice(-6).join("\n");
    throw new Error(`\`${cmd} ${args.join(" ")}\` exited ${res.status}\n${tail}`);
  }
  return res.stdout;
}

function isolatedEnv(root) {
  const env = { ...process.env };
  for (const key of CLEARED) delete env[key];
  env.HOME = join(root, "home");
  env.CLAUDE_CONFIG_DIR = join(root, "claude");
  env.CODEX_HOME = join(root, "codex");
  env.XDG_CACHE_HOME = join(root, "cache");
  env.npm_config_cache = join(root, "npm-cache");
  env.TOKEN_FURNACE_NOW = NOW.toISOString();
  return env;
}

/** One Claude session with usage on every turn, so the report totals are non-trivial. */
function transcript() {
  const lines = [
    JSON.stringify({ type: "summary", summary: "smoke", aiTitle: "Smoke leak hunt" }),
    JSON.stringify({ type: "user", timestamp: new Date(NOW.getTime() - 7 * HOUR).toISOString(), message: { content: "fix the token leak" } }),
  ];
  for (let i = 0; i < TURNS; i++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(NOW.getTime() - 6 * HOUR + i * 5 * MINUTE).toISOString(),
        cwd: "/home/dev/work/demo",
        message: {
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 200_000 + i * 5_000,
            cache_creation_input_tokens: 20_000,
            output_tokens: 80,
          },
          content: [
            { type: "text", text: "working" },
            { type: "tool_use", name: "Bash", input: { command: "cd /x && sed -n 1,200p big.log" } },
            { type: "tool_use", name: "Edit", input: { file_path: "/x/y.ts", old_string: "a", new_string: "b" } },
          ],
        },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const get = (url) => fetch(url, { signal: AbortSignal.timeout(10_000) });

/** Resolve once the server prints its URL. Rejects on timeout, early exit, or spawn failure. */
function waitForUrl(child, timeoutMs = 30_000) {
  return new Promise((ready, fail) => {
    let out = "";
    let err = "";
    let settled = false;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      stopListening();
      finish(value);
    };
    const timer = setTimeout(
      () => settle(fail, new Error(`serve printed no URL in ${timeoutMs} ms\n${err || out}`)),
      timeoutMs,
    );
    timer.unref?.();
    const onOut = (chunk) => {
      out += chunk.toString();
      const found = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (found) settle(ready, found[0]);
    };
    const onErr = (chunk) => {
      err += chunk.toString();
    };
    const onExit = (code, signal) => {
      settle(fail, new Error(`serve exited before printing its URL (${code ?? signal})\n${err || out}`));
    };
    const onError = (error) => {
      settle(fail, new Error(`serve failed to spawn: ${error.message}`));
    };
    function stopListening() {
      clearTimeout(timer);
      child.stdout.off("data", onOut);
      child.stderr.off("data", onErr);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    child.stdout.on("data", onOut);
    child.stderr.on("data", onErr);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

async function waitReport(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get(`${base}/api/report`);
    if (res.status === 200) return res.json();
    if (res.status !== 202) throw new Error(`/api/report answered ${res.status}`);
    await sleep(500);
  }
  throw new Error(`/api/report did not become ready in ${timeoutMs} ms`);
}

/** Kill the exact child with SIGTERM then bounded SIGKILL and wait for the real exit. */
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (await killAndWait(child, "SIGTERM", 3_000)) return;
  if (!await killAndWait(child, "SIGKILL", 2_000)) throw new Error(`server ${child.pid} did not exit`);
}

/** Send a signal and resolve true on exit, false on timeout. The timer never outlives an exit. */
function killAndWait(child, signal, timeoutMs) {
  return new Promise((done) => {
    let settled = false;
    const onExit = () => finish(true);
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      done(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.kill(signal);
  });
}

const root = mkdtempSync(join(tmpdir(), "token-furnace-smoke-"));
let server;
const cleanup = (signal) => {
  stop(server).finally(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A temp dir we cannot remove is not a smoke failure.
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => cleanup(signal));
try {
  const claude = join(root, "claude");
  const project = join(root, "project");
  const packDir = join(root, "pack");
  const npmCache = join(root, "npm-cache");
  for (const dir of [join(root, "home"), claude, join(root, "codex"), join(root, "cache"), npmCache, project, packDir]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(join(claude, "projects", "demo"), { recursive: true });
  writeFileSync(join(claude, "projects", "demo", "smoke-session.jsonl"), transcript());

  /** npm run from a temp HOME and cache, so the install writes nothing outside the temp root. */
  const npmEnv = { ...process.env, HOME: join(root, "home"), XDG_CACHE_HOME: join(root, "cache"), npm_config_cache: npmCache, npm_config_update_notifier: "false" };

  const inherited = process.env.npm_node_execpath;
  if (inherited && resolve(inherited) !== resolve(process.execPath)) {
    check(false, "npm and npx run on this Node runtime", `npm_node_execpath=${inherited} execPath=${process.execPath}`);
  } else {
    console.log(`ok   npm and npx run on this Node runtime (${process.version})`);
  }

  const npm = npmCmd("npm");
  const npx = npmCmd("npx");

  const packed = run(npm.cmd, [...npm.args, "pack", "--json", "--pack-destination", packDir], { cwd: REPO, env: npmEnv });
  const info = JSON.parse(packed.slice(packed.indexOf("[")))[0];
  const manifest = info.files.map((entry) => entry.path);
  const tarball = join(packDir, info.filename);
  if (!existsSync(tarball)) throw new Error(`npm pack produced no tarball for ${info.filename}`);
  console.log(`ok   npm pack produced a tarball (${info.filename})`);

  const required = ["dist/cli.js", "dist/scan-worker.js", "dist/dashboard.html", "README.md", "SKILL.md"];
  const missing = required.filter((path) => !manifest.includes(path));
  check(missing.length === 0, "tarball includes dist entrypoints, README and SKILL", missing.join(", "));
  if (missing.length) throw new Error(`tarball is missing packaged assets: ${missing.join(", ")}`);

  const forbidden = manifest.filter(
    (path) => path.endsWith(".py") || path.endsWith(".sh") || path.split("/").some((seg) => seg === "test" || seg === "tests" || seg === "fixtures") || /fixture/i.test(path),
  );
  check(forbidden.length === 0, "tarball has no .py, .sh, test or fixture files", forbidden.join(", "));
  if (forbidden.length) throw new Error(`tarball contains forbidden files: ${forbidden.join(", ")}`);

  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "token-furnace-smoke", private: true, version: "0.0.0" }, null, 2));
  run(npm.cmd, [...npm.args, "install", tarball, "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: project, env: npmEnv });
  const cliJs = join(project, "node_modules", "token-furnace", "dist", "cli.js");
  check(existsSync(cliJs), "tarball installs dist/cli.js into a temp project");
  if (!existsSync(cliJs)) throw new Error("the installed package has no dist/cli.js");

  const env = isolatedEnv(root);
  const htmlPath = join(root, "out", "report.html");
  const args = ["--json", "--no-plan-usage", "--html", htmlPath];
  let report;
  try {
    report = JSON.parse(run(npx.cmd, [...npx.args, "--no-install", "token-furnace", ...args], { cwd: project, env }).trim());
    check(true, "npx --no-install token-furnace runs");
  } catch (error) {
    check(false, "npx --no-install token-furnace runs", detailOf(error));
    throw new Error(`the required npx path failed: ${detailOf(error)}`);
  }

  const totalsOk =
    report.days === DAYS &&
    report.sessions >= 1 &&
    report.turns >= TURNS &&
    report.total > 1_000_000 &&
    Array.isArray(report.issues);
  check(totalsOk, "report totals are meaningful for the installed CLI", `days=${report.days} sessions=${report.sessions} turns=${report.turns} total=${report.total}`);

  const html = readFileSync(htmlPath, "utf8");
  check(html.includes('"generated":') && !html.includes("/*REPORT*/null"), "html embeds the report data");
  const external = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi),
  ]
    .map((match) => match[1])
    .filter((url) => /^(?:https?:)?\/\//i.test(url));
  check(external.length === 0, "html has no external script/link assets (PRD-005 React bundle pending)", external.join(", "));

  server = spawn(process.execPath, [cliJs, "serve", "--port", "0", "--no-plan-usage"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  const base = await waitForUrl(server);

  const status = await get(`${base}/api/status`);
  check(status.status === 200, "serve /api/status answers 200", String(status.status));

  const dashboard = await get(`${base}/dashboard.html`);
  const dashboardBody = await dashboard.text();
  check(
    dashboard.status === 200 && /text\/html/.test(dashboard.headers.get("content-type") ?? "") && dashboardBody.length > 500,
    "serve serves dashboard.html",
  );

  const served = await waitReport(base);
  check(served.turns >= TURNS && served.total > 1_000_000, "serve /api/report returns a meaningful report", `turns=${served.turns} total=${served.total}`);
  check(
    served.days === report.days && served.sessions === report.sessions && served.turns === report.turns && served.total === report.total,
    "installed CLI and serve report the same totals",
    `cli=${report.sessions}/${report.turns}/${report.total} serve=${served.sessions}/${served.turns}/${served.total}`,
  );

  const index = await get(`${base}/`);
  const indexBody = await index.text();
  check(index.status === 200 && indexBody.includes('"generated":'), "serve index embeds the report");
} catch (error) {
  check(false, "smoke run", detailOf(error));
} finally {
  await stop(server);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A temp dir we cannot remove is not a smoke failure.
  }
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("\nall checks passed");
}
