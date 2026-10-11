#!/usr/bin/env node
/**
 * Native qualification. Every side effect is confined to explicitly dedicated homes and a
 * temporary workspace. A missing native capability is BLOCKED; a command that ran and failed is
 * FAIL. Only exercised, observed scenarios can be PASS.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const supported = ["claude", "codex", "opencode"];
const requested = parseSources(process.argv.slice(2));
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
let packageBin = process.env.TOKEN_FURNACE_QUALIFY_BIN || join(root, "dist", "cli.js");
const packageVersion = readPackageVersion(root);
const homes = {
  claude: process.env.TOKEN_FURNACE_QUALIFY_CLAUDE_HOME,
  codex: process.env.TOKEN_FURNACE_QUALIFY_CODEX_HOME,
  opencode: process.env.TOKEN_FURNACE_QUALIFY_OPENCODE_DATA_DIR,
};
const blocked = [];
const targets = new Map();
const temporary = [];
const servers = [];
const nativeWorkers = [];
let runtimeBinDir;
let sharedConfigHome;
let sharedStateHome;
let sharedCacheHome;
let activeServerEnv;

if (process.argv.includes("--self-test")) {
  const timedOut = finishNativeResult({ status: 1, signal: "SIGTERM" }, true, "", "contract", 0);
  const claudeArgs = nativeArgs({ source: "claude" }, "/tmp", "prompt", {});
  const resumeArgs = nativeArgs({ source: "claude" }, "/tmp", "prompt", { resumeSessionId: "native-session" });
  const codexArgs = nativeArgs({ source: "codex" }, "/tmp", "prompt", { resumeSessionId: "thread" });
  const codexFreshArgs = nativeArgs({ source: "codex" }, "/tmp", "prompt", {});
  const openCodeArgs = nativeArgs({ source: "opencode" }, "/tmp", "prompt", { resumeSessionId: "session" });
  const ids = extractNativeSessionIds('{"type":"system","session_id":"native-session"}', "claude");
  const codexIds = extractNativeSessionIds('{"type":"thread.started","thread_id":"thread"}', "codex");
  const openCodeIds = extractNativeSessionIds('{"sessionID":"session"}', "opencode");
  const first = scenarioArtifacts("/tmp", "claude", "provider-stop", ["matching"]);
  const second = scenarioArtifacts("/tmp", "claude", "provider-stop", ["matching"]);
  const gated = delayedPrompt(first.matching, "MATCHING", first.barrier);
  if (!timedOut.timedOut || !taskUnavailable(timedOut) || nativeAttemptPasses(timedOut) || claudeArgs.includes("--no-session-persistence") || !claudeArgs.includes("--output-format") || !resumeArgs.includes("--resume") || !codexArgs.includes("resume") || codexArgs.includes("-C") || !codexFreshArgs.includes("-C") || !codexArgs.includes("--json") || !openCodeArgs.includes("--session") || !openCodeArgs.includes("--format") || !ids.includes("native-session") || !codexIds.includes("thread") || !openCodeIds.includes("session") || first.matching === second.matching || !gated.includes(first.barrier) || !gated.toLowerCase().includes("only after")) {
    console.error("qualification contract failed: native timeout, persistence, resume, identity, or barrier contract regressed");
    process.exitCode = 1;
  } else {
    console.log("qualification contract ok");
  }
} else {
try {
  await discoverPackage();
  for (const source of requested) {
    const target = discoverTarget(source);
    if (target.blocked) blocked.push(target.blocked);
    else targets.set(source, target);
  }

  if (blocked.length) {
    printBlocked(blocked);
    process.exitCode = 75;
  } else {
    const results = await qualify();
    const failed = results.filter((result) => result.status === "FAIL");
    const pending = results.filter((result) => result.status === "BLOCKED");
    for (const result of results) console.log(`${result.status} ${result.scenario}: ${result.detail}`);
    if (failed.length) process.exitCode = 1;
    else if (pending.length) process.exitCode = 75;
    else process.exitCode = 0;
  }
} finally {
  for (const worker of nativeWorkers.splice(0)) await stopChild(worker);
  for (const server of servers) await stopChild(server);
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
}
}

async function discoverPackage() {
  if (!existsSync(packageBin)) throw new Error(`Built package entrypoint is missing: ${packageBin}`);
  if (!existsSync(join(root, "dist", "dashboard.html"))) throw new Error("Built dashboard asset is missing; run npm run build first.");
  if (!packageVersion) throw new Error("Package identity could not be read.");
  if (!process.env.TOKEN_FURNACE_QUALIFY_BIN) {
    const packageRoot = mkdtempSync(join(tmpdir(), "token-furnace-package-"));
    const installRoot = mkdtempSync(join(tmpdir(), "token-furnace-install-"));
    temporary.push(packageRoot, installRoot);
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = spawnSync(npm, ["pack", "--pack-destination", packageRoot], { cwd: root, encoding: "utf8", env: process.env, timeout: 120_000 });
    if (packed.error || packed.status !== 0) throw new Error(`npm pack failed: ${safeTail(packed.stderr || packed.stdout)}`);
    const tarball = readdirSync(packageRoot).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack did not produce an installable tarball.");
    const installed = spawnSync(npm, ["install", "--ignore-scripts", "--no-package-lock", "--no-save", "--prefix", installRoot, join(packageRoot, tarball)], { cwd: root, encoding: "utf8", env: process.env, timeout: 180_000 });
    if (installed.error || installed.status !== 0) throw new Error(`Installed package setup failed: ${safeTail(installed.stderr || installed.stdout)}`);
    packageBin = join(installRoot, "node_modules", "token-furnace", "dist", "cli.js");
    if (!existsSync(packageBin)) throw new Error(`Installed package entrypoint is missing: ${packageBin}`);
    runtimeBinDir = join(installRoot, "node_modules", ".bin");
  }
  if (!runtimeBinDir) {
    runtimeBinDir = mkdtempSync(join(tmpdir(), "token-furnace-bin-"));
    temporary.push(runtimeBinDir);
    try {
      symlinkSync(resolve(packageBin), join(runtimeBinDir, "token-furnace"));
    } catch {
      writeFileSync(join(runtimeBinDir, "token-furnace"), `#!/usr/bin/env node\nconst mod = await import(${JSON.stringify(pathToFileUrl(resolve(packageBin)))});\nprocess.exitCode = await mod.main();\n`);
      chmodSync(join(runtimeBinDir, "token-furnace"), 0o700);
    }
  }
  console.log(`PACKAGE token-furnace@${packageVersion} ${packageBin}`);
}

function discoverTarget(source) {
  const home = homes[source];
  const label = source === "opencode" ? "OPENCODE_DATA_DIR" : `${source.toUpperCase()}_HOME`;
  if (!home) return { blocked: `${source}: set TOKEN_FURNACE_QUALIFY_${label} to a disposable authenticated home` };
  if (!isAbsolute(home) || !existsSync(home)) return { blocked: `${source}: qualification target is missing or not absolute` };
  const resolved = realpathOr(home);
  if (isPersonalTarget(resolved)) return { blocked: `${source}: qualification target resolves to a personal home` };
  const credential = join(home, source === "claude" ? ".credentials.json" : "auth.json");
  if (!existsSync(credential)) return { blocked: `${source}: dedicated credential file is missing` };
  const command = source === "opencode" ? "opencode" : source;
  const version = spawnSync(command, ["--version"], { encoding: "utf8", env: isolatedEnv(source, home), timeout: 10_000 });
  if (version.error || version.status !== 0) return { blocked: `${source}: native executable could not be discovered` };
  const firstLine = String(version.stdout || version.stderr).trim().split("\n")[0] || "version unavailable";
  const helpArgs = source === "codex" ? ["exec", "--help"] : source === "opencode" ? ["run", "--help"] : ["--help"];
  const help = spawnSync(command, helpArgs, { encoding: "utf8", env: isolatedEnv(source, home), timeout: 10_000 });
  const capabilities = nativeCapabilities(source, `${help.stdout || ""}\n${help.stderr || ""}`);
  console.log(`DISCOVERED ${source}: ${firstLine}`);
  return { source, home, command, capabilities };
}

async function qualify() {
  const results = [];
  const browser = findBrowser();
  const workspace = mkdtempSync(join(tmpdir(), "token-furnace-budget-qualify-"));
  const shared = mkdtempSync(join(tmpdir(), "token-furnace-budget-state-"));
  temporary.push(workspace, shared);
  sharedConfigHome = join(shared, "config");
  sharedStateHome = join(shared, "state");
  sharedCacheHome = join(shared, "cache");
  activeServerEnv = {
    ...isolatedEnv(requested[0], targets.get(requested[0]).home, workspace),
    CLAUDE_CONFIG_DIR: targets.get("claude")?.home,
    CODEX_HOME: targets.get("codex")?.home,
    OPENCODE_DATA_DIR: targets.get("opencode")?.home,
  };
  for (const path of [sharedConfigHome, sharedStateHome, sharedCacheHome]) mkdirSync(path, { recursive: true });
  const warmups = new Map();
  for (const source of requested) {
    const target = targets.get(source);
    const install = await run(packageBin, ["budgets", "enable", "--confirm"], { cwd: workspace, env: isolatedEnv(source, target.home, workspace), timeout: 20_000 });
    if (install.status !== 0) {
      warmups.set(source, { ok: false, detail: `adapter installation failed: ${safeTail(install.output)}` });
      continue;
    }
    const sentinel = join(workspace, `${source}-warmup.sentinel`);
    const warmup = await runNative(target, workspace, `Create the file ${sentinel} containing exactly BUDGET_WARMUP and then stop.`, 120_000);
    warmups.set(source, { ok: nativeAttemptPasses(warmup) && existsSync(sentinel) && nativeSessionEvidence(source, warmup), detail: safeTail(warmup.output) });
  }
  let server = await startServer(activeServerEnv);
  servers.push(server);

  const modeResult = await scenarioModePolicy(server.url, browser, workspace);
  const oldServer = server;
  await stopChild(oldServer.child);
  servers.splice(servers.indexOf(oldServer), 1);
  server = await startServer(activeServerEnv, true);
  servers.push(server);
  const persisted = await scenarioState(server.url);
  if (modeResult.status === "PASS" && requested.some((source) => !persisted?.policies?.some((policy) => policy.scope?.kind === "source" && policy.scope.source === source && policy.mode === "manual" && policy.limit === 1000))) {
    modeResult.status = "FAIL";
    modeResult.detail = "Manual browser policy did not survive the Token Furnace restart.";
  }
  if (modeResult.status === "PASS" && requested.some((source) => {
    const before = modeResult.autoReadings?.find((reading) => reading.source === source)?.meter;
    const after = persisted?.sources?.find((reading) => reading.source === source)?.meter;
    return before && (!after || after.account !== before.account || after.window !== before.window || !Number.isFinite(Date.parse(after.observedAt ?? "")));
  })) {
    modeResult.status = "FAIL";
    modeResult.detail = "The no-plan-usage restart did not preserve the authoritative quota snapshot identity and observation time.";
  }
  results.push(modeResult);
  for (const source of requested) {
    results.push(await scenarioAdmission(source, workspace, server.url, warmups.get(source)));
  }
  for (const source of requested) {
    results.push(await scenarioProviderStop(source, server.url, workspace, browser));
    results.push(await scenarioModelStop(source, server.url, workspace, browser));
    results.push(await scenarioForceRecovery(source, server.url, workspace));
  }
  if (requested.length >= 2) results.push(await scenarioCrossHarness(workspace, browser));
  else results.push({ status: "BLOCKED", scenario: "cross-harness-provider-model", detail: "At least two requested native harnesses are required." });
  return results;
}

async function scenarioModePolicy(url, browser, workspace) {
  if (!browser) return { status: "BLOCKED", scenario: "mode-and-policy-wiring", detail: "No supported Chromium browser was discovered." };
  const offSource = requested[0];
  const offSentinel = join(workspace, "mode-off-minimal.sentinel");
  const offTask = await runNative(targets.get(offSource), workspace, `Create ${offSentinel} containing exactly MODE_OFF and then stop.`, 120_000, null);
  if (taskUnavailable(offTask)) return { status: "BLOCKED", scenario: "mode-and-policy-wiring", detail: `Default Off minimal task was unavailable: ${safeTail(offTask.output)}` };
  if (!nativeSessionEvidence(offSource, offTask) || offTask.status !== 0 || offTask.timedOut || offTask.signal || !existsSync(offSentinel) || !decisionEvidence(offSource, offTask.requestId, offTask.startedAt, true)) {
    return { status: "FAIL", scenario: "mode-and-policy-wiring", detail: "The real default-Off task did not create its sentinel with a correlated allow decision." };
  }
  const result = await driveBudgetsBrowser(browser, `${url}/#budgets`);
  if (!result.ok) return { status: result.ran ? "FAIL" : "BLOCKED", scenario: "mode-and-policy-wiring", detail: result.detail };
  const state = await getJson(`${url}/api/budgets`);
  if (!state.ok || !Array.isArray(state.value?.policies) || state.value.policies.length < requested.length) {
    return { status: "FAIL", scenario: "mode-and-policy-wiring", detail: "Browser forms did not persist all requested policies." };
  }
  if (requested.some((source) => !state.value.policies.some((policy) => policy.scope?.kind === "source" && policy.scope.source === source && policy.mode === "manual" && policy.limit === 1000))) {
    return { status: "FAIL", scenario: "mode-and-policy-wiring", detail: "Browser Manual policies were not all persisted with the selected limit." };
  }
  const autoReadings = result.autoReadings ?? [];
  const freshAuto = requested.every((source) => {
    const reading = autoReadings.find((candidate) => candidate.source === source);
    const observed = Date.parse(reading?.meter?.observedAt ?? "");
    return reading?.policy?.mode === "auto" && Number.isFinite(reading.allowance) && reading.meter?.authoritative === true && Boolean(reading.meter.account) && Boolean(reading.meter.window) && Number.isFinite(observed) && observed <= Date.now() && Date.now() - observed <= 5 * 60_000;
  });
  const autoMath = requested.every((source) => {
    const reading = autoReadings.find((candidate) => candidate.source === source);
    const meter = reading?.meter;
    const observed = Date.parse(meter?.observedAt ?? "");
    const reset = Date.parse(meter?.resetAt ?? "");
    const used = Number(meter?.usedPercentagePoints);
    const expected = Number.isFinite(observed) && Number.isFinite(reset) && reset > Date.now() && Number.isFinite(used)
      ? Math.max(0, 100 - used) / ((reset - Date.now()) / 3_600_000)
      : NaN;
    return Number.isFinite(expected) && Math.abs(Number(reading?.allowance) - expected) < 0.01;
  });
  if (!freshAuto || !autoMath) {
    return { status: "BLOCKED", scenario: "mode-and-policy-wiring", detail: "Auto policy lacks a fresh authoritative quota/account/window reading or matching reset-derived pace for every requested source; no PASS was substituted." };
  }
  return { status: "PASS", scenario: "mode-and-policy-wiring", autoReadings, detail: "Real browser rendered #budgets, saved Off/Auto/Manual, proved reset-derived Auto pacing, preserved Manual and quota snapshot state across a no-plan-usage restart, and proved an Off native task." };
}

async function scenarioState(url) {
  const state = await getJson(`${url}/api/budgets`);
  return state.ok && state.value?.mutationToken ? state.value : null;
}

async function resetPolicies(url) {
  const state = await scenarioState(url);
  if (!state) return { ok: false, value: null };
  return postJson(`${url}/api/budgets`, state.mutationToken, {
    expectedRevision: state.revision,
    policies: [],
  });
}

function identityCandidates(state) {
  const candidates = [];
  for (const source of state?.sources ?? []) {
    for (const provider of source.providers ?? []) {
      const model = (source.models ?? []).find((value) => value.startsWith(`${provider}/`)) ?? null;
      candidates.push({
        source: source.source,
        provider,
        model: model ? model.slice(provider.length + 1) : null,
        displayModel: model,
      });
    }
  }
  return candidates;
}

function modelCandidates(state) {
  const candidates = [];
  for (const source of state?.sources ?? []) {
    for (const value of source.models ?? []) {
      const slash = value.indexOf("/");
      if (slash <= 0 || slash === value.length - 1) continue;
      candidates.push({ source: source.source, provider: value.slice(0, slash), model: value.slice(slash + 1), displayModel: value });
    }
  }
  return candidates;
}

function mergeModelCandidates(existing, discovered) {
  const result = [...existing];
  const seen = new Set(result.map((candidate) => `${candidate.provider}/${candidate.model}`));
  for (const candidate of discovered) {
    const key = `${candidate.provider}/${candidate.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

async function discoverNativeModels(target, workspace) {
  if (target.source !== "opencode") return [];
  const result = await run(target.command, ["models"], { cwd: workspace, env: isolatedEnv(target.source, target.home, workspace), timeout: 30_000 });
  if (result.status !== 0 || result.timedOut) return [];
  const models = new Set();
  for (const match of String(result.output || "").matchAll(/\b([A-Za-z0-9._-]+)\/([A-Za-z0-9._:@-]+)\b/g)) models.add(`${match[1]}/${match[2]}`);
  return [...models].map((displayModel) => {
    const slash = displayModel.indexOf("/");
    return { source: target.source, provider: displayModel.slice(0, slash), model: displayModel.slice(slash + 1), displayModel };
  });
}

async function stopPreview(url, token, scope) {
  return postJson(`${url}/api/budgets/stop-preview`, token, { scope });
}

async function unlockScope(url, token, scope) {
  return postJson(`${url}/api/budgets/unlock`, token, { scope });
}

async function scenarioAdmission(source, workspace, url, warmup) {
  if (!warmup?.ok) return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: `Native warmup did not complete; no admission result was fabricated. ${warmup?.detail ?? "adapter setup did not run"}` };
  const target = targets.get(source);
  if (!target?.capabilities?.resume) return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: `${source} did not advertise a supported native resume route; no synthetic resume result was accepted.` };
  const artifacts = scenarioArtifacts(workspace, source, "budget-admission", ["child", "background", "resume", "blocked-child", "blocked-background"]);
  const prompt = delegationPrompt(source, artifacts.child, artifacts.background, artifacts.resume, "BUDGET_ELIGIBLE");
  const task = await runNative(target, workspace, prompt, 120_000, null);
  if (taskUnavailable(task)) return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: `The real ${source} delegation task was unavailable: ${safeTail(task.output)}` };
  if (!nativeAttemptPasses(task)) return { status: "FAIL", scenario: `budget-admission:${source}`, detail: `The real ${source} delegation task ran but did not complete: ${safeTail(task.output)}` };
  const allowed = decisionEvidence(source, task.requestId, task.startedAt, true);
  if (!allowed || !nativeSessionEvidence(source, task) || !nativeChildEvidence(source, task) || !existsSync(artifacts.child) || !existsSync(artifacts.background)) {
    return { status: "FAIL", scenario: `budget-admission:${source}`, detail: "The eligible request lacked correlated native parent/child session evidence, durable allow evidence, or child side effects." };
  }
  const resumed = await resumeNative(target, workspace, task.nativeSessionId, resumePrompt(source, artifacts.resume, "BUDGET_RESUMED"), 120_000, null);
  if (taskUnavailable(resumed)) return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: `The native session could not be resumed: ${safeTail(resumed.output)}` };
  if (!nativeAttemptPasses(resumed) || !resumed.nativeSessionIds.includes(task.nativeSessionId) || !nativeSessionEvidence(source, resumed) || !existsSync(artifacts.resume)) {
    return { status: "FAIL", scenario: `budget-admission:${source}`, detail: "The eligible native session did not resume through the same observed session or create its resume side effect." };
  }
  if (!hasMeasuredUsage(source, task.startedAt)) return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: "The eligible native task did not leave attributable measured usage in the shared budget store." };
  const exhausted = await setSourcePolicy(url, source, 1);
  if (!exhausted.ok) return { status: "FAIL", scenario: `budget-admission:${source}`, detail: "Could not persist the deliberately exhausted Manual policy." };
  const blockedTask = await runNative(target, workspace, delegationPrompt(source, artifacts.blockedChild, artifacts.blockedBackground, artifacts.blockedChild, "BUDGET_BLOCKED"), 60_000, null);
  const denied = decisionEvidence(source, blockedTask.requestId, blockedTask.startedAt, false);
  if (taskUnavailable(blockedTask)) return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: `The exhausted native request was unavailable, not a denial: ${safeTail(blockedTask.output)}` };
  if (!denied || !nativeSessionEvidence(source, blockedTask) || blockedTask.timedOut || blockedTask.signal || existsSync(artifacts.blockedChild) || existsSync(artifacts.blockedBackground)) return { status: "FAIL", scenario: `budget-admission:${source}`, detail: "The exhausted request lacked a correlated native deny decision or created a child side effect." };
  return { status: "PASS", scenario: `budget-admission:${source}`, detail: "Native delegation, nested/background child sessions, same-session resume, measured usage exhaustion, correlated denial, and absent child side effects were observed." };
}

function delegationPrompt(source, childSentinel, backgroundSentinel, resumeSentinel, marker) {
  const route = source === "codex"
    ? "Use the native Codex code-mode or spawn_agent/delegate route, including a namespaced child if the installed client supports it."
    : source === "claude"
      ? "Use the native Claude Agent/Task delegation route, not a direct shell write."
      : "Use the installed OpenCode child/background delegation route; do not write the files directly from the parent.";
  return `${route} Delegate a tiny native child task that writes exactly ${marker} to ${childSentinel}. Start a background or nested native child that writes exactly ${marker}_BACKGROUND to ${backgroundSentinel}, wait for both children, and stop the parent session without writing ${resumeSentinel}; the harness will resume this same native session. A missing native delegation path is an unavailable qualification result, not permission to write these files directly.`;
}

function resumePrompt(source, sentinel, marker) {
  const route = source === "codex" ? "Resume the existing native thread" : source === "claude" ? "Resume the existing Claude session" : "Continue the existing OpenCode session";
  return `${route} identified by the harness. Do not start a new session or use a direct shell write. Create ${sentinel} containing exactly ${marker}, then stop.`;
}

function decisionEvidence(source, requestId, startedAt, allowed) {
  if (!requestId || !sharedStateHome) return null;
  try {
    const db = new DatabaseSync(join(sharedStateHome, "token-furnace", "budgets.sqlite"));
    const rows = db.prepare("SELECT allowed, reason, at FROM admission_decisions WHERE source = ? AND request_id = ? AND at >= ? ORDER BY at DESC").all(source, requestId, Math.max(0, (startedAt ?? 0) - 2_000));
    db.close();
    return rows.find((row) => Boolean(row.allowed) === allowed) ?? null;
  } catch {
    return null;
  }
}

function hasMeasuredUsage(source, startedAt) {
  try {
    const db = new DatabaseSync(join(sharedStateHome, "token-furnace", "budgets.sqlite"));
    const row = db.prepare("SELECT amount FROM usage_events WHERE scope_key = ? AND at >= ? AND amount > 0 ORDER BY at DESC LIMIT 1").get(`source:${source}`, Math.max(0, (startedAt ?? 0) - 2_000));
    db.close();
    return Boolean(row);
  } catch {
    return false;
  }
}

function nativeCapabilities(source, help) {
  const text = String(help || "");
  return {
    resume: source === "claude" ? /--resume\s+<session-id>|--resume\b/.test(text) : source === "codex" ? /\bresume\b/.test(text) : /--session\b/.test(text),
    sharedModelHost: source === "opencode" && /--attach\b/.test(text) && /--session\b/.test(text),
  };
}

function extractNativeSessionIds(output, source) {
  const ids = new Set();
  const wanted = source === "claude"
    ? new Set(["session_id", "sessionId"])
    : source === "codex"
      ? new Set(["thread_id", "threadId", "session_id", "sessionId"])
      : new Set(["sessionID", "sessionId", "session_id"]);
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key) && typeof child === "string" && child.trim()) ids.add(child.trim());
      visit(child, depth + 1);
    }
  };
  for (const line of String(output || "").split(/\r?\n/)) {
    try { visit(JSON.parse(line)); } catch { /* diagnostics may surround JSONL events */ }
  }
  return [...ids];
}

function controlNativeRows(source, sessionIds, startedAt) {
  if (!sharedStateHome || !sessionIds?.length) return [];
  let db;
  try {
    db = new DatabaseSync(join(sharedStateHome, "token-furnace", "control.sqlite"));
    return db.prepare("SELECT id, session_id, pid, process_start_time, updated_at FROM targets WHERE source = ? AND session_id IS NOT NULL AND updated_at >= ? ORDER BY updated_at DESC").all(source, Math.max(0, (startedAt ?? 0) - 5_000)).filter((row) => sessionIds.includes(row.session_id));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function nativeIdentityCandidates() {
  if (!sharedStateHome) return [];
  let db;
  try {
    db = new DatabaseSync(join(sharedStateHome, "token-furnace", "control.sqlite"));
    const rows = db.prepare("SELECT source, provider, account, model, session_id FROM targets WHERE session_id IS NOT NULL AND provider IS NOT NULL AND model IS NOT NULL ORDER BY updated_at DESC").all();
    const seen = new Set();
    return rows.flatMap((row) => {
      const key = `${row.source}:${row.provider}/${row.model}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ source: row.source, provider: row.provider, account: row.account ?? null, model: row.model, displayModel: `${row.provider}/${row.model}` }];
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function nativeSessionEvidence(source, result) {
  const ids = result?.nativeSessionIds?.length ? result.nativeSessionIds : extractNativeSessionIds(result?.output, source);
  return ids.length > 0 && controlNativeRows(source, ids, result?.startedAt).length > 0;
}

function nativeSessionObserved(source, result) {
  const ids = result?.nativeSessionIds?.length ? result.nativeSessionIds : extractNativeSessionIds(result?.output, source);
  return ids.length > 0;
}

function nativeChildEvidence(source, result) {
  const ids = result?.nativeSessionIds?.length ? result.nativeSessionIds : extractNativeSessionIds(result?.output, source);
  const rows = controlNativeRows(source, ids, result?.startedAt);
  return new Set(rows.map((row) => row.session_id)).size >= 2;
}

function scenarioArtifacts(workspace, source, scenario, names) {
  const tag = `${source}-${scenario}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const artifacts = Object.fromEntries(names.map((name) => [name, join(workspace, `${tag}-${name}.sentinel`)]));
  artifacts.barrier = join(workspace, `${tag}-barrier`);
  for (const name of names) artifacts[`${name}Barrier`] = join(workspace, `${tag}-${name}-barrier`);
  return artifacts;
}

function releaseBarrier(path) {
  writeFileSync(path, "RELEASED\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function workerSessionId(worker) {
  return worker?.sessionIds?.()[0] ?? null;
}

function workerNativeEvidence(source, worker) {
  const ids = worker?.sessionIds?.() ?? [];
  return ids.length > 0 && controlNativeRows(source, ids, worker.startedAt).length > 0;
}

function previewHasSafetyArrays(value) {
  return Array.isArray(value?.targets) && Array.isArray(value?.unverified) && Array.isArray(value?.collateral);
}

function previewMatchesWorker(target, candidate, worker, hostPid = null) {
  const sessionIds = worker?.sessionIds?.() ?? [];
  return target.source === candidate.source && target.provider === candidate.provider && (
    sessionIds.includes(target.id) ||
    (candidate.source === "opencode" && hostPid !== null && target.pid === hostPid) ||
    (candidate.source !== "opencode" && target.pid === worker.child.pid)
  );
}

async function restartQualificationServer() {
  if (!activeServerEnv) return null;
  const current = servers.at(-1);
  if (current) {
    await stopChild(current.child);
    servers.pop();
  }
  const next = await startServer(activeServerEnv, true);
  servers.push(next);
  return next;
}

function taskUnavailable(result) {
  return Boolean(result?.timedOut || result?.signal || /(?:login|auth|credential|not found|unknown option|unavailable|timed out)/i.test(result?.output ?? ""));
}

async function scenarioProviderStop(source, url, workspace, browser) {
  const state = await scenarioState(url);
  const scenario = `provider-stop:${source}`;
  if (!state) return { status: "BLOCKED", scenario, detail: "Budget API was unavailable." };
  const reset = await resetPolicies(url);
  if (!reset.ok) return { status: "FAIL", scenario, detail: "Could not clear prior admission policies before the stop scenario." };
  const candidates = nativeIdentityCandidates();
  const matching = candidates.find((candidate) => candidate.source === source);
  const matchingCandidates = matching ? candidates.filter((candidate) => candidate.provider === matching.provider) : [];
  const unrelated = candidates.find((candidate) => candidate.provider !== matching?.provider);
  if (!matching || new Set(matchingCandidates.map((candidate) => candidate.source)).size < 2 || !unrelated) return { status: "BLOCKED", scenario, detail: "Two real harnesses with the same observed upstream provider and an unrelated provider control were not available." };
  const artifacts = scenarioArtifacts(workspace, source, "provider-stop", [...matchingCandidates.map((_, index) => `matching${index}`), "unrelated", "unrelatedPost", "blocked", "recovered"]);
  const matchingWorkers = matchingCandidates.map((candidate, index) => startNative(targets.get(candidate.source), workspace, delayedPrompt(artifacts[`matching${index}`], `PROVIDER_STOP_MATCHING_${index}`, artifacts[`matching${index}Barrier`]), 30_000, candidate));
  const unrelatedWorker = startNative(targets.get(unrelated.source), workspace, delayedPrompt(artifacts.unrelated, "PROVIDER_STOP_UNRELATED", artifacts.unrelatedBarrier), 30_000, unrelated);
  nativeWorkers.push(...matchingWorkers.map((worker) => worker.child), unrelatedWorker.child);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const boundaryWorkers = [...matchingWorkers, unrelatedWorker];
  if (boundaryWorkers.some((worker) => worker.child.exitCode !== null)) {
    const output = boundaryWorkers.map((worker) => worker.output()).join(" ");
    return taskUnavailable({ output }) ? { status: "BLOCKED", scenario, detail: `A provider-stop native route was unavailable: ${safeTail(output)}` } : { status: "FAIL", scenario, detail: "A provider-stop native task completed before the confirmation boundary." };
  }
  if (boundaryWorkers.some((worker, index) => existsSync(index < matchingWorkers.length ? artifacts[`matching${index}`] : artifacts.unrelated))) return { status: "FAIL", scenario, detail: "A stop sentinel existed before confirmation, so the boundary was not attributable." };
  if (boundaryWorkers.some((worker, index) => !workerNativeEvidence(index < matchingCandidates.length ? matchingCandidates[index].source : unrelated.source, worker))) return { status: "FAIL", scenario, detail: "A live provider-stop worker lacked an observed native session/control registration." };
  const unrelatedWasLive = unrelatedWorker.child.exitCode === null;
  const preview = await stopPreview(url, state.mutationToken, { kind: "provider", provider: matching.provider });
  if (!preview.ok) return { status: "FAIL", scenario, detail: `Provider stop preview failed: ${safeTail(preview.value?.error)}` };
  if (!previewHasSafetyArrays(preview.value)) return { status: "FAIL", scenario, detail: "Provider preview omitted affected, unverified, or collateral entries." };
  const selected = matchingCandidates.every((candidate, index) => (preview.value?.targets ?? []).some((target) => previewMatchesWorker(target, candidate, matchingWorkers[index])));
  if (!selected) return { status: "BLOCKED", scenario, detail: "The real matching worker did not appear in the verified provider preview." };
  const browserStop = await driveStopBrowser(browser, url, `button[aria-label="Stop upstream provider ${matching.provider} in all harnesses"]`, matching.provider);
  if (!browserStop.ok) return { status: browserStop.ran ? "FAIL" : "BLOCKED", scenario, detail: browserStop.detail };
  const stopState = await scenarioState(url);
  const operationId = stopState?.stops?.find((stop) => stop.scope?.kind === "provider" && stop.scope.provider === matching.provider)?.operationId;
  const operation = operationId ? await getJson(`${url}/api/budgets/operations/${operationId}`) : { ok: false, value: null };
  if (!operation.ok || operation.value?.status !== "complete") return { status: "FAIL", scenario, detail: "The UI confirmation did not produce a completed provider stop operation." };
  const selectedTargetIds = (preview.value?.targets ?? []).filter((target) => matchingCandidates.some((candidate, index) => previewMatchesWorker(target, candidate, matchingWorkers[index]))).map((target) => target.id);
  if (!selectedTargetIds.length || !selectedTargetIds.every((id) => (operation.value?.outcomes ?? []).some((outcome) => outcome.targetId === id && ["cancelled", "terminated"].includes(outcome.status)))) return { status: "FAIL", scenario, detail: "The provider stop operation lacked correlated cancelled/terminated outcomes for every preview target." };
  releaseBarrier(artifacts.unrelatedBarrier);
  const matchingResults = await Promise.all(matchingWorkers.map((worker) => worker.wait(8_000)));
  const unrelatedOriginal = await unrelatedWorker.wait(30_000);
  if (matchingResults.some((result, index) => result.timedOut || result.signal || matchingWorkers[index].child.exitCode === null) || !unrelatedWasLive || unrelatedOriginal.timedOut || unrelatedOriginal.signal || unrelatedOriginal.status !== 0 || !existsSync(artifacts.unrelated)) {
    return { status: "FAIL", scenario, detail: "The verified matching worker did not exit or the original unrelated provider worker failed to advance after the stop." };
  }
  const unrelatedPost = await runNative(targets.get(unrelated.source), workspace, `Create ${artifacts.unrelatedPost} containing exactly PROVIDER_STOP_UNRELATED_POST and then stop.`, 120_000, unrelated);
  if (taskUnavailable(unrelatedPost)) return { status: "BLOCKED", scenario, detail: `The unrelated provider did not have a usable post-stop control: ${safeTail(unrelatedPost.output)}` };
  if (unrelatedPost.timedOut || unrelatedPost.signal || unrelatedPost.status !== 0 || !existsSync(artifacts.unrelatedPost) || !nativeSessionEvidence(unrelated.source, unrelatedPost)) return { status: "FAIL", scenario, detail: "The original unrelated provider control did not produce a new attributable post-stop sentinel." };
  const restarted = await restartQualificationServer();
  if (!restarted) return { status: "FAIL", scenario, detail: "Token Furnace could not restart before latch persistence verification." };
  url = restarted.url;
  const restartedState = await scenarioState(url);
  if (!restartedState) return { status: "FAIL", scenario, detail: "Budget state was unavailable after the provider-stop restart." };
  const blocked = await runNative(targets.get(matching.source), workspace, `Create ${artifacts.blocked} containing exactly PROVIDER_STOP_BLOCKED.`, 60_000, matching);
  if (taskUnavailable(blocked)) return { status: "BLOCKED", scenario, detail: `The post-stop matching-provider launch was unavailable, not a denial: ${safeTail(blocked.output)}` };
  if (blocked.timedOut || blocked.signal || existsSync(artifacts.blocked) || !nativeSessionEvidence(matching.source, blocked) || !decisionEvidence(matching.source, blocked.requestId, blocked.startedAt, false)) return { status: "FAIL", scenario, detail: "A fresh matching-provider launch lacked a correlated native denial or created a child side effect after restart." };
  const unlocked = await unlockScope(url, restartedState.mutationToken, { kind: "provider", provider: matching.provider });
  if (!unlocked.ok) return { status: "FAIL", scenario, detail: "Provider unlock failed after the verified stop." };
  const recovered = await runNative(targets.get(matching.source), workspace, `Create ${artifacts.recovered} containing exactly PROVIDER_STOP_RECOVERED and then stop.`, 120_000, matching);
  return !recovered.timedOut && !recovered.signal && recovered.status === 0 && existsSync(artifacts.recovered) && nativeSessionEvidence(matching.source, recovered) && Boolean(decisionEvidence(matching.source, recovered.requestId, recovered.startedAt, true))
    ? { status: "PASS", scenario, detail: "Real matching provider workers exited, the original unrelated control advanced after a released post-confirmation barrier, the latch survived restart, and explicit unlock recovered a fresh native task." }
    : { status: "FAIL", scenario, detail: "Explicit provider unlock did not permit a fresh native task." };
}

async function scenarioModelStop(source, url, workspace, browser) {
  const state = await scenarioState(url);
  const scenario = `model-stop:${source}`;
  if (!state) return { status: "BLOCKED", scenario, detail: "Budget API was unavailable." };
  const reset = await resetPolicies(url);
  if (!reset.ok) return { status: "FAIL", scenario, detail: "Could not clear prior admission policies before the model scenario." };
  const target = targets.get(source);
  if (!target?.capabilities?.sharedModelHost) return { status: "BLOCKED", scenario, detail: `${source} did not advertise an installed shared-host model route; separate processes are not accepted as model-stop evidence.` };
  let candidates = mergeModelCandidates([], modelCandidates(state).filter((candidate) => candidate.source === source));
  if (candidates.length < 2) candidates = mergeModelCandidates(candidates, await discoverNativeModels(target, workspace));
  const matching = candidates[0];
  const unrelated = candidates.find((candidate) => candidate.model !== matching?.model && candidate.provider === matching?.provider) ?? candidates.find((candidate) => candidate.model !== matching?.model);
  if (!matching || !unrelated) return { status: "BLOCKED", scenario, detail: "Two canonical models from the same actual native host were not discoverable; no second historical model was required when the native client exposed a model catalog." };
  const host = await startOpenCodeHost(target, workspace);
  if (!host) return { status: "BLOCKED", scenario, detail: "OpenCode did not expose a real shared native server for mixed-model work." };
  nativeWorkers.push(host.child);
  const artifacts = scenarioArtifacts(workspace, source, "model-stop", ["matching", "unrelated", "unrelatedPost", "resumeBypass", "switchBypass", "bypass", "other", "recovered"]);
  const matchingWorker = startNative(target, workspace, delayedPrompt(artifacts.matching, "MODEL_STOP_MATCHING", artifacts.matchingBarrier), 30_000, { ...matching, hostEndpoint: host.url });
  const unrelatedWorker = startNative(target, workspace, delayedPrompt(artifacts.unrelated, "MODEL_STOP_UNRELATED", artifacts.unrelatedBarrier), 30_000, { ...unrelated, hostEndpoint: host.url });
  nativeWorkers.push(matchingWorker.child, unrelatedWorker.child);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  if (matchingWorker.child.exitCode !== null || unrelatedWorker.child.exitCode !== null) {
    const output = `${matchingWorker.output()} ${unrelatedWorker.output()}`;
    return taskUnavailable({ output }) ? { status: "BLOCKED", scenario, detail: `Mixed-model native work was unavailable: ${safeTail(output)}` } : { status: "FAIL", scenario, detail: "A mixed-model native task completed before the confirmation boundary." };
  }
  if (existsSync(artifacts.matching) || existsSync(artifacts.unrelated) || !workerNativeEvidence(source, matchingWorker) || !workerNativeEvidence(source, unrelatedWorker)) return { status: "FAIL", scenario, detail: "The mixed-model boundary lacked unique pre-confirmation or native session evidence." };
  const unrelatedWasLive = unrelatedWorker.child.exitCode === null;
  const preview = await stopPreview(url, state.mutationToken, { kind: "model", provider: matching.provider, model: matching.model });
  if (!preview.ok) return { status: "FAIL", scenario, detail: `Model stop preview failed: ${safeTail(preview.value?.error)}` };
  if (!previewHasSafetyArrays(preview.value)) return { status: "FAIL", scenario, detail: "Model preview omitted affected, unverified, or collateral entries." };
  const selected = (preview.value?.targets ?? []).some((item) => item.model === matching.model && item.source === source && item.pid === host.child.pid && previewMatchesWorker(item, matching, matchingWorker, host.child.pid));
  if (!selected) return { status: "BLOCKED", scenario, detail: "The real matching model worker did not appear in the verified preview." };
  const browserStop = await driveStopBrowser(browser, url, `button[aria-label="Stop model ${matching.provider}/${matching.model}"]`, matching.model);
  if (!browserStop.ok) return { status: browserStop.ran ? "FAIL" : "BLOCKED", scenario, detail: browserStop.detail };
  const stopState = await scenarioState(url);
  const operationId = stopState?.stops?.find((stop) => stop.scope?.kind === "model" && stop.scope.provider === matching.provider && stop.scope.model === matching.model)?.operationId;
  const operation = operationId ? await getJson(`${url}/api/budgets/operations/${operationId}`) : { ok: false, value: null };
  if (!operation.ok || operation.value?.status !== "complete") return { status: "FAIL", scenario, detail: "The UI confirmation did not produce a completed model stop operation." };
  const matchingTargetIds = (preview.value?.targets ?? []).filter((target) => previewMatchesWorker(target, matching, matchingWorker, host.child.pid)).map((target) => target.id);
  if (!matchingTargetIds.length || !matchingTargetIds.every((id) => (operation.value?.outcomes ?? []).some((outcome) => outcome.targetId === id && ["cancelled", "terminated"].includes(outcome.status)))) return { status: "FAIL", scenario, detail: "The model stop operation lacked a correlated cancelled/terminated outcome for the matching preview target." };
  releaseBarrier(artifacts.unrelatedBarrier);
  const matchingResult = await matchingWorker.wait(8_000);
  const unrelatedOriginal = await unrelatedWorker.wait(30_000);
  if (matchingResult.timedOut || matchingResult.signal || matchingWorker.child.exitCode === null || !unrelatedWasLive || unrelatedOriginal.timedOut || unrelatedOriginal.signal || unrelatedOriginal.status !== 0 || !existsSync(artifacts.unrelated)) {
    return { status: "FAIL", scenario: "model-stop", detail: "Selective model cancellation did not stop the matching worker while the original unrelated model advanced." };
  }
  const restarted = await restartQualificationServer();
  if (!restarted) return { status: "FAIL", scenario, detail: "Token Furnace could not restart before model latch persistence verification." };
  url = restarted.url;
  const restartedState = await scenarioState(url);
  if (!restartedState) return { status: "FAIL", scenario, detail: "Budget state was unavailable after the model-stop restart." };
  const oldSessionId = workerSessionId(matchingWorker);
  const resumeBypass = await resumeNative(target, workspace, oldSessionId, `Resume the stopped session and create ${artifacts.resumeBypass}.`, 60_000, { ...matching, hostEndpoint: host.url });
  if (resumeBypass.timedOut || resumeBypass.signal || !resumeBypass.nativeSessionIds.includes(oldSessionId) || existsSync(artifacts.resumeBypass) || !decisionEvidence(source, resumeBypass.requestId, resumeBypass.startedAt, false)) return { status: "FAIL", scenario, detail: "A stopped model session could evade the persisted latch through native resume." };
  const switchBypass = await resumeNative(target, workspace, oldSessionId, `Resume the stopped session while switching models and create ${artifacts.switchBypass}.`, 60_000, { ...matching, model: unrelated.model, hostEndpoint: host.url });
  if (switchBypass.timedOut || switchBypass.signal || !switchBypass.nativeSessionIds.includes(oldSessionId) || existsSync(artifacts.switchBypass) || !decisionEvidence(source, switchBypass.requestId, switchBypass.startedAt, false)) return { status: "FAIL", scenario, detail: "A stopped model session could evade the persisted latch through a model-switch resume." };
  const bypass = await runNative(target, workspace, `Create ${artifacts.bypass} containing exactly MODEL_STOP_BYPASS.`, 60_000, { ...matching, hostEndpoint: host.url });
  if (taskUnavailable(bypass)) return { status: "BLOCKED", scenario, detail: `The post-stop matching-model launch was unavailable, not a denial: ${safeTail(bypass.output)}` };
  if (bypass.timedOut || bypass.signal || !nativeSessionObserved(source, bypass) || existsSync(artifacts.bypass) || !decisionEvidence(source, bypass.requestId, bypass.startedAt, false)) return { status: "FAIL", scenario, detail: "A fresh matching-model launch lacked a correlated native denial or created a child side effect." };
  const other = await runNative(target, workspace, `Create ${artifacts.other} containing exactly MODEL_STOP_OTHER.`, 120_000, { ...unrelated, hostEndpoint: host.url });
  if (taskUnavailable(other)) return { status: "BLOCKED", scenario, detail: `The unrelated model was unavailable after selective stop: ${safeTail(other.output)}` };
  if (other.timedOut || other.signal || other.status !== 0 || !existsSync(artifacts.other) || !nativeSessionEvidence(source, other)) return { status: "FAIL", scenario, detail: "The unrelated model did not continue after selective stop." };
  const unlocked = await unlockScope(url, restartedState.mutationToken, { kind: "model", provider: matching.provider, model: matching.model });
  if (!unlocked.ok) return { status: "FAIL", scenario, detail: "Model unlock failed after the verified stop." };
  const recovered = await runNative(target, workspace, `Create ${artifacts.recovered} containing exactly MODEL_STOP_RECOVERED and then stop.`, 120_000, { ...matching, hostEndpoint: host.url });
  return !recovered.timedOut && !recovered.signal && recovered.status === 0 && existsSync(artifacts.recovered) && nativeSessionEvidence(source, recovered) && Boolean(decisionEvidence(source, recovered.requestId, recovered.startedAt, true))
    ? { status: "PASS", scenario, detail: "Real same-host model stop, native resume/model-switch latch resistance, unrelated original-model continuation, restart persistence, and explicit recovery were observed." }
    : { status: "FAIL", scenario, detail: "Explicit model unlock did not permit a fresh native task." };
}

async function scenarioForceRecovery(source, url, workspace) {
  const state = await scenarioState(url);
  const scenario = `force-termination-recovery:${source}`;
  if (!state) return { status: "BLOCKED", scenario, detail: "Budget API was unavailable." };
  const reset = await resetPolicies(url);
  if (!reset.ok) return { status: "FAIL", scenario, detail: "Could not clear prior admission policies before force recovery." };
  const candidate = nativeIdentityCandidates().find((value) => value.source === source);
  if (!candidate) return { status: "BLOCKED", scenario, detail: "No canonical upstream identity was observed for a dedicated real session." };
  const unrelated = nativeIdentityCandidates().find((value) => value.provider !== candidate.provider);
  if (!unrelated) return { status: "BLOCKED", scenario, detail: "No unrelated real upstream control was available for force-stop collateral verification." };
  const artifacts = scenarioArtifacts(workspace, source, "force-stop", ["matching", "unrelated", "unrelatedPost", "blocked", "recovered"]);
  const worker = startNative(targets.get(candidate.source), workspace, delayedPrompt(artifacts.matching, "FORCE_STOP", artifacts.matchingBarrier), 30_000, candidate);
  const unrelatedWorker = startNative(targets.get(unrelated.source), workspace, delayedPrompt(artifacts.unrelated, "FORCE_STOP_UNRELATED", artifacts.unrelatedBarrier), 30_000, unrelated);
  nativeWorkers.push(worker.child, unrelatedWorker.child);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  if (worker.child.exitCode !== null || unrelatedWorker.child.exitCode !== null) {
    const output = `${worker.output()} ${unrelatedWorker.output()}`;
    return taskUnavailable({ output }) ? { status: "BLOCKED", scenario, detail: `Force-stop native work was unavailable: ${safeTail(output)}` } : { status: "FAIL", scenario, detail: "A force-stop native task completed before the CLI preview boundary." };
  }
  if (existsSync(artifacts.matching) || existsSync(artifacts.unrelated) || !workerNativeEvidence(candidate.source, worker) || !workerNativeEvidence(unrelated.source, unrelatedWorker)) return { status: "FAIL", scenario, detail: "The force-stop boundary lacked unique pre-confirmation or native session evidence." };
  const unrelatedWasLive = unrelatedWorker.child.exitCode === null;
  const env = isolatedEnv(candidate.source, targets.get(candidate.source).home, workspace, candidate);
  const preview = await run(packageBin, ["budgets", "stop", "--provider", candidate.provider], { cwd: workspace, env, timeout: 20_000 });
  if (preview.status !== 0) return { status: "FAIL", scenario, detail: `Installed-package stop preview failed: ${safeTail(preview.output)}` };
  if (worker.child.exitCode !== null || unrelatedWorker.child.exitCode !== null) return { status: "FAIL", scenario, detail: "The installed-package stop preview changed a live process before confirmation." };
  const previewValue = jsonOutput(preview.output);
  if (!previewValue || !previewHasSafetyArrays(previewValue) || !(previewValue.targets ?? []).some((target) => previewMatchesWorker(target, candidate, worker))) return { status: "BLOCKED", scenario, detail: "Installed-package preview did not expose the verified real target and safety scope before confirmation." };
  const normal = await run(packageBin, ["budgets", "stop", "--provider", candidate.provider, "--confirm"], { cwd: workspace, env, timeout: 20_000 });
  if (normal.status === 0 && worker.child.exitCode === null) return { status: "FAIL", scenario, detail: "The graceful CLI stop reported success while the exact owned client remained alive." };
  if (normal.status === 0 && worker.child.exitCode !== null) {
    const normalValue = jsonOutput(normal.output);
    if (!normalValue || normalValue.status !== "complete" || !(normalValue.outcomes ?? []).some((outcome) => ["cancelled", "terminated"].includes(outcome.status))) return { status: "FAIL", scenario, detail: "The graceful CLI stop exited successfully without a verified complete native outcome." };
    releaseBarrier(artifacts.unrelatedBarrier);
    const unrelatedOriginal = await unrelatedWorker.wait(30_000);
    if (!unrelatedWasLive || unrelatedOriginal.timedOut || unrelatedOriginal.signal || unrelatedOriginal.status !== 0 || !existsSync(artifacts.unrelated)) return { status: "FAIL", scenario, detail: "The original unrelated control did not advance after the graceful stop confirmation." };
    const unrelatedPost = await runNative(targets.get(unrelated.source), workspace, `Create ${artifacts.unrelatedPost} containing exactly FORCE_STOP_UNRELATED_POST and then stop.`, 120_000, unrelated);
    if (taskUnavailable(unrelatedPost)) return { status: "BLOCKED", scenario, detail: `The unrelated control was unavailable after graceful cancellation: ${safeTail(unrelatedPost.output)}` };
    if (!nativeAttemptPasses(unrelatedPost) || !existsSync(artifacts.unrelatedPost) || !nativeSessionEvidence(unrelated.source, unrelatedPost)) return { status: "FAIL", scenario, detail: "The unrelated control did not produce an attributable post-stop sentinel after graceful cancellation." };
    const blocked = await runNative(targets.get(candidate.source), workspace, `Create ${artifacts.blocked} containing exactly FORCE_STOP_BLOCKED.`, 60_000, candidate);
    if (taskUnavailable(blocked)) return { status: "BLOCKED", scenario, detail: `The post-stop matching launch was unavailable, not a denial: ${safeTail(blocked.output)}` };
    if (blocked.timedOut || blocked.signal || existsSync(artifacts.blocked) || !decisionEvidence(candidate.source, blocked.requestId, blocked.startedAt, false)) return { status: "FAIL", scenario, detail: "The graceful stop latch did not deny a fresh matching launch before unlock." };
    const unlocked = await run(packageBin, ["budgets", "unlock", "--provider", candidate.provider, "--confirm"], { cwd: workspace, env, timeout: 20_000 });
    if (unlocked.status !== 0) return { status: "FAIL", scenario, detail: `CLI unlock after graceful cancellation failed: ${safeTail(unlocked.output)}` };
    const recovered = await runNative(targets.get(candidate.source), workspace, `Create ${artifacts.recovered} containing exactly FORCE_STOP_RECOVERED and then stop.`, 120_000, candidate);
    return nativeAttemptPasses(recovered) && existsSync(artifacts.recovered) && nativeSessionEvidence(candidate.source, recovered)
      ? { status: "PASS", scenario, detail: "Installed-package graceful cancellation verified exact target exit, original unrelated advancement, durable deny, and CLI unlock recovery; force escalation was not required and was not claimed." }
      : { status: "FAIL", scenario, detail: `CLI unlock after graceful cancellation failed: ${safeTail(unlocked.output)}` };
  }
  if (normal.timedOut || worker.child.exitCode !== null) return { status: "FAIL", scenario, detail: "The graceful CLI stop did not leave a live target for separately confirmed force escalation." };
  const normalValue = jsonOutput(normal.output);
  if (!normalValue || normalValue.status !== "partial" || !(normalValue.outcomes ?? []).some((outcome) => ["requested", "unresolved", "failed"].includes(outcome.status))) return { status: "FAIL", scenario, detail: "The graceful CLI stop did not report an unresolved native outcome before force escalation." };
  const force = await run(packageBin, ["budgets", "stop", "--provider", candidate.provider, "--confirm", "--force", "--force-confirm"], { cwd: workspace, env, timeout: 20_000 });
  const forceValue = jsonOutput(force.output);
  const unlocked = await run(packageBin, ["budgets", "unlock", "--provider", candidate.provider, "--confirm"], { cwd: workspace, env, timeout: 20_000 });
  releaseBarrier(artifacts.unrelatedBarrier);
  const unrelatedOriginal = await unrelatedWorker.wait(30_000);
  if (force.status !== 0 || force.timedOut || !forceValue || forceValue.status !== "complete" || !(forceValue.outcomes ?? []).some((outcome) => outcome.targetId && outcome.status === "terminated") || worker.child.exitCode === null || !unrelatedWasLive || unrelatedOriginal.timedOut || unrelatedOriginal.signal || unrelatedOriginal.status !== 0 || !existsSync(artifacts.unrelated)) {
    return { status: "FAIL", scenario, detail: `Force recovery did not verify target exit without collateral termination: ${safeTail(`${force.output} ${unlocked.output}`)}` };
  }
  const unrelatedPost = await runNative(targets.get(unrelated.source), workspace, `Create ${artifacts.unrelatedPost} containing exactly FORCE_STOP_UNRELATED_POST and then stop.`, 120_000, unrelated);
  if (taskUnavailable(unrelatedPost)) return { status: "BLOCKED", scenario, detail: `The unrelated control was unavailable after force escalation: ${safeTail(unrelatedPost.output)}` };
  return !unrelatedPost.timedOut && !unrelatedPost.signal && unrelatedPost.status === 0 && existsSync(artifacts.unrelatedPost) && nativeSessionEvidence(unrelated.source, unrelatedPost) && unlocked.status === 0
    ? { status: "PASS", scenario, detail: "Installed-package graceful request required separately confirmed force escalation; exact target exit, original unrelated advancement, and CLI recovery were verified." }
    : { status: "FAIL", scenario, detail: `Force recovery did not verify exit and unlock: ${safeTail(`${force.output} ${unlocked.output}`)}` };
}

async function scenarioCrossHarness(workspace, browser) {
  const server = servers.at(-1);
  if (!server) return { status: "BLOCKED", scenario: "cross-harness-provider-model", detail: "Token Furnace server was not available for cross-harness control." };
  const state = await scenarioState(server.url);
  if (!state) return { status: "BLOCKED", scenario: "cross-harness-provider-model", detail: "Budget API was unavailable for cross-harness control." };
  const candidates = nativeIdentityCandidates();
  const byIdentity = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.provider}/${candidate.model}`;
    const values = byIdentity.get(key) ?? [];
    values.push(candidate);
    byIdentity.set(key, values);
  }
  const entry = [...byIdentity.values()].find((values) => new Set(values.map((value) => value.source)).size >= 2);
  if (!entry) return { status: "BLOCKED", scenario: "cross-harness-provider-model", detail: "No identical observed provider/model identity was supported by two real harnesses." };
  const reset = await resetPolicies(server.url);
  if (!reset.ok) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "Could not clear prior policies before cross-harness stop." };
  const artifacts = scenarioArtifacts(workspace, "cross-harness", "provider-model-stop", ["worker0", "worker1", "recovered0", "recovered1"]);
  const workers = entry.slice(0, 2).map((candidate, index) => startNative(targets.get(candidate.source), workspace, delayedPrompt(artifacts[`worker${index}`], `CROSS_HARNESS_${index}`, artifacts[`worker${index}Barrier`]), 30_000, candidate));
  nativeWorkers.push(...workers.map((worker) => worker.child));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  if (workers.some((worker) => worker.child.exitCode !== null)) {
    const output = workers.map((worker) => worker.output()).join(" ");
    return taskUnavailable({ output }) ? { status: "BLOCKED", scenario: "cross-harness-provider-model", detail: `Cross-harness native work was unavailable: ${safeTail(output)}` } : { status: "FAIL", scenario: "cross-harness-provider-model", detail: "A cross-harness worker completed before the confirmation boundary." };
  }
  if (workers.some((worker, index) => existsSync(artifacts[`worker${index}`]) || !workerNativeEvidence(entry[index].source, worker))) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "Cross-harness workers lacked unique pre-confirmation or native session evidence." };
  const first = entry[0];
  const preview = await stopPreview(server.url, state.mutationToken, { kind: "model", provider: first.provider, model: first.model });
  if (!preview.ok) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: `Cross-harness preview failed: ${safeTail(preview.value?.error)}` };
  if (!previewHasSafetyArrays(preview.value)) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "Cross-harness preview omitted affected, unverified, or collateral entries." };
  const selected = preview.value?.targets ?? [];
  if (!workers.every((worker, index) => selected.some((target) => target.provider === first.provider && target.model === first.model && previewMatchesWorker(target, entry[index], worker)))) return { status: "BLOCKED", scenario: "cross-harness-provider-model", detail: "The common provider/model did not resolve to both real native workers." };
  const browserStop = await driveStopBrowser(browser, server.url, `button[aria-label="Stop model ${first.provider}/${first.model}"]`, first.model);
  if (!browserStop.ok) return { status: browserStop.ran ? "FAIL" : "BLOCKED", scenario: "cross-harness-provider-model", detail: browserStop.detail };
  const stopState = await scenarioState(server.url);
  const operationId = stopState?.stops?.find((stop) => stop.scope?.kind === "model" && stop.scope.provider === first.provider && stop.scope.model === first.model)?.operationId;
  const operation = operationId ? await getJson(`${server.url}/api/budgets/operations/${operationId}`) : { ok: false, value: null };
  if (!operation.ok || operation.value?.status !== "complete") return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "The UI confirmation did not produce a completed cross-harness operation." };
  const selectedIds = selected.filter((target) => entry.some((candidate, index) => previewMatchesWorker(target, candidate, workers[index]))).map((target) => target.id);
  if (!selectedIds.length || !selectedIds.every((id) => (operation.value?.outcomes ?? []).some((outcome) => outcome.targetId === id && ["cancelled", "terminated"].includes(outcome.status)))) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "The cross-harness operation lacked correlated native outcomes for every preview target." };
  for (const barrier of [artifacts.worker0Barrier, artifacts.worker1Barrier]) {
    if (existsSync(barrier)) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "A cross-harness worker barrier changed before stop confirmation." };
  }
  const results = await Promise.all(workers.map((worker) => worker.wait(8_000)));
  if (!results.every((result, index) => !result.timedOut && !result.signal && workers[index].child.exitCode !== null)) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "Cross-harness native stop did not verify both exact client exits." };
  const restarted = await restartQualificationServer();
  if (!restarted) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "Token Furnace could not restart before cross-harness latch verification." };
  const restartedState = await scenarioState(restarted.url);
  if (!restartedState) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "Budget state was unavailable after cross-harness restart." };
  const unlocked = await unlockScope(restarted.url, restartedState.mutationToken, { kind: "model", provider: first.provider, model: first.model });
  if (!unlocked.ok) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "Cross-harness unlock failed after restart." };
  const recoveries = await Promise.all(entry.slice(0, 2).map((candidate, index) => runNative(targets.get(candidate.source), workspace, `Create ${artifacts[`recovered${index}`]} containing exactly CROSS_HARNESS_RECOVERED_${index} and then stop.`, 120_000, candidate)));
  return recoveries.every((result, index) => nativeAttemptPasses(result) && existsSync(artifacts[`recovered${index}`]) && nativeSessionEvidence(entry[index].source, result))
    ? { status: "PASS", scenario: "cross-harness-provider-model", detail: "The same observed upstream provider/model was stopped across two real native harnesses, exact exits were observed, the latch survived restart, and explicit unlock recovered both routes." }
    : { status: "FAIL", scenario: "cross-harness-provider-model", detail: "Cross-harness native stop did not verify both process exits and recovery." };
}

async function setSourcePolicy(url, source, limit) {
  const current = await getJson(`${url}/api/budgets`);
  if (!current.ok) return current;
  const deadline = new Date(Date.now() + 15 * 60_000).toISOString();
  const policies = (current.value.policies ?? []).filter((policy) => !(policy.scope?.kind === "source" && policy.scope.source === source));
  policies.push({ scope: { kind: "source", source }, mode: "manual", unit: "tokens-total", limit, deadline });
  try {
    const response = await fetch(`${url}/api/budgets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-token-furnace-mutation": current.value.mutationToken, origin: url },
      body: JSON.stringify({ expectedRevision: current.value.revision, policies }),
    });
    return { ok: response.ok, value: await response.json() };
  } catch { return { ok: false, value: null }; }
}

async function postJson(url, token, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-token-furnace-mutation": token, origin: new URL(url).origin },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, value: await response.json() };
  } catch {
    return { ok: false, value: null };
  }
}

async function driveBudgetsBrowser(browser, url) {
  const userData = mkdtempSync(join(tmpdir(), "token-furnace-browser-"));
  temporary.push(userData);
  const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${userData}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  let socket;
  try {
    const portFile = join(userData, "DevToolsActivePort");
    const started = await waitFor(() => existsSync(portFile), 15_000);
    if (!started) return { ok: false, ran: false, detail: "Browser did not expose a DevTools target." };
    const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!target) return { ok: false, ran: false, detail: "Browser page target was unavailable." };
    socket = await connectCdp(target.webSocketDebuggerUrl);
    await socket.command("Page.navigate", { url });
    await waitFor(async () => Boolean(await socket.evaluate("document.body && document.body.innerText.includes('Budgets')")), 15_000);
    const result = await socket.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const labels = ["Claude Code", "Codex", "OpenCode"];
      const autoReadings = [];
      for (const label of labels) {
        const mode = document.querySelector('select[aria-label="' + label + ' budget mode"]');
        if (!mode) continue;
        setValue(mode, "off"); await sleep(150); document.querySelector('button[aria-label="Save ' + label + ' budget"]')?.click(); await sleep(300);
        setValue(mode, "auto"); await sleep(150); document.querySelector('button[aria-label="Save ' + label + ' budget"]')?.click(); await sleep(400);
        const autoState = await (await fetch('/api/budgets', { cache: 'no-store' })).json();
        const autoSource = autoState.sources?.find((source) => source.label === label);
        if (autoSource) autoReadings.push(autoSource);
        setValue(mode, "manual"); await sleep(150);
        const limit = document.querySelector('input[aria-label="' + label + ' budget limit"]');
        if (limit) setValue(limit, "1000");
        await sleep(100); document.querySelector('button[aria-label="Save ' + label + ' budget"]')?.click(); await sleep(300);
      }
      return { budgets: document.body.innerText.includes("Budgets"), modes: document.querySelectorAll('select[aria-label$="budget mode"]').length, autoReadings };
    })()`);
    if (!result?.budgets || result.modes < 3) return { ok: false, ran: true, detail: "The real browser did not render all source mode controls." };
    return { ok: true, ran: true, detail: "browser controls exercised", autoReadings: result.autoReadings };
  } catch (error) {
    return { ok: false, ran: true, detail: `Browser scenario error: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    socket?.close();
    await stopChild(child);
  }
}

async function driveStopBrowser(browser, url, selector, expectedText) {
  if (!browser) return { ok: false, ran: false, detail: "No supported Chromium browser was discovered for UI stop confirmation." };
  const userData = mkdtempSync(join(tmpdir(), "token-furnace-stop-browser-"));
  temporary.push(userData);
  const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${userData}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  let socket;
  try {
    const portFile = join(userData, "DevToolsActivePort");
    if (!await waitFor(() => existsSync(portFile), 15_000)) return { ok: false, ran: true, detail: "Browser did not expose a DevTools target for stop confirmation." };
    const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!target) return { ok: false, ran: true, detail: "Browser page target was unavailable for stop confirmation." };
    socket = await connectCdp(target.webSocketDebuggerUrl);
    await socket.command("Page.navigate", { url: `${url}/#budgets` });
    if (!await waitFor(async () => Boolean(await socket.evaluate("document.body && document.body.innerText.includes('Budgets')")), 15_000)) return { ok: false, ran: true, detail: "Budgets tab did not load for stop confirmation." };
    const result = await socket.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button) return { ok: false, detail: "The required stop control was not rendered in the real Budgets tab." };
      button.click();
      let dialog = null;
      for (let i = 0; i < 100; i++) {
        dialog = document.querySelector('[role="dialog"]');
        if (dialog && !dialog.innerText.includes('Loading verified stop preview')) break;
        await sleep(100);
      }
      if (!dialog) return { ok: false, detail: "The real UI did not open a stop preview dialog." };
      const previewText = dialog.innerText;
      if (!previewText.includes(${JSON.stringify(expectedText)})) return { ok: false, detail: 'The UI preview did not show the expected verified identity.' };
      const confirm = [...dialog.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Confirm stop');
      if (!confirm) return { ok: false, detail: 'The real UI did not expose an explicit stop confirmation.' };
      confirm.click();
      for (let i = 0; i < 150; i++) {
        if (!document.querySelector('[role="dialog"]')) return { ok: true, previewText };
        await sleep(100);
      }
      return { ok: false, detail: 'The UI stop did not complete a verified operation before its bound.' };
    })()`);
    return result?.ok ? { ok: true, ran: true, detail: "real UI preview and confirmation completed" } : { ok: false, ran: true, detail: result?.detail ?? "Real UI stop confirmation failed." };
  } catch (error) {
    return { ok: false, ran: true, detail: `Browser stop scenario error: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    socket?.close();
    await stopChild(child);
  }
}

function delayedPrompt(sentinel, marker, barrier) {
  return barrier
    ? `Keep this native task active and do not create ${sentinel} before the harness releases the barrier. Only after ${barrier} exists and contains RELEASED, create ${sentinel} containing exactly ${marker} and stop.`
    : `Create the file ${sentinel} containing exactly ${marker} and then stop.`;
}

async function runNative(target, workspace, prompt, timeout, identity = null) {
  const worker = startNative(target, workspace, prompt, timeout, identity);
  return worker.wait(timeout);
}

async function resumeNative(target, workspace, sessionId, prompt, timeout, identity = null) {
  if (!sessionId) return { status: -1, signal: null, timedOut: false, output: "Native session ID was not observed.", nativeSessionIds: [], nativeSessionId: null, requestId: null, startedAt: Date.now() };
  const worker = startNative(target, workspace, prompt, timeout, { ...identity, resumeSessionId: sessionId });
  return worker.wait(timeout);
}

async function startOpenCodeHost(target, workspace) {
  const child = spawn(target.command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: workspace, env: isolatedEnv(target.source, target.home, workspace), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const collect = (chunk) => { output = `${output}${chunk}`.slice(-4_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const started = await waitFor(() => /https?:\/\/127\.0\.0\.1:\d+/.test(output), 15_000);
  const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
  if (!started || !match) {
    await stopChild(child);
    return null;
  }
  return { child, url: match[0] };
}

function startNative(target, workspace, prompt, timeout, identity = null) {
  if (!target) throw new Error("Native target was not discovered.");
  const sessionId = `qualify-${target.source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestId = identity?.requestId ?? sessionId;
  const args = nativeArgs(target, workspace, prompt, identity);
  const child = spawn(target.command, args, { cwd: workspace, env: isolatedEnv(target.source, target.home, workspace, { ...identity, sessionId, requestId }), stdio: ["ignore", "pipe", "pipe"] });
  const startedAt = Date.now();
  let output = "";
  let parsedOutput = "";
  const observedSessionIds = new Set();
  const collect = (chunk) => {
    output = `${output}${chunk}`.slice(-6_000);
    parsedOutput = `${parsedOutput}${chunk}`.slice(-32_000);
    for (const id of extractNativeSessionIds(parsedOutput, target.source)) observedSessionIds.add(id);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const sessionIds = () => extractNativeSessionIds(output, target.source);
  return {
    child,
    sessionIds,
    startedAt,
    output: () => output,
    wait: (waitTimeout = timeout) => new Promise((resolvePromise) => {
      let settled = false;
      let timer;
      let timedOut = false;
      const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(finishNativeResult({ ...result, source: target.source }, timedOut, output, requestId, startedAt, [...observedSessionIds])); };
      if (child.exitCode !== null || child.signalCode) {
        finish({ status: child.exitCode ?? 1, signal: child.signalCode });
        return;
      }
      timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); }, waitTimeout).unref();
      child.once("error", (error) => finish({ status: -1, output: error.message }));
      child.once("exit", (status, signal) => finish({ status: status ?? (signal ? 1 : -1), signal }));
    }),
  };
}

function finishNativeResult(result, timedOut, output, requestId, startedAt, observedSessionIds = []) {
  const source = result.source ?? null;
  const nativeSessionIds = result.nativeSessionIds ?? (observedSessionIds.length ? observedSessionIds : extractNativeSessionIds(output, source || "claude"));
  return { ...result, timedOut: result.timedOut ?? timedOut, output, requestId, startedAt, nativeSessionIds, nativeSessionId: nativeSessionIds[0] ?? null };
}

function nativeAttemptPasses(result) {
  return result?.status === 0 && !result?.timedOut && !result?.signal;
}

function nativeArgs(target, workspace, prompt, identity) {
  const model = identity?.model;
  return target.source === "claude"
    ? ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", ...(identity?.resumeSessionId ? ["--resume", identity.resumeSessionId] : []), ...(model ? ["--model", model] : []), prompt]
    : target.source === "codex"
      ? ["exec", ...(identity?.resumeSessionId ? ["resume", identity.resumeSessionId] : []), "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", ...(identity?.resumeSessionId ? [] : ["-C", workspace]), "--json", ...(model ? ["-m", model] : []), prompt]
      : ["run", ...(identity?.resumeSessionId ? ["--session", identity.resumeSessionId] : []), ...(identity?.hostEndpoint ? ["--attach", identity.hostEndpoint] : []), "--dir", workspace, "--auto", "--format", "json", ...(identity?.provider && model ? ["--model", `${identity.provider}/${model}`] : []), prompt];
}

function isolatedEnv(source, home, workspace = undefined, identity = null) {
  return {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: source === "claude" ? home : undefined,
    CODEX_HOME: source === "codex" ? home : undefined,
    OPENCODE_DATA_DIR: source === "opencode" ? home : undefined,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TOKEN_FURNACE_CONFIG_HOME: sharedConfigHome,
    TOKEN_FURNACE_STATE_HOME: sharedStateHome,
    TOKEN_FURNACE_CACHE_HOME: sharedCacheHome,
    TOKEN_FURNACE_CONTROL_TARGET: "1",
    TOKEN_FURNACE_SOURCE: source,
    TOKEN_FURNACE_EXCLUSIVE: "1",
    TOKEN_FURNACE_QUALIFY_REQUEST_ID: identity?.requestId,
    TOKEN_FURNACE_QUALIFY_WORKSPACE: workspace,
    PATH: qualifyPath(),
  };
}

function qualifyPath() {
  return `${runtimeBinDir || dirname(resolve(packageBin))}:${process.env.PATH || ""}`;
}

function findBrowser() {
  const candidates = [process.env.TOKEN_FURNACE_QUALIFY_BROWSER, "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5_000 });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function startServer(env, noPlanUsage = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [packageBin, "serve", "--port", "0", ...(noPlanUsage ? ["--no-plan-usage"] : [])], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const onData = (chunk) => {
      output = `${output}${chunk}`.slice(-4_000);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        child.stdout.off("data", onData);
        resolvePromise({ child, url: match[0], output });
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => { if (code !== null) reject(new Error(`Token Furnace server exited ${code}: ${safeTail(output)}`)); });
    setTimeout(() => reject(new Error("Token Furnace server did not start within 15 seconds.")), 15_000).unref();
  });
}

async function connectCdp(url) {
  if (typeof WebSocket !== "function") throw new Error("This Node runtime has no WebSocket client for browser control.");
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const resolver = pending.get(message.id);
    if (resolver) { pending.delete(message.id); resolver(message); }
  });
  await new Promise((resolvePromise, reject) => { socket.addEventListener("open", resolvePromise, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const command = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const requestId = ++id;
    pending.set(requestId, (message) => message.error ? reject(new Error(message.error.message)) : resolvePromise(message.result));
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  await command("Runtime.enable");
  await command("Page.enable");
  return {
    command,
    evaluate: async (expression) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed.");
      return result.result?.value;
    },
    close: () => socket.close(),
  };
}

function getJson(url) {
  return fetch(url, { cache: "no-store" }).then(async (response) => ({ ok: response.ok, value: await response.json() })).catch(() => ({ ok: false, value: null }));
}

function run(command, args, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => { output = `${output}${chunk}`.slice(-6_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); }, options.timeout).unref();
    child.once("error", (error) => { clearTimeout(timer); resolvePromise({ status: -1, output: error.message }); });
    child.once("exit", (status, signal) => { clearTimeout(timer); resolvePromise({ status: status ?? (signal ? 1 : -1), signal, timedOut, output }); });
  });
}

async function waitFor(check, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return Boolean(await check());
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolvePromise(); }, 1_000);
    child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
  });
}

function printBlocked(reasons) {
  console.error("BLOCKED: native authenticated budget qualification did not run.");
  for (const reason of reasons) console.error(`- ${reason}`);
  console.error(`No provider requests, native hook decisions, process cancellations, or PASS results were fabricated. Package identity: token-furnace@${packageVersion || "unknown"}.`);
}

function safeTail(value) {
  return String(value || "").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/(token|key|secret|password)[=:]\s*\S+/gi, "$1=[redacted]").slice(-300).replace(/\s+/g, " ");
}

function jsonOutput(value) {
  for (const line of String(value || "").trim().split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* CLI diagnostics may surround its JSON result. */ }
  }
  return null;
}

function isPersonalTarget(path) {
  const home = realpathOr(homedir());
  return [join(home, ".claude"), join(home, ".codex"), join(home, ".local", "share", "opencode")].map(realpathOr).includes(path);
}

function readPackageVersion(rootPath) {
  try { return JSON.parse(readFileSync(join(rootPath, "package.json"), "utf8")).version; } catch { return null; }
}

function pathToFileUrl(path) {
  return `file://${path.split("\\").join("/").replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

function realpathOr(path) {
  try { return realpathSync(path); } catch { return path; }
}

function parseSources(args) {
  const index = args.indexOf("--sources");
  const value = index >= 0 ? args[index + 1] : supported.join(",");
  const sources = String(value || "").split(",").map((source) => source.trim()).filter(Boolean);
  if (!sources.length || sources.some((source) => !supported.includes(source))) {
    console.error(`Usage: npm run qualify:budgets -- --sources ${supported.join(",")}`);
    process.exit(2);
  }
  return [...new Set(sources)];
}
