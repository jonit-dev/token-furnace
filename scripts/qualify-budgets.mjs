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
  console.log(`DISCOVERED ${source}: ${firstLine}`);
  return { source, home, command };
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
    warmups.set(source, { ok: warmup.status === 0 && existsSync(sentinel), detail: safeTail(warmup.output) });
  }
  const serverEnv = {
    ...isolatedEnv(requested[0], targets.get(requested[0]).home, workspace),
    CLAUDE_CONFIG_DIR: targets.get("claude")?.home,
    CODEX_HOME: targets.get("codex")?.home,
    OPENCODE_DATA_DIR: targets.get("opencode")?.home,
  };
  let server = await startServer(serverEnv);
  servers.push(server);

  const modeResult = await scenarioModePolicy(server.url, browser, workspace);
  const oldServer = server;
  await stopChild(oldServer.child);
  servers.splice(servers.indexOf(oldServer), 1);
  server = await startServer(serverEnv);
  servers.push(server);
  const persisted = await scenarioState(server.url);
  if (modeResult.status === "PASS" && requested.some((source) => !persisted?.policies?.some((policy) => policy.scope?.kind === "source" && policy.scope.source === source && policy.mode === "manual" && policy.limit === 1000))) {
    modeResult.status = "FAIL";
    modeResult.detail = "Manual browser policy did not survive the Token Furnace restart.";
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
  const offTask = await runNative(targets.get(offSource), workspace, `Create ${offSentinel} containing exactly MODE_OFF and then stop.`, 120_000);
  if (taskUnavailable(offTask)) return { status: "BLOCKED", scenario: "mode-and-policy-wiring", detail: `Default Off minimal task was unavailable: ${safeTail(offTask.output)}` };
  if (offTask.status !== 0 || offTask.timedOut || offTask.signal || !existsSync(offSentinel) || !decisionEvidence(offSource, offTask.requestId, offTask.startedAt, true)) {
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
  if (!freshAuto) {
    return { status: "BLOCKED", scenario: "mode-and-policy-wiring", detail: "Auto policy lacks a fresh authoritative quota/account/window reading for every requested source; no PASS was substituted." };
  }
  return { status: "PASS", scenario: "mode-and-policy-wiring", detail: "Real browser rendered #budgets, saved Off/Auto/Manual, preserved Manual state across the server restart, and proved an Off native task." };
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

async function stopPreview(url, token, scope) {
  return postJson(`${url}/api/budgets/stop-preview`, token, { scope });
}

async function unlockScope(url, token, scope) {
  return postJson(`${url}/api/budgets/unlock`, token, { scope });
}

async function scenarioAdmission(source, workspace, url, warmup) {
  if (!warmup?.ok) return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: `Native warmup did not complete; no admission result was fabricated. ${warmup?.detail ?? "adapter setup did not run"}` };
  const target = targets.get(source);
  const sentinel = join(workspace, `${source}-eligible-child.sentinel`);
  const background = join(workspace, `${source}-eligible-background.sentinel`);
  const prompt = delegationPrompt(source, sentinel, background, "BUDGET_ELIGIBLE");
  const task = await runNative(target, workspace, prompt, 120_000);
  const allowed = decisionEvidence(source, task.requestId, task.startedAt, true);
  if (task.timedOut || task.signal || task.status !== 0 || !existsSync(sentinel) || !existsSync(background) || !allowed) {
    return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: `Real ${source} minimal task did not complete with a sentinel; upstream access or native task capability is unavailable. ${safeTail(task.output)}` };
  }
  if (!hasMeasuredUsage(source, task.startedAt)) return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: "The eligible native task did not leave attributable measured usage in the shared budget store." };
  const exhausted = await setSourcePolicy(url, source, 1);
  if (!exhausted.ok) return { status: "FAIL", scenario: `budget-admission:${source}`, detail: "Could not persist the deliberately exhausted Manual policy." };
  const blockedSentinel = join(workspace, `${source}-blocked-child.sentinel`);
  const blockedTask = await runNative(target, workspace, delegationPrompt(source, blockedSentinel, join(workspace, `${source}-blocked-background.sentinel`), "BUDGET_BLOCKED"), 60_000);
  const denied = decisionEvidence(source, blockedTask.requestId, blockedTask.startedAt, false);
  if (taskUnavailable(blockedTask)) return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: `The exhausted native request was unavailable, not a denial: ${safeTail(blockedTask.output)}` };
  if (!denied || blockedTask.status === 0 || existsSync(blockedSentinel)) return { status: "FAIL", scenario: `budget-admission:${source}`, detail: "The exhausted request lacked a correlated native deny decision or created a child side effect." };
  return { status: "PASS", scenario: `budget-admission:${source}`, detail: "Native delegation, nested/background sentinel, measured usage exhaustion, correlated denial, and absent child side effect were observed." };
}

function delegationPrompt(source, childSentinel, backgroundSentinel, marker) {
  const route = source === "codex"
    ? "Use the native Codex code-mode or spawn_agent/delegate route, including a namespaced child if the installed client supports it."
    : source === "claude"
      ? "Use the native Claude Agent/Task delegation route, not a direct shell write."
      : "Use the installed OpenCode child/background delegation route; do not write the files directly from the parent.";
  return `${route} Delegate a tiny child task that writes exactly ${marker} to ${childSentinel}. Start a background or nested child that writes exactly ${marker}_BACKGROUND to ${backgroundSentinel}, wait for both children, and resume the first child if it pauses. Then stop. A missing native delegation path is an unavailable qualification result, not permission to write these files directly.`;
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

function taskUnavailable(result) {
  return Boolean(result?.timedOut || result?.signal || /(?:login|auth|credential|not found|unknown option|unavailable|timed out)/i.test(result?.output ?? ""));
}

async function scenarioProviderStop(source, url, workspace, browser) {
  const state = await scenarioState(url);
  const scenario = `provider-stop:${source}`;
  if (!state) return { status: "BLOCKED", scenario, detail: "Budget API was unavailable." };
  const reset = await resetPolicies(url);
  if (!reset.ok) return { status: "FAIL", scenario, detail: "Could not clear prior admission policies before the stop scenario." };
  const candidates = identityCandidates(state);
  const matching = candidates.find((candidate) => candidate.source === source);
  const matchingCandidates = matching ? candidates.filter((candidate) => candidate.provider === matching.provider) : [];
  const unrelated = candidates.find((candidate) => candidate.provider !== matching?.provider);
  if (!matching || matchingCandidates.length < 2 || !unrelated) return { status: "BLOCKED", scenario, detail: "Two real harnesses with the same observed upstream provider and an unrelated provider control were not available." };
  const matchingWorkers = matchingCandidates.map((candidate, index) => startNative(targets.get(candidate.source), workspace, delayedPrompt(join(workspace, `provider-stop-matching-${index}.sentinel`), `PROVIDER_STOP_MATCHING_${index}`), 30_000, candidate));
  const unrelatedSentinel = join(workspace, "provider-stop-unrelated.sentinel");
  const unrelatedWorker = startNative(targets.get(unrelated.source), workspace, delayedPrompt(unrelatedSentinel, "PROVIDER_STOP_UNRELATED"), 30_000, unrelated);
  nativeWorkers.push(...matchingWorkers.map((worker) => worker.child), unrelatedWorker.child);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const preview = await stopPreview(url, state.mutationToken, { kind: "provider", provider: matching.provider });
  if (!preview.ok) return { status: "FAIL", scenario, detail: `Provider stop preview failed: ${safeTail(preview.value?.error)}` };
  const selected = matchingCandidates.every((candidate, index) => (preview.value?.targets ?? []).some((target) => target.source === candidate.source && target.provider === candidate.provider && (candidate.source === "opencode" || target.pid === matchingWorkers[index].child.pid)));
  if (!selected) return { status: "BLOCKED", scenario, detail: "The real matching worker did not appear in the verified provider preview." };
  const browserStop = await driveStopBrowser(browser, url, `button[aria-label="Stop upstream provider ${matching.provider} in all harnesses"]`, matching.provider);
  if (!browserStop.ok) return { status: browserStop.ran ? "FAIL" : "BLOCKED", scenario, detail: browserStop.detail };
  const stopState = await scenarioState(url);
  const operationId = stopState?.stops?.find((stop) => stop.scope?.kind === "provider" && stop.scope.provider === matching.provider)?.operationId;
  const operation = operationId ? await getJson(`${url}/api/budgets/operations/${operationId}`) : { ok: false, value: null };
  if (!operation.ok || operation.value?.status !== "complete") return { status: "FAIL", scenario, detail: "The UI confirmation did not produce a completed provider stop operation." };
  const matchingResults = await Promise.all(matchingWorkers.map((worker) => worker.wait(8_000)));
  const unrelatedAlive = unrelatedWorker.child.exitCode === null;
  if (matchingResults.some((result, index) => result.timedOut || result.status === 0 || matchingWorkers[index].child.exitCode === null) || !unrelatedAlive) {
    return { status: "FAIL", scenario, detail: "The verified matching worker did not exit or the unrelated provider worker stopped too." };
  }
  const unrelatedPostSentinel = join(workspace, "provider-stop-unrelated-post.sentinel");
  const unrelatedPost = await runNative(targets.get(unrelated.source), workspace, `Create ${unrelatedPostSentinel} containing exactly PROVIDER_STOP_UNRELATED_POST and then stop.`, 120_000, unrelated);
  if (taskUnavailable(unrelatedPost)) return { status: "BLOCKED", scenario, detail: `The unrelated provider did not have a usable post-stop control: ${safeTail(unrelatedPost.output)}` };
  if (unrelatedPost.timedOut || unrelatedPost.signal || unrelatedPost.status !== 0 || !existsSync(unrelatedPostSentinel)) return { status: "FAIL", scenario, detail: "The unrelated provider did not produce a post-stop sentinel." };
  const blockedSentinel = join(workspace, "provider-stop-blocked.sentinel");
  const blocked = await runNative(targets.get(matching.source), workspace, `Create ${blockedSentinel} containing exactly PROVIDER_STOP_BLOCKED.`, 60_000, matching);
  if (taskUnavailable(blocked)) return { status: "BLOCKED", scenario, detail: `The post-stop matching-provider launch was unavailable, not a denial: ${safeTail(blocked.output)}` };
  if (blocked.timedOut || blocked.signal || blocked.status === 0 || existsSync(blockedSentinel) || !decisionEvidence(matching.source, blocked.requestId, blocked.startedAt, false)) return { status: "FAIL", scenario, detail: "A fresh matching-provider launch lacked a correlated native denial or created a child side effect." };
  const unlocked = await unlockScope(url, state.mutationToken, { kind: "provider", provider: matching.provider });
  if (!unlocked.ok) return { status: "FAIL", scenario, detail: "Provider unlock failed after the verified stop." };
  const recoveredSentinel = join(workspace, "provider-stop-recovered.sentinel");
  const recovered = await runNative(targets.get(matching.source), workspace, `Create ${recoveredSentinel} containing exactly PROVIDER_STOP_RECOVERED and then stop.`, 120_000, matching);
  return !recovered.timedOut && !recovered.signal && recovered.status === 0 && existsSync(recoveredSentinel) && Boolean(decisionEvidence(matching.source, recovered.requestId, recovered.startedAt, true))
    ? { status: "PASS", scenario, detail: "Real matching provider worker exited, unrelated provider worker stayed alive, latch denied a fresh launch, and unlock recovered it." }
    : { status: "FAIL", scenario, detail: "Explicit provider unlock did not permit a fresh native task." };
}

async function scenarioModelStop(source, url, workspace, browser) {
  const state = await scenarioState(url);
  const scenario = `model-stop:${source}`;
  if (!state) return { status: "BLOCKED", scenario, detail: "Budget API was unavailable." };
  const reset = await resetPolicies(url);
  if (!reset.ok) return { status: "FAIL", scenario, detail: "Could not clear prior admission policies before the model scenario." };
  const candidates = modelCandidates(state);
  const matching = candidates.find((candidate) => candidate.source === source);
  const unrelated = candidates.find((candidate) => candidate.source === matching?.source && candidate.model !== matching.model);
  if (!matching || !unrelated) return { status: "BLOCKED", scenario, detail: "Two canonical models in one actual native host were not available for selective cancellation." };
  if (source !== "opencode") return { status: "BLOCKED", scenario, detail: "This source has no supported same-host mixed-model route in the installed native client; separate processes are not accepted as model-stop evidence." };
  const target = targets.get(matching.source);
  const otherTarget = targets.get(unrelated.source);
  const host = await startOpenCodeHost(target, workspace);
  if (!host) return { status: "BLOCKED", scenario, detail: "OpenCode did not expose a real shared native server for mixed-model work." };
  nativeWorkers.push(host.child);
  const matchingWorker = startNative(target, workspace, delayedPrompt(join(workspace, "model-stop-matching.sentinel"), "MODEL_STOP_MATCHING"), 30_000, { ...matching, hostEndpoint: host.url });
  const unrelatedWorker = startNative(otherTarget, workspace, delayedPrompt(join(workspace, "model-stop-unrelated.sentinel"), "MODEL_STOP_UNRELATED"), 30_000, { ...unrelated, hostEndpoint: host.url });
  nativeWorkers.push(matchingWorker.child, unrelatedWorker.child);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const preview = await stopPreview(url, state.mutationToken, { kind: "model", provider: matching.provider, model: matching.model });
  if (!preview.ok) return { status: "FAIL", scenario, detail: `Model stop preview failed: ${safeTail(preview.value?.error)}` };
  const selected = (preview.value?.targets ?? []).some((item) => item.model === matching.model && item.source === source && item.pid === host.child.pid);
  if (!selected) return { status: "BLOCKED", scenario, detail: "The real matching model worker did not appear in the verified preview." };
  const browserStop = await driveStopBrowser(browser, url, `button[aria-label="Stop model ${matching.provider}/${matching.model}"]`, matching.model);
  if (!browserStop.ok) return { status: browserStop.ran ? "FAIL" : "BLOCKED", scenario, detail: browserStop.detail };
  const stopState = await scenarioState(url);
  const operationId = stopState?.stops?.find((stop) => stop.scope?.kind === "model" && stop.scope.provider === matching.provider && stop.scope.model === matching.model)?.operationId;
  const operation = operationId ? await getJson(`${url}/api/budgets/operations/${operationId}`) : { ok: false, value: null };
  if (!operation.ok || operation.value?.status !== "complete") return { status: "FAIL", scenario, detail: "The UI confirmation did not produce a completed model stop operation." };
  const matchingResult = await matchingWorker.wait(8_000);
  if (matchingResult.timedOut || matchingResult.status === 0 || matchingWorker.child.exitCode === null || unrelatedWorker.child.exitCode !== null) {
    return { status: "FAIL", scenario: "model-stop", detail: "Selective model cancellation did not stop only the verified matching worker." };
  }
  const bypassSentinel = join(workspace, "model-stop-bypass.sentinel");
  const bypass = await runNative(target, workspace, `Create ${bypassSentinel} containing exactly MODEL_STOP_BYPASS.`, 60_000, matching);
  if (taskUnavailable(bypass)) return { status: "BLOCKED", scenario, detail: `The post-stop matching-model launch was unavailable, not a denial: ${safeTail(bypass.output)}` };
  if (bypass.timedOut || bypass.signal || bypass.status === 0 || existsSync(bypassSentinel) || !decisionEvidence(source, bypass.requestId, bypass.startedAt, false)) return { status: "FAIL", scenario, detail: "A fresh matching-model launch lacked a correlated native denial or created a child side effect." };
  const otherSentinel = join(workspace, "model-stop-other-recovery.sentinel");
  const other = await runNative(otherTarget, workspace, `Create ${otherSentinel} containing exactly MODEL_STOP_OTHER.`, 120_000, unrelated);
  if (taskUnavailable(other)) return { status: "BLOCKED", scenario, detail: `The unrelated model was unavailable after selective stop: ${safeTail(other.output)}` };
  if (other.timedOut || other.signal || other.status !== 0 || !existsSync(otherSentinel)) return { status: "FAIL", scenario, detail: "The unrelated model did not continue after selective stop." };
  const unlocked = await unlockScope(url, state.mutationToken, { kind: "model", provider: matching.provider, model: matching.model });
  if (!unlocked.ok) return { status: "FAIL", scenario, detail: "Model unlock failed after the verified stop." };
  const recoveredSentinel = join(workspace, "model-stop-recovered.sentinel");
  const recovered = await runNative(target, workspace, `Create ${recoveredSentinel} containing exactly MODEL_STOP_RECOVERED and then stop.`, 120_000, matching);
  return !recovered.timedOut && !recovered.signal && recovered.status === 0 && existsSync(recoveredSentinel) && Boolean(decisionEvidence(source, recovered.requestId, recovered.startedAt, true))
    ? { status: "PASS", scenario, detail: "Real same-host model stop, alias-resistant latch, unrelated-model continuation, and explicit recovery were observed." }
    : { status: "FAIL", scenario, detail: "Explicit model unlock did not permit a fresh native task." };
}

async function scenarioForceRecovery(source, url, workspace) {
  const state = await scenarioState(url);
  const scenario = `force-termination-recovery:${source}`;
  if (!state) return { status: "BLOCKED", scenario, detail: "Budget API was unavailable." };
  const reset = await resetPolicies(url);
  if (!reset.ok) return { status: "FAIL", scenario, detail: "Could not clear prior admission policies before force recovery." };
  const candidate = identityCandidates(state).find((value) => value.source === source);
  if (!candidate) return { status: "BLOCKED", scenario, detail: "No canonical upstream identity was observed for a dedicated real session." };
  const unrelated = identityCandidates(state).find((value) => value.provider !== candidate.provider);
  if (!unrelated) return { status: "BLOCKED", scenario, detail: "No unrelated real upstream control was available for force-stop collateral verification." };
  const worker = startNative(targets.get(candidate.source), workspace, delayedPrompt(join(workspace, "force-stop.sentinel"), "FORCE_STOP"), 30_000, candidate);
  const unrelatedWorker = startNative(targets.get(unrelated.source), workspace, delayedPrompt(join(workspace, "force-stop-unrelated.sentinel"), "FORCE_STOP_UNRELATED"), 30_000, unrelated);
  nativeWorkers.push(worker.child, unrelatedWorker.child);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const env = isolatedEnv(candidate.source, targets.get(candidate.source).home, workspace, candidate);
  const preview = await run(packageBin, ["budgets", "stop", "--provider", candidate.provider], { cwd: workspace, env, timeout: 20_000 });
  if (preview.status !== 0) return { status: "FAIL", scenario, detail: `Installed-package stop preview failed: ${safeTail(preview.output)}` };
  const previewValue = jsonOutput(preview.output);
  if (!previewValue || !(previewValue.targets ?? []).some((target) => target.provider === candidate.provider)) return { status: "BLOCKED", scenario, detail: "Installed-package preview did not expose the verified real target before confirmation." };
  const normal = await run(packageBin, ["budgets", "stop", "--provider", candidate.provider, "--confirm"], { cwd: workspace, env, timeout: 20_000 });
  if (normal.status === 0 && worker.child.exitCode !== null) {
    const unlocked = await run(packageBin, ["budgets", "unlock", "--provider", candidate.provider, "--confirm"], { cwd: workspace, env, timeout: 20_000 });
    return unlocked.status === 0
      ? { status: "BLOCKED", scenario, detail: "The real adapter completed graceful cancellation; no force escalation was needed, so no stuck native endpoint was fabricated." }
      : { status: "FAIL", scenario, detail: `CLI unlock after graceful cancellation failed: ${safeTail(unlocked.output)}` };
  }
  if (normal.timedOut || worker.child.exitCode !== null) return { status: "FAIL", scenario, detail: "The graceful CLI stop did not leave a live target for separately confirmed force escalation." };
  const normalValue = jsonOutput(normal.output);
  if (!normalValue || normalValue.status !== "partial" || !(normalValue.outcomes ?? []).some((outcome) => ["requested", "unresolved", "failed"].includes(outcome.status))) return { status: "FAIL", scenario, detail: "The graceful CLI stop did not report an unresolved native outcome before force escalation." };
  const force = await run(packageBin, ["budgets", "stop", "--provider", candidate.provider, "--confirm", "--force", "--force-confirm"], { cwd: workspace, env, timeout: 20_000 });
  const forceValue = jsonOutput(force.output);
  const unlocked = await run(packageBin, ["budgets", "unlock", "--provider", candidate.provider, "--confirm"], { cwd: workspace, env, timeout: 20_000 });
  if (force.status !== 0 || force.timedOut || !forceValue || forceValue.status !== "complete" || !(forceValue.outcomes ?? []).some((outcome) => outcome.targetId && outcome.status === "terminated") || worker.child.exitCode === null || unrelatedWorker.child.exitCode !== null) {
    return { status: "FAIL", scenario, detail: `Force recovery did not verify target exit without collateral termination: ${safeTail(`${force.output} ${unlocked.output}`)}` };
  }
  const unrelatedSentinel = join(workspace, "force-stop-unrelated-post.sentinel");
  const unrelatedPost = await runNative(targets.get(unrelated.source), workspace, `Create ${unrelatedSentinel} containing exactly FORCE_STOP_UNRELATED_POST and then stop.`, 120_000, unrelated);
  if (taskUnavailable(unrelatedPost)) return { status: "BLOCKED", scenario, detail: `The unrelated control was unavailable after force escalation: ${safeTail(unrelatedPost.output)}` };
  return !unrelatedPost.timedOut && !unrelatedPost.signal && unrelatedPost.status === 0 && existsSync(unrelatedSentinel) && unlocked.status === 0
    ? { status: "PASS", scenario, detail: "Installed-package graceful request required explicit force escalation; exit and CLI recovery were verified." }
    : { status: "FAIL", scenario, detail: `Force recovery did not verify exit and unlock: ${safeTail(`${force.output} ${unlocked.output}`)}` };
}

async function scenarioCrossHarness(workspace, browser) {
  const server = servers.at(-1);
  if (!server) return { status: "BLOCKED", scenario: "cross-harness-provider-model", detail: "Token Furnace server was not available for cross-harness control." };
  const state = await scenarioState(server.url);
  if (!state) return { status: "BLOCKED", scenario: "cross-harness-provider-model", detail: "Budget API was unavailable for cross-harness control." };
  const candidates = modelCandidates(state);
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
  const workers = entry.slice(0, 2).map((candidate, index) => startNative(targets.get(candidate.source), workspace, delayedPrompt(join(workspace, `cross-harness-${index}.sentinel`), `CROSS_HARNESS_${index}`), 30_000, candidate));
  nativeWorkers.push(...workers.map((worker) => worker.child));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const first = entry[0];
  const preview = await stopPreview(server.url, state.mutationToken, { kind: "model", provider: first.provider, model: first.model });
  if (!preview.ok) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: `Cross-harness preview failed: ${safeTail(preview.value?.error)}` };
  const selected = preview.value?.targets ?? [];
  if (!workers.every((worker, index) => selected.some((target) => target.provider === first.provider && target.model === first.model && target.source === entry[index].source && (entry[index].source === "opencode" || target.pid === worker.child.pid)))) return { status: "BLOCKED", scenario: "cross-harness-provider-model", detail: "The common provider/model did not resolve to both real native workers." };
  const browserStop = await driveStopBrowser(browser, server.url, `button[aria-label="Stop model ${first.provider}/${first.model}"]`, first.model);
  if (!browserStop.ok) return { status: browserStop.ran ? "FAIL" : "BLOCKED", scenario: "cross-harness-provider-model", detail: browserStop.detail };
  const stopState = await scenarioState(server.url);
  const operationId = stopState?.stops?.find((stop) => stop.scope?.kind === "model" && stop.scope.provider === first.provider && stop.scope.model === first.model)?.operationId;
  const operation = operationId ? await getJson(`${server.url}/api/budgets/operations/${operationId}`) : { ok: false, value: null };
  if (!operation.ok || operation.value?.status !== "complete") return { status: "FAIL", scenario: "cross-harness-provider-model", detail: "The UI confirmation did not produce a completed cross-harness operation." };
  const results = await Promise.all(workers.map((worker) => worker.wait(8_000)));
  const unlocked = await unlockScope(server.url, state.mutationToken, { kind: "model", provider: first.provider, model: first.model });
  return results.every((result, index) => !result.timedOut && result.status !== 0 && workers[index].child.exitCode !== null) && unlocked.ok
    ? { status: "PASS", scenario: "cross-harness-provider-model", detail: "The same observed upstream provider/model was stopped across two real native harnesses and explicitly unlocked." }
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
    return { ok: true, ran: true, detail: "browser controls exercised" };
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

function delayedPrompt(sentinel, marker) {
  return `Wait for 20 seconds, then create the file ${sentinel} containing exactly ${marker} and stop.`;
}

async function runNative(target, workspace, prompt, timeout) {
  const worker = startNative(target, workspace, prompt, timeout);
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
  const collect = (chunk) => { output = `${output}${chunk}`.slice(-6_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return {
    child,
    wait: (waitTimeout = timeout) => new Promise((resolvePromise) => {
      let settled = false;
      let timer;
      let timedOut = false;
      const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise({ ...result, timedOut: result.timedOut ?? timedOut, output, requestId, startedAt }); };
      if (child.exitCode !== null || child.signalCode) {
        finish({ status: child.exitCode ?? 1, signal: child.signalCode, timedOut: false });
        return;
      }
      timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); }, waitTimeout).unref();
      child.once("error", (error) => finish({ status: -1, timedOut: false, output: error.message }));
      child.once("exit", (status, signal) => finish({ status: status ?? (signal ? 1 : -1), signal, timedOut: false }));
    }),
  };
}

function nativeArgs(target, workspace, prompt, identity) {
  const model = identity?.model;
  return target.source === "claude"
    ? ["-p", "--dangerously-skip-permissions", "--no-session-persistence", ...(model ? ["--model", model] : []), prompt]
    : target.source === "codex"
      ? ["exec", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "-C", workspace, ...(model ? ["-m", model] : []), prompt]
      : ["run", ...(identity?.hostEndpoint ? ["--attach", identity.hostEndpoint] : []), "--dir", workspace, "--auto", "--format", "json", ...(identity?.provider && model ? ["--model", `${identity.provider}/${model}`] : []), prompt];
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
    TOKEN_FURNACE_SESSION_ID: identity?.sessionId,
    TOKEN_FURNACE_PROVIDER: identity?.provider,
    TOKEN_FURNACE_ACCOUNT: identity?.account,
    TOKEN_FURNACE_MODEL: identity?.model,
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

function startServer(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [packageBin, "serve", "--port", "0"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
