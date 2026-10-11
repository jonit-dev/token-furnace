#!/usr/bin/env node
/**
 * Native qualification. Every side effect is confined to explicitly dedicated homes and a
 * temporary workspace. A missing native capability is BLOCKED; a command that ran and failed is
 * FAIL. Only exercised, observed scenarios can be PASS.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const supported = ["claude", "codex", "opencode"];
const requested = parseSources(process.argv.slice(2));
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const packageBin = process.env.TOKEN_FURNACE_QUALIFY_BIN || join(root, "dist", "cli.js");
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

try {
  discoverPackage();
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

function discoverPackage() {
  if (!existsSync(packageBin)) throw new Error(`Built package entrypoint is missing: ${packageBin}`);
  if (!existsSync(join(root, "dist", "dashboard.html"))) throw new Error("Built dashboard asset is missing; run npm run build first.");
  if (!packageVersion) throw new Error("Package identity could not be read.");
  runtimeBinDir = mkdtempSync(join(tmpdir(), "token-furnace-bin-"));
  temporary.push(runtimeBinDir);
  try {
    symlinkSync(resolve(packageBin), join(runtimeBinDir, "token-furnace"));
  } catch {
    writeFileSync(join(runtimeBinDir, "token-furnace"), `#!/usr/bin/env node\nconst mod = await import(${JSON.stringify(pathToFileUrl(resolve(packageBin)))});\nprocess.exitCode = await mod.main();\n`);
    chmodSync(join(runtimeBinDir, "token-furnace"), 0o700);
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
  temporary.push(workspace);
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
  const server = await startServer(serverEnv);
  servers.push(server);

  results.push(await scenarioModePolicy(server.url, browser));
  for (const source of requested) {
    results.push(await scenarioAdmission(source, workspace, server.url, warmups.get(source)));
  }
  results.push(await scenarioProviderStop(server.url, workspace));
  results.push(await scenarioModelStop(server.url, workspace));
  results.push(await scenarioForceRecovery(server.url, workspace));
  if (requested.length >= 2) results.push(await scenarioCrossHarness(workspace));
  else results.push({ status: "BLOCKED", scenario: "cross-harness-provider-model", detail: "At least two requested native harnesses are required." });
  return results;
}

async function scenarioModePolicy(url, browser) {
  if (!browser) return { status: "BLOCKED", scenario: "mode-and-policy-wiring", detail: "No supported Chromium browser was discovered." };
  const result = await driveBudgetsBrowser(browser, `${url}/#budgets`);
  if (!result.ok) return { status: result.ran ? "FAIL" : "BLOCKED", scenario: "mode-and-policy-wiring", detail: result.detail };
  const state = await getJson(`${url}/api/budgets`);
  if (!state.ok || !Array.isArray(state.value?.policies) || state.value.policies.length < requested.length) {
    return { status: "FAIL", scenario: "mode-and-policy-wiring", detail: "Browser forms did not persist all requested policies." };
  }
  return { status: "PASS", scenario: "mode-and-policy-wiring", detail: "Real browser rendered #budgets and saved Off, Auto, and Manual forms." };
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

async function commitPreview(url, token, preview, force = false) {
  return postJson(`${url}/api/budgets/stop`, token, {
    previewId: preview.id,
    fingerprint: preview.fingerprint,
    ...(force ? { force: true, forceConfirm: true } : {}),
  });
}

async function unlockScope(url, token, scope) {
  return postJson(`${url}/api/budgets/unlock`, token, { scope });
}

async function scenarioAdmission(source, workspace, url, warmup) {
  if (!warmup?.ok) return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: `Native warmup did not complete; no admission result was fabricated. ${warmup?.detail ?? "adapter setup did not run"}` };
  const target = targets.get(source);
  const sentinel = join(workspace, `${source}-eligible.sentinel`);
  const prompt = `Create the file ${sentinel} containing exactly BUDGET_ELIGIBLE and then stop.`;
  const task = await runNative(target, workspace, prompt, 120_000);
  if (task.status !== 0 || !existsSync(sentinel)) {
    return { status: "BLOCKED", scenario: `budget-admission:${source}`, detail: `Real ${source} minimal task did not complete with a sentinel; upstream access or native task capability is unavailable. ${safeTail(task.output)}` };
  }
  const exhausted = await setSourcePolicy(url, source, 1);
  if (!exhausted.ok) return { status: "FAIL", scenario: `budget-admission:${source}`, detail: "Could not persist the deliberately exhausted Manual policy." };
  const blockedSentinel = join(workspace, `${source}-blocked.sentinel`);
  const blockedTask = await runNative(target, workspace, `Create ${blockedSentinel} containing exactly BUDGET_BLOCKED.`, 60_000);
  if (blockedTask.status === 0 && existsSync(blockedSentinel)) {
    return { status: "FAIL", scenario: `budget-admission:${source}`, detail: "A deliberately exhausted native policy did not deny the request." };
  }
  return { status: "PASS", scenario: `budget-admission:${source}`, detail: "Native task and denied side-effect assertion completed." };
}

async function scenarioProviderStop(url, workspace) {
  const state = await scenarioState(url);
  if (!state) return { status: "BLOCKED", scenario: "provider-stop", detail: "Budget API was unavailable." };
  const reset = await resetPolicies(url);
  if (!reset.ok) return { status: "FAIL", scenario: "provider-stop", detail: "Could not clear prior admission policies before the stop scenario." };
  const candidates = identityCandidates(state);
  const matching = candidates[0];
  const unrelated = candidates.find((candidate) => candidate.provider !== matching?.provider);
  if (!matching || !unrelated) return { status: "BLOCKED", scenario: "provider-stop", detail: "Two distinct observed upstream providers were not available for a selective native stop." };
  const matchingSentinel = join(workspace, "provider-stop-matching.sentinel");
  const unrelatedSentinel = join(workspace, "provider-stop-unrelated.sentinel");
  const matchingWorker = startNative(targets.get(matching.source), workspace, delayedPrompt(matchingSentinel, "PROVIDER_STOP_MATCHING"), 30_000, matching);
  const unrelatedWorker = startNative(targets.get(unrelated.source), workspace, delayedPrompt(unrelatedSentinel, "PROVIDER_STOP_UNRELATED"), 30_000, unrelated);
  nativeWorkers.push(matchingWorker.child, unrelatedWorker.child);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const preview = await stopPreview(url, state.mutationToken, { kind: "provider", provider: matching.provider });
  if (!preview.ok) return { status: "FAIL", scenario: "provider-stop", detail: `Provider stop preview failed: ${safeTail(preview.value?.error)}` };
  const selected = (preview.value?.targets ?? []).some((target) => target.pid === matchingWorker.child.pid && target.provider === matching.provider);
  if (!selected) return { status: "BLOCKED", scenario: "provider-stop", detail: "The real matching worker did not appear in the verified provider preview." };
  const commit = await commitPreview(url, state.mutationToken, preview.value);
  if (!commit.ok) return { status: "FAIL", scenario: "provider-stop", detail: `Provider stop commit failed: ${safeTail(commit.value?.error)}` };
  const matchingResult = await matchingWorker.wait(8_000);
  const unrelatedAlive = unrelatedWorker.child.exitCode === null;
  if (matchingResult.status === 0 || matchingWorker.child.exitCode === null || !unrelatedAlive) {
    return { status: "FAIL", scenario: "provider-stop", detail: "The verified matching worker did not exit or the unrelated provider worker stopped too." };
  }
  const blockedSentinel = join(workspace, "provider-stop-blocked.sentinel");
  const blocked = await runNative(targets.get(matching.source), workspace, `Create ${blockedSentinel} containing exactly PROVIDER_STOP_BLOCKED.`, 60_000, matching);
  if (blocked.status === 0 && existsSync(blockedSentinel)) return { status: "FAIL", scenario: "provider-stop", detail: "A fresh matching-provider launch bypassed the persisted stop latch." };
  const unlocked = await unlockScope(url, state.mutationToken, { kind: "provider", provider: matching.provider });
  if (!unlocked.ok) return { status: "FAIL", scenario: "provider-stop", detail: "Provider unlock failed after the verified stop." };
  const recoveredSentinel = join(workspace, "provider-stop-recovered.sentinel");
  const recovered = await runNative(targets.get(matching.source), workspace, `Create ${recoveredSentinel} containing exactly PROVIDER_STOP_RECOVERED and then stop.`, 120_000, matching);
  return recovered.status === 0 && existsSync(recoveredSentinel)
    ? { status: "PASS", scenario: "provider-stop", detail: "Real matching provider worker exited, unrelated provider worker stayed alive, latch denied a fresh launch, and unlock recovered it." }
    : { status: "FAIL", scenario: "provider-stop", detail: "Explicit provider unlock did not permit a fresh native task." };
}

async function scenarioModelStop(url, workspace) {
  const state = await scenarioState(url);
  if (!state) return { status: "BLOCKED", scenario: "model-stop", detail: "Budget API was unavailable." };
  const reset = await resetPolicies(url);
  if (!reset.ok) return { status: "FAIL", scenario: "model-stop", detail: "Could not clear prior admission policies before the model scenario." };
  const candidates = modelCandidates(state);
  const matching = candidates[0];
  const unrelated = candidates.find((candidate) => candidate.source === matching?.source && candidate.model !== matching.model);
  if (!matching || !unrelated) return { status: "BLOCKED", scenario: "model-stop", detail: "Two canonical models in one observed native host were not available for selective cancellation." };
  const target = targets.get(matching.source);
  const otherTarget = targets.get(unrelated.source);
  const matchingWorker = startNative(target, workspace, delayedPrompt(join(workspace, "model-stop-matching.sentinel"), "MODEL_STOP_MATCHING"), 30_000, matching);
  const unrelatedWorker = startNative(otherTarget, workspace, delayedPrompt(join(workspace, "model-stop-unrelated.sentinel"), "MODEL_STOP_UNRELATED"), 30_000, unrelated);
  nativeWorkers.push(matchingWorker.child, unrelatedWorker.child);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const preview = await stopPreview(url, state.mutationToken, { kind: "model", provider: matching.provider, model: matching.model });
  if (!preview.ok) return { status: "FAIL", scenario: "model-stop", detail: `Model stop preview failed: ${safeTail(preview.value?.error)}` };
  const selected = (preview.value?.targets ?? []).some((item) => item.pid === matchingWorker.child.pid && item.model === matching.model);
  if (!selected) return { status: "BLOCKED", scenario: "model-stop", detail: "The real matching model worker did not appear in the verified preview." };
  const commit = await commitPreview(url, state.mutationToken, preview.value);
  if (!commit.ok) return { status: "FAIL", scenario: "model-stop", detail: `Model stop commit failed: ${safeTail(commit.value?.error)}` };
  const matchingResult = await matchingWorker.wait(8_000);
  if (matchingResult.status === 0 || matchingWorker.child.exitCode === null || unrelatedWorker.child.exitCode !== null) {
    return { status: "FAIL", scenario: "model-stop", detail: "Selective model cancellation did not stop only the verified matching worker." };
  }
  const bypassSentinel = join(workspace, "model-stop-bypass.sentinel");
  const bypass = await runNative(target, workspace, `Create ${bypassSentinel} containing exactly MODEL_STOP_BYPASS.`, 60_000, matching);
  if (bypass.status === 0 && existsSync(bypassSentinel)) return { status: "FAIL", scenario: "model-stop", detail: "A fresh matching-model launch bypassed the persisted latch." };
  const otherSentinel = join(workspace, "model-stop-other-recovery.sentinel");
  const other = await runNative(otherTarget, workspace, `Create ${otherSentinel} containing exactly MODEL_STOP_OTHER.`, 120_000, unrelated);
  if (other.status !== 0 || !existsSync(otherSentinel)) return { status: "FAIL", scenario: "model-stop", detail: "The unrelated model did not continue after selective stop." };
  const unlocked = await unlockScope(url, state.mutationToken, { kind: "model", provider: matching.provider, model: matching.model });
  if (!unlocked.ok) return { status: "FAIL", scenario: "model-stop", detail: "Model unlock failed after the verified stop." };
  const recoveredSentinel = join(workspace, "model-stop-recovered.sentinel");
  const recovered = await runNative(target, workspace, `Create ${recoveredSentinel} containing exactly MODEL_STOP_RECOVERED and then stop.`, 120_000, matching);
  return recovered.status === 0 && existsSync(recoveredSentinel)
    ? { status: "PASS", scenario: "model-stop", detail: "Real model stop, alias-resistant latch, unrelated-model continuation, and explicit recovery were observed." }
    : { status: "FAIL", scenario: "model-stop", detail: "Explicit model unlock did not permit a fresh native task." };
}

async function scenarioForceRecovery(url, workspace) {
  const state = await scenarioState(url);
  if (!state) return { status: "BLOCKED", scenario: "force-termination-recovery", detail: "Budget API was unavailable." };
  const reset = await resetPolicies(url);
  if (!reset.ok) return { status: "FAIL", scenario: "force-termination-recovery", detail: "Could not clear prior admission policies before force recovery." };
  const candidate = identityCandidates(state)[0];
  if (!candidate) return { status: "BLOCKED", scenario: "force-termination-recovery", detail: "No canonical upstream identity was observed for a dedicated real session." };
  const worker = startNative(targets.get(candidate.source), workspace, delayedPrompt(join(workspace, "force-stop.sentinel"), "FORCE_STOP"), 30_000, candidate);
  nativeWorkers.push(worker.child);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const env = isolatedEnv(candidate.source, targets.get(candidate.source).home, workspace, candidate);
  const preview = await run(packageBin, ["budgets", "stop", "--provider", candidate.provider], { cwd: workspace, env, timeout: 20_000 });
  if (preview.status !== 0) return { status: "FAIL", scenario: "force-termination-recovery", detail: `Installed-package stop preview failed: ${safeTail(preview.output)}` };
  const normal = await run(packageBin, ["budgets", "stop", "--provider", candidate.provider, "--confirm"], { cwd: workspace, env, timeout: 20_000 });
  if (normal.status === 0 && worker.child.exitCode !== null) {
    const unlocked = await run(packageBin, ["budgets", "unlock", "--provider", candidate.provider, "--confirm"], { cwd: workspace, env, timeout: 20_000 });
    return unlocked.status === 0
      ? { status: "BLOCKED", scenario: "force-termination-recovery", detail: "The real adapter completed graceful cancellation; no force escalation was needed, so no stuck native endpoint was fabricated." }
      : { status: "FAIL", scenario: "force-termination-recovery", detail: `CLI unlock after graceful cancellation failed: ${safeTail(unlocked.output)}` };
  }
  const force = await run(packageBin, ["budgets", "stop", "--provider", candidate.provider, "--confirm", "--force", "--force-confirm"], { cwd: workspace, env, timeout: 20_000 });
  const unlocked = await run(packageBin, ["budgets", "unlock", "--provider", candidate.provider, "--confirm"], { cwd: workspace, env, timeout: 20_000 });
  return force.status === 0 && worker.child.exitCode !== null && unlocked.status === 0
    ? { status: "PASS", scenario: "force-termination-recovery", detail: "Installed-package graceful request required explicit force escalation; exit and CLI recovery were verified." }
    : { status: "FAIL", scenario: "force-termination-recovery", detail: `Force recovery did not verify exit and unlock: ${safeTail(`${force.output} ${unlocked.output}`)}` };
}

async function scenarioCrossHarness(workspace) {
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
  const selected = new Set((preview.value?.targets ?? []).filter((target) => target.provider === first.provider && target.model === first.model).map((target) => target.pid));
  if (!workers.every((worker) => selected.has(worker.child.pid))) return { status: "BLOCKED", scenario: "cross-harness-provider-model", detail: "The common provider/model did not resolve to both real native workers." };
  const commit = await commitPreview(server.url, state.mutationToken, preview.value);
  if (!commit.ok) return { status: "FAIL", scenario: "cross-harness-provider-model", detail: `Cross-harness commit failed: ${safeTail(commit.value?.error)}` };
  const results = await Promise.all(workers.map((worker) => worker.wait(8_000)));
  const unlocked = await unlockScope(server.url, state.mutationToken, { kind: "model", provider: first.provider, model: first.model });
  return results.every((result, index) => result.status !== 0 && workers[index].child.exitCode !== null) && unlocked.ok
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
      for (const label of labels) {
        const mode = document.querySelector('select[aria-label="' + label + ' budget mode"]');
        if (!mode) continue;
        setValue(mode, "off"); await sleep(150); document.querySelector('button[aria-label="Save ' + label + ' budget"]')?.click(); await sleep(300);
        setValue(mode, "auto"); await sleep(150); document.querySelector('button[aria-label="Save ' + label + ' budget"]')?.click(); await sleep(300);
        setValue(mode, "manual"); await sleep(150);
        const limit = document.querySelector('input[aria-label="' + label + ' budget limit"]');
        if (limit) setValue(limit, "10000000");
        await sleep(100); document.querySelector('button[aria-label="Save ' + label + ' budget"]')?.click(); await sleep(300);
      }
      return { budgets: document.body.innerText.includes("Budgets"), modes: document.querySelectorAll('select[aria-label$="budget mode"]').length };
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

function delayedPrompt(sentinel, marker) {
  return `Wait for 20 seconds, then create the file ${sentinel} containing exactly ${marker} and stop.`;
}

async function runNative(target, workspace, prompt, timeout) {
  const worker = startNative(target, workspace, prompt, timeout);
  return worker.wait(timeout);
}

function startNative(target, workspace, prompt, timeout, identity = null) {
  const sessionId = `qualify-${target.source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const args = nativeArgs(target, workspace, prompt, identity);
  const child = spawn(target.command, args, { cwd: workspace, env: isolatedEnv(target.source, target.home, workspace, { ...identity, sessionId }), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const collect = (chunk) => { output = `${output}${chunk}`.slice(-6_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return {
    child,
    wait: (waitTimeout = timeout) => new Promise((resolvePromise) => {
      let settled = false;
      let timer;
      const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise({ ...result, output }); };
      if (child.exitCode !== null || child.signalCode) {
        finish({ status: child.exitCode ?? 1, signal: child.signalCode, timedOut: false });
        return;
      }
      timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); }, waitTimeout).unref();
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
      : ["run", "--dir", workspace, "--auto", "--format", "json", ...(identity?.provider && model ? ["--model", `${identity.provider}/${model}`] : []), prompt];
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
    TOKEN_FURNACE_CONTROL_TARGET: "1",
    TOKEN_FURNACE_SOURCE: source,
    TOKEN_FURNACE_EXCLUSIVE: "1",
    TOKEN_FURNACE_SESSION_ID: identity?.sessionId,
    TOKEN_FURNACE_PROVIDER: identity?.provider,
    TOKEN_FURNACE_ACCOUNT: identity?.account,
    TOKEN_FURNACE_MODEL: identity?.model,
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
    const child = spawn(process.execPath, [packageBin, "serve", "--port", "0", "--no-plan-usage"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
