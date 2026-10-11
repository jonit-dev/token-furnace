#!/usr/bin/env node
/**
 * Native qualification for PRD-030 budgets and emergency stops.
 *
 * Every side effect stays inside explicitly dedicated agent homes, a temporary workspace and a
 * temporary Token Furnace state. Real native CLIs run against real authenticated upstreams through
 * the installed package's hooks/plugins and managed hosts (`token-furnace native run`). A missing
 * capability or access is BLOCKED; a path that ran and produced the wrong result is FAIL. Only an
 * exercised and observed scenario is PASS. Nothing here injects decisions or pipes hook payloads.
 *
 * Environment (homes must be disposable, never the personal ~/.claude, ~/.codex or OpenCode data):
 *   TOKEN_FURNACE_QUALIFY_CLAUDE_HOME             Claude config dir with first-party login (.credentials.json)
 *   TOKEN_FURNACE_QUALIFY_CLAUDE_OPENROUTER_HOME  Claude config dir used with ANTHROPIC_BASE_URL=OpenRouter (shared-provider legs)
 *   TOKEN_FURNACE_QUALIFY_CODEX_HOME              CODEX_HOME with auth.json (+ an `openrouter` model provider for shared legs)
 *   TOKEN_FURNACE_QUALIFY_OPENCODE_HOME           HOME root whose .local/share/opencode/auth.json holds the logins
 *                                                 (legacy name: TOKEN_FURNACE_QUALIFY_OPENCODE_DATA_DIR, same meaning)
 *   TOKEN_FURNACE_QUALIFY_OPENROUTER_KEY_FILE     file holding the OpenRouter key (read privately, passed only via env)
 *   TOKEN_FURNACE_QUALIFY_BROWSER                 Chromium executable for the real Budgets tab
 *   TOKEN_FURNACE_QUALIFY_BIN                     use this built CLI instead of packing/installing the repository
 * Models (defaults in MODELS below): TOKEN_FURNACE_QUALIFY_SHARED_PROVIDER / _SHARED_MODEL,
 *   _CLAUDE_MODEL, _CLAUDE_CHILD_MODEL, _CLAUDE_CHILD_ALIAS, _CODEX_PROVIDER, _CODEX_MODEL, _CODEX_ALT_MODEL,
 *   _OPENCODE_MODEL, _OPENCODE_ALT_MODEL.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const supported = ["claude", "codex", "opencode"];
const env = process.env;
const MODELS = {
  sharedProvider: env.TOKEN_FURNACE_QUALIFY_SHARED_PROVIDER || "openrouter",
  sharedModel: env.TOKEN_FURNACE_QUALIFY_SHARED_MODEL || "nvidia/nemotron-3.5-lightning:free",
  claude: env.TOKEN_FURNACE_QUALIFY_CLAUDE_MODEL || "claude-haiku-5-5",
  claudeChild: env.TOKEN_FURNACE_QUALIFY_CLAUDE_CHILD_MODEL || "claude-sonnet-5-5",
  claudeAlias: "haiku",
  claudeChildAlias: env.TOKEN_FURNACE_QUALIFY_CLAUDE_CHILD_ALIAS || "sonnet",
  codexProvider: env.TOKEN_FURNACE_QUALIFY_CODEX_PROVIDER || "openai",
  codex: env.TOKEN_FURNACE_QUALIFY_CODEX_MODEL || "gpt-5.6-luna",
  codexAlt: env.TOKEN_FURNACE_QUALIFY_CODEX_ALT_MODEL || "gpt-5.6-terra",
  opencode: env.TOKEN_FURNACE_QUALIFY_OPENCODE_MODEL || "opencode-go/deepseek-v4.1-flash",
  opencodeAlt: env.TOKEN_FURNACE_QUALIFY_OPENCODE_ALT_MODEL || "opencode-go/glm-5.3-flash",
};
const QUALIFY_ADMISSION_FLOOR = 2_000_000;
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const temporary = [];
const children = new Set();
const state = { packageBin: env.TOKEN_FURNACE_QUALIFY_BIN || "", binDir: "", version: readPackageVersion(root), workspace: "", tf: null, server: null, lanes: {}, browser: null, setup: {} };

if (process.argv.includes("--self-test")) selfTest();
else await main();

async function main() {
  const requested = parseSources(process.argv.slice(2));
  try {
    const problems = await discover(requested);
    if (problems.length) {
      console.error("BLOCKED: native authenticated budget qualification did not run.");
      for (const problem of problems) console.error(`- ${problem}`);
      console.error(`No provider requests, native hook decisions, process cancellations, or PASS results were fabricated. Package identity: token-furnace@${state.version || "unknown"}.`);
      process.exitCode = 75;
      return;
    }
    const startedAt = Date.now();
    const results = await qualify(requested);
    console.log(`DURATION ${Math.round((Date.now() - startedAt) / 1000)}s`);
    process.exitCode = results.some((result) => result.status === "FAIL") ? 1 : results.some((result) => result.status === "BLOCKED") ? 75 : 0;
  } catch (error) {
    console.error(`qualification error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    for (const child of [...children]) await stopChild(child);
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ discovery

async function discover(requested) {
  const problems = [];
  if (!state.version) problems.push("package identity could not be read");
  if (!state.packageBin) installPackage();
  if (!existsSync(state.packageBin)) problems.push(`built package entrypoint is missing: ${state.packageBin}`);
  if (!existsSync(join(dirname(state.packageBin), "dashboard.html"))) problems.push("installed package has no dashboard.html");
  if (!state.binDir) {
    state.binDir = tempDir("token-furnace-bin-");
    try { symlinkSync(resolve(state.packageBin), join(state.binDir, "token-furnace")); }
    catch {
      writeFileSync(join(state.binDir, "token-furnace"), `#!/usr/bin/env node\nawait import(${JSON.stringify(`file://${resolve(state.packageBin)}`)});\n`);
      chmodSync(join(state.binDir, "token-furnace"), 0o700);
    }
  }
  console.log(`PACKAGE token-furnace@${state.version} ${state.packageBin}`);
  const keyFile = env.TOKEN_FURNACE_QUALIFY_OPENROUTER_KEY_FILE;
  const openRouterKey = keyFile && existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "";
  const homes = {
    claude: env.TOKEN_FURNACE_QUALIFY_CLAUDE_HOME,
    claudeShared: env.TOKEN_FURNACE_QUALIFY_CLAUDE_OPENROUTER_HOME,
    codex: env.TOKEN_FURNACE_QUALIFY_CODEX_HOME,
    opencode: env.TOKEN_FURNACE_QUALIFY_OPENCODE_HOME || env.TOKEN_FURNACE_QUALIFY_OPENCODE_DATA_DIR,
  };
  const check = (name, home, credential) => {
    if (!home) return `${name}: set its TOKEN_FURNACE_QUALIFY_* home to a disposable authenticated home`;
    if (!isAbsolute(home) || !existsSync(home)) return `${name}: home is missing or not absolute`;
    if (isPersonal(realpathOr(home))) return `${name}: home resolves to a personal agent home`;
    if (credential && !existsSync(join(home, credential))) return `${name}: dedicated credential ${credential} is missing`;
    return null;
  };
  for (const source of requested) {
    const credential = source === "claude" ? ".credentials.json" : source === "codex" ? "auth.json" : join(".local", "share", "opencode", "auth.json");
    const problem = check(source, homes[source], credential);
    if (problem) { problems.push(problem); continue; }
    // Claude Agent tool models are aliases; explicit alias mappings make the child model resolvable.
    const extra = source === "claude" ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: MODELS.claude, ANTHROPIC_DEFAULT_SONNET_MODEL: MODELS.claudeChild } : openRouterKey ? { OPENROUTER_API_KEY: openRouterKey } : {};
    const lane = makeLane(source, homes[source], extra);
    const version = spawnSync(source, ["--version"], { encoding: "utf8", env: lane.env(), timeout: 15_000 });
    if (version.error || version.status !== 0) { problems.push(`${source}: native executable could not be discovered`); continue; }
    lane.version = String(version.stdout || version.stderr).trim().split("\n")[0];
    console.log(`DISCOVERED ${source}: ${lane.version}`);
    state.lanes[source] = lane;
  }
  // The shared-provider Claude lane is optional: without it, Claude shared legs are BLOCKED, not skipped.
  if (requested.includes("claude") && !check("claude-openrouter", homes.claudeShared, null) && openRouterKey) {
    state.lanes.claudeShared = makeLane("claude", homes.claudeShared, {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: openRouterKey, ANTHROPIC_API_KEY: "",
      // OpenRouter non-Anthropic models reject deferred tool references.
      ENABLE_TOOL_SEARCH: "false",
      ANTHROPIC_DEFAULT_SONNET_MODEL: MODELS.sharedModel, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODELS.sharedModel, ANTHROPIC_DEFAULT_OPUS_MODEL: MODELS.sharedModel,
    });
  }
  state.browser = findBrowser();
  return problems;
}

function installPackage() {
  // Pack first: prepack builds dist, so the installed artifact is checked afterwards (not the worktree dist).
  const packRoot = tempDir("token-furnace-package-");
  const installRoot = tempDir("token-furnace-install-");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = spawnSync(npm, ["pack", "--pack-destination", packRoot], { cwd: root, encoding: "utf8", env, timeout: 300_000 });
  if (packed.error || packed.status !== 0) throw new Error(`npm pack failed: ${safeTail(packed.stderr || packed.stdout)}`);
  const tarball = readdirSync(packRoot).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not produce a tarball.");
  const installed = spawnSync(npm, ["install", "--ignore-scripts", "--no-package-lock", "--no-save", "--prefix", installRoot, join(packRoot, tarball)], { cwd: root, encoding: "utf8", env, timeout: 300_000 });
  if (installed.error || installed.status !== 0) throw new Error(`package install failed: ${safeTail(installed.stderr || installed.stdout)}`);
  state.packageBin = join(installRoot, "node_modules", "token-furnace", "dist", "cli.js");
  state.binDir = join(installRoot, "node_modules", ".bin");
}

function makeLane(source, home, extra) {
  return {
    source, home,
    env: (more = {}) => ({
      ...env,
      HOME: source === "opencode" ? home : env.HOME,
      CLAUDE_CONFIG_DIR: source === "claude" ? home : undefined,
      CODEX_HOME: source === "codex" ? home : undefined,
      XDG_CONFIG_HOME: source === "opencode" ? join(home, ".config") : env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: source === "opencode" ? join(home, ".local", "share") : env.XDG_DATA_HOME,
      XDG_STATE_HOME: source === "opencode" ? join(home, ".local", "state") : env.XDG_STATE_HOME,
      XDG_CACHE_HOME: source === "opencode" ? join(home, ".cache") : env.XDG_CACHE_HOME,
      ...(state.tf ?? {}),
      ...extra,
      ...more,
      PATH: `${state.binDir}:${env.PATH || ""}`,
    }),
  };
}

// ------------------------------------------------------------------ orchestration

async function qualify(requested) {
  state.workspace = tempDir("token-furnace-budget-qualify-");
  const shared = tempDir("token-furnace-budget-state-");
  state.tf = { TOKEN_FURNACE_CONFIG_HOME: join(shared, "config"), TOKEN_FURNACE_STATE_HOME: join(shared, "state"), TOKEN_FURNACE_CACHE_HOME: join(shared, "cache") };
  for (const path of Object.values(state.tf)) mkdirSync(path, { recursive: true });
  for (const [name, lane] of Object.entries(state.lanes)) {
    const install = await run(process.execPath, [state.packageBin, "budgets", "enable", "--confirm"], { cwd: state.workspace, env: lane.env(), timeout: 60_000 });
    state.setup[name] = install.status === 0 ? null : `adapter installation failed: ${safeTail(install.output)}`;
    console.log(`SETUP ${name}: ${state.setup[name] ?? "budgets enable --confirm installed native adapters"}`);
  }
  await startServer();
  const results = [];
  const mode = await scenarioModePolicy(requested);
  results.push(mode);
  for (const source of requested) results.push(await scenarioAdmission(source));
  const providerStop = await scenarioProviderStop(requested);
  for (const source of requested) {
    results.push(providerStop[source]);
    results.push(await scenarioModelStop(source));
    results.push(await scenarioForceRecovery(source));
  }
  results.push(requested.length >= 2 ? await scenarioCrossHarness(requested) : blocked("cross-harness-provider-model", "At least two requested native harnesses are required."));
  return results;
}

// Each result prints as soon as it is decided, so a long run shows progress.
function report(status, scenario, detail) { console.log(`${status} ${scenario}: ${detail}`); return { status, scenario, detail }; }
function pass(scenario, detail) { return report("PASS", scenario, detail); }
function fail(scenario, detail) { return report("FAIL", scenario, detail); }
function blocked(scenario, detail) { return report("BLOCKED", scenario, detail); }

// ------------------------------------------------------------------ 1. mode and policy

async function scenarioModePolicy(requested) {
  const id = "mode-and-policy-wiring";
  if (!state.browser) return blocked(id, "No Chromium browser was discovered (TOKEN_FURNACE_QUALIFY_BROWSER).");
  await resetPolicies();
  const lane = state.lanes[requested[0]];
  const offSentinel = artifact("mode-off");
  const off = await oneShot(lane, shellPrompt(`echo MODE_OFF > ${offSentinel}`), { model: defaultModel(lane.source) });
  if (unavailable(off)) return blocked(id, `Default-Off minimal ${lane.source} task was unavailable: ${safeTail(off.output)}`);
  if (!completed(off) || !existsSync(offSentinel) || !decision(lane.source, off.requestId, off.startedAt, true)) return fail(id, `Default-Off ${lane.source} task lacked its sentinel or correlated allow decision (${nativeSummary(off)}).`);
  // Exported/snapshot pages carry no mutation token, and a tokenless write is rejected without changes.
  const before = await budgetState();
  const page = await fetch(`${state.server.url}/dashboard.html`).then((response) => response.text()).catch(() => "");
  const tokenless = await fetch(`${state.server.url}/api/budgets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: before?.revision, policies: [] }) }).then((response) => response.status).catch(() => 0);
  const after = await budgetState();
  if (!before?.mutationToken || page.includes(before.mutationToken) || tokenless !== 403 || after?.revision !== before.revision) return fail(id, `Read-only protections failed: snapshotHasToken=${page.includes(before?.mutationToken ?? "\u0000")} tokenlessStatus=${tokenless} revisionChanged=${after?.revision !== before?.revision}.`);
  const browser = await driveBudgetsBrowser();
  if (!browser.ok) return browser.ran ? fail(id, browser.detail) : blocked(id, browser.detail);
  const saved = await budgetState();
  if (requested.some((source) => !hasManualPolicy(saved, source, 1000))) return fail(id, "Browser Manual policies were not all persisted with the selected limit.");
  await restartServer(true);
  const persisted = await budgetState();
  if (requested.some((source) => !hasManualPolicy(persisted, source, 1000))) return fail(id, "Manual browser policies did not survive a Token Furnace restart.");
  const autoProblems = requested.flatMap((source) => {
    const reading = browser.autoReadings.find((candidate) => candidate.source === source);
    const meter = reading?.meter;
    const observed = Date.parse(meter?.observedAt ?? "");
    const reset = Date.parse(meter?.resetAt ?? "");
    const used = Number(meter?.usedPercentagePoints);
    if (reading?.policy?.mode !== "auto" || !meter?.authoritative || !meter.account || !meter.window || !Number.isFinite(observed) || Date.now() - observed > 5 * 60_000) return [`${source}: no fresh authoritative account/window quota (${meter ? `authoritative=${meter.authoritative} account=${Boolean(meter.account)} window=${meter.window ?? "none"} observedAt=${meter.observedAt ?? "none"}` : "meter=null"})`];
    const expected = Math.max(0, 100 - used) / ((reset - observed) / 3_600_000);
    if (!Number.isFinite(expected) || Math.abs(Number(reading.allowance) - expected) > Math.max(0.01, expected * 0.02)) return [`${source}: Auto allowance ${reading.allowance} does not equal remaining/hours-to-reset ${expected.toFixed(3)}`];
    const kept = persisted?.sources?.find((candidate) => candidate.source === source)?.meter;
    if (!kept || kept.account !== meter.account || kept.window !== meter.window || kept.observedAt !== meter.observedAt) return [`${source}: restart did not preserve the quota snapshot identity/observation time`];
    return [];
  });
  if (autoProblems.length) return blocked(id, `UI Off/Auto/Manual saves, restart persistence, read-only protection and an Off ${lane.source} task passed, but Auto is not qualified: ${autoProblems.join("; ")}.`);
  return pass(id, `Real browser saved Off/Auto/Manual for ${requested.join(", ")}; Auto equals remaining/hours-to-reset from fresh authoritative meters; Manual and meter snapshots survived restart; tokenless/snapshot writes rejected; Off ${lane.source} task allowed.`);
}

// ------------------------------------------------------------------ 2-4. budget admission

async function scenarioAdmission(source) {
  const id = `budget-admission:${source}`;
  const lane = state.lanes[source];
  if (!lane || state.setup[source]) return blocked(id, state.setup[source] ?? "Native lane is unavailable.");
  await resetPolicies();
  if (!(await setSourcePolicy(source, admissionLimit(source))).ok) return fail(id, "Could not persist a positive Manual source budget through the API.");
  const child = artifact(`${source}-child`);
  const background = artifact(`${source}-background`);
  const eligible = await delegate(lane, child, background, "BUDGET_ELIGIBLE");
  if (unavailable(eligible.result)) return blocked(id, `Eligible ${source} delegation was unavailable: ${safeTail(eligible.result.output)}`);
  const allowed = decision(source, eligible.result.requestId, eligible.result.startedAt, true);
  const missing = [
    !completed(eligible.result) && `run=${nativeSummary(eligible.result)}`,
    !allowed && "no correlated allow decision",
    !eligible.children.length && "no native child evidence",
    !existsSync(child) && "child sentinel missing",
    eligible.background && !existsSync(background) && "background sentinel missing",
    !eligible.sessionId && "no native session id",
  ].filter(Boolean);
  if (missing.length) return fail(id, `Eligible delegation evidence failed: ${missing.join(", ")}.`);
  const resumeSentinel = artifact(`${source}-resume`);
  const resumed = await oneShot(lane, shellPrompt(`echo BUDGET_RESUMED > ${resumeSentinel}`), { resume: eligible.sessionId, model: defaultModel(source) });
  if (unavailable(resumed)) return blocked(id, `Native resume was unavailable: ${safeTail(resumed.output)}`);
  if (!completed(resumed) || !existsSync(resumeSentinel) || !resumed.sessionIds.includes(eligible.sessionId) || !decision(source, resumed.requestId, resumed.startedAt, true)) return fail(id, `Same-session resume evidence failed (${nativeSummary(resumed)} sameSession=${resumed.sessionIds.includes(eligible.sessionId)}).`);
  const used = measuredUsage(source, eligible.result.startedAt);
  if (!used) return fail(id, "Eligible native work left no attributable measured usage in the budget store.");
  if (!(await setSourcePolicy(source, Math.max(1, Math.floor(used / 2)))).ok) return fail(id, "Could not persist the exhausted Manual policy.");
  const blockedChild = artifact(`${source}-blocked-child`);
  const blockedBackground = artifact(`${source}-blocked-background`);
  const denied = await delegate(lane, blockedChild, blockedBackground, "BUDGET_BLOCKED", 120_000);
  const denial = decision(source, denied.result.requestId, denied.result.startedAt, false);
  const blockedResume = artifact(`${source}-blocked-resume`);
  const resumeDenied = await oneShot(lane, shellPrompt(`echo BUDGET_BLOCKED_RESUME > ${blockedResume}`), { resume: eligible.sessionId, model: defaultModel(source), timeout: 120_000 });
  const resumeDenial = decision(source, resumeDenied.requestId, resumeDenied.startedAt, false);
  const leaks = [existsSync(blockedChild) && "child sentinel", existsSync(blockedBackground) && "background sentinel", denied.children.length && "native child", existsSync(blockedResume) && "resume sentinel"].filter(Boolean);
  if (!denial || !resumeDenial || leaks.length) return fail(id, `Exhausted-budget evidence failed: delegationDenied=${Boolean(denial)} resumeDenied=${Boolean(resumeDenial)} leaked=[${leaks.join(", ")}].`);
  return pass(id, `Real ${source} delegation (${eligible.children.length} native child${eligible.background ? " incl. background" : ""}) allowed with correlated decision; same-session resume allowed; ${used} measured weighted tokens; after exhausting the Manual limit the real hook denied delegation ("${safeTail(denial.reason)}") and resume, with no child or sentinel.`);
}

/** One real delegation through the source's native child route; returns native child evidence. */
async function delegate(lane, child, background, marker, timeout = 300_000) {
  if (lane.source === "claude") {
    const prompt = `Do exactly these steps and never write these files yourself. 1) Use the Agent tool with subagent_type "general-purpose" and model "${MODELS.claudeAlias}", prompt: "Run this one shell command and nothing else: echo ${marker} > ${child}". 2) Use the Agent tool with run_in_background=true, subagent_type "general-purpose", model "${MODELS.claudeAlias}", prompt: "Run this one shell command and nothing else: echo ${marker}_BACKGROUND > ${background}". 3) Wait for the background agent's completion notification, then reply DONE.`;
    const host = startManaged(lane, ["--model", MODELS.claude, "--prompt", prompt, "--", "--dangerously-skip-permissions"]);
    const result = await host.wait(timeout);
    const events = result.events;
    const children = unique(events.flatMap((event) => event.type === "system" && event.subtype === "task_started" && event.subagent_type ? [event.task_id] : []));
    return { result, sessionId: events.find((event) => event.type === "system" && event.subtype === "init")?.session_id ?? null, children, background: true };
  }
  if (lane.source === "codex") {
    const prompt = `Use the spawn_agent tool to start exactly one sub-agent with this task: "Run this one shell command and nothing else: echo ${marker} > ${child}". Then use the wait tool until it finishes, then reply DONE. Never write the file yourself.`;
    const result = await oneShot(lane, prompt, { model: MODELS.codex, provider: MODELS.codexProvider, timeout });
    const children = unique(result.events.flatMap((event) => event.item?.type === "collab_tool_call" && event.item.tool === "spawn_agent" ? event.item.receiver_thread_ids ?? [] : []));
    return { result, sessionId: result.sessionIds[0] ?? null, children, background: false };
  }
  const prompt = `Use the task tool to delegate this job to a general subagent: "Run this one shell command and nothing else: echo ${marker} > ${child}". Never write the file yourself. Then reply DONE.`;
  const result = await oneShot(lane, prompt, { model: MODELS.opencode, timeout });
  const children = unique(result.events.flatMap((event) => {
    const metadata = event.part?.tool === "task" ? event.part.state?.metadata : null;
    return metadata?.sessionId && metadata.sessionId !== metadata.parentSessionId ? [metadata.sessionId] : [];
  }));
  return { result, sessionId: result.sessionIds[0] ?? null, children, background: false };
}

// ------------------------------------------------------------------ 5,8,11. provider stop (one shared run)

async function scenarioProviderStop(requested) {
  const ids = Object.fromEntries(requested.map((source) => [source, `provider-stop:${source}`]));
  const all = (make) => Object.fromEntries(requested.map((source) => [source, make(ids[source], source)]));
  const provider = MODELS.sharedProvider;
  if (!state.browser) return all((id) => blocked(id, "No Chromium browser for the real UI stop confirmation."));
  const lanes = sharedLanes(requested);
  const missing = requested.filter((source) => !lanes[source]);
  if (Object.keys(lanes).length < 2) return all((id) => blocked(id, `Fewer than two harnesses can reach the shared upstream ${provider} (missing: ${missing.join(", ")}).`));
  await permissivePolicies();
  const run = await startProviderWorkers(lanes, provider);
  try {
    const ready = await run.ready();
    if (!ready.ok) return all((id, source) => (lanes[source] ? (ready.unavailable ? blocked : fail)(id, ready.detail) : blocked(id, `${source} cannot reach ${provider}.`)));
    const preview = await stopPreview({ kind: "provider", provider });
    const unmatched = run.matching.filter((worker) => !preview?.targets?.some((target) => worker.matches(target)));
    if (unmatched.length) return all((id) => fail(id, `Stop preview omitted matching workers: ${unmatched.map((worker) => worker.label).join(", ")}.`));
    const operationStart = Date.now();
    const ui = await driveStopBrowser(`button[aria-label="Stop upstream provider ${provider} in all harnesses"]`, provider);
    if (!ui.ok) return all((id) => (ui.ran ? fail : blocked)(id, ui.detail));
    const operation = await latestOperation({ kind: "provider", provider }, operationStart);
    await run.releaseControls();
    const ceased = await run.matchingCeased();
    const controls = await run.controlsAdvanced();
    await restartServer(true);
    const latched = (await budgetState())?.stops?.some((stop) => sameScope(stop.scope, { kind: "provider", provider }));
    const fresh = {};
    for (const source of Object.keys(lanes)) fresh[source] = await freshDenied(lanes[source], source, sharedModelFor(source), provider);
    const unlocked = await unlock({ kind: "provider", provider });
    const recovered = {};
    for (const source of Object.keys(lanes)) recovered[source] = await freshAllowed(lanes[source], source, sharedModelFor(source));
    return all((id, source) => {
      if (!lanes[source]) return blocked(id, `${source} cannot reach the shared upstream ${provider}.`);
      const worker = run.matching.find((candidate) => candidate.source === source);
      const outcome = operation?.outcomes?.find((candidate) => worker.matches({ id: candidate.targetId }));
      const problems = [
        !operation && "no stop operation",
        !["cancelled", "terminated"].includes(outcome?.status) && `outcome=${outcome?.status ?? "missing"}`,
        !ceased[source] && "matching native work did not reach a terminal state",
        !controls.ok && `unrelated controls did not advance (${controls.detail})`,
        !latched && "latch missing after restart",
        !fresh[source].ok && `fresh launch not denied (${fresh[source].detail})`,
        !unlocked && "unlock failed",
        !recovered[source].ok && `post-unlock task not allowed (${recovered[source].detail})`,
      ].filter(Boolean);
      if (problems.length) return (fresh[source].unavailable || recovered[source].unavailable ? blocked : fail)(id, `Provider ${provider} stop: ${problems.join("; ")}.`);
      return pass(id, `UI Stop provider ${provider} across ${Object.keys(lanes).join("+")}: ${source} worker ${outcome.status} (${ceased[source]}); unrelated ${controls.detail}; latch survived restart; fresh ${source} launch denied; unlock allowed a fresh task.`);
    });
  } finally {
    await run.stop();
  }
}

async function startProviderWorkers(lanes, provider) {
  const matching = [];
  const controls = [];
  let host = null;
  for (const [source, lane] of Object.entries(lanes)) {
    const barrier = artifact(`${source}-provider-barrier`);
    const sentinel = artifact(`${source}-provider-match`);
    if (source === "claude") matching.push(managedWorker(lane, "claude", `claude/${provider}`, ["--model", MODELS.sharedModel, "--prompt", shellPrompt(gated(barrier, `echo PROVIDER_MATCH > ${sentinel}`)), "--", "--dangerously-skip-permissions"], { sentinel, barrier, provider }));
    else if (source === "codex") {
      const controlSentinel = artifact("codex-provider-control");
      const controlBarrier = artifact("codex-provider-control-barrier");
      const worker = managedWorker(lane, "codex", `codex/${provider}`, ["--provider", provider, "--model", MODELS.sharedModel, "--prompt", shellPrompt(gated(barrier, `echo PROVIDER_MATCH > ${sentinel}`)),
        "--thread-provider", MODELS.codexProvider, "--thread-model", MODELS.codex, "--thread-prompt", shellPrompt(gated(controlBarrier, `echo PROVIDER_CONTROL > ${controlSentinel}`)), ...codexHostArgs()], { sentinel, barrier, provider });
      matching.push(worker);
      controls.push({ label: `codex/${MODELS.codexProvider} thread in the same app-server`, sentinel: controlSentinel, barrier: controlBarrier, worker: worker.view({ provider: MODELS.codexProvider, model: MODELS.codex }, "codex control thread") });
    } else {
      host ??= await startOpenCodeHost(lane);
      if (!host) return { ready: async () => ({ ok: false, unavailable: true, detail: "opencode serve did not start." }), matching, stop: async () => {} };
      matching.push(openCodeWorker(lane, host, `opencode/${provider}`, `${provider}/${MODELS.sharedModel}`, shellPrompt(gated(barrier, `echo PROVIDER_MATCH > ${sentinel}`)), { sentinel, barrier, provider }));
      const controlSentinel = artifact("opencode-provider-control");
      const controlBarrier = artifact("opencode-provider-control-barrier");
      controls.push({ label: `opencode ${MODELS.opencode} session in the same server`, sentinel: controlSentinel, barrier: controlBarrier, worker: openCodeWorker(lane, host, "opencode/control", MODELS.opencode, shellPrompt(gated(controlBarrier, `echo PROVIDER_CONTROL > ${controlSentinel}`)), { provider: MODELS.opencode.split("/")[0] }) });
    }
  }
  if (state.lanes.claude) {
    const controlSentinel = artifact("claude-provider-control");
    const controlBarrier = artifact("claude-provider-control-barrier");
    controls.push({ label: "claude first-party session", sentinel: controlSentinel, barrier: controlBarrier, worker: managedWorker(state.lanes.claude, "claude", "claude/anthropic", ["--model", MODELS.claude, "--prompt", shellPrompt(gated(controlBarrier, `echo PROVIDER_CONTROL > ${controlSentinel}`)), "--", "--dangerously-skip-permissions"], { provider: "anthropic" }) });
  }
  const everyone = [...matching, ...controls.map((control) => control.worker)];
  return {
    matching,
    ready: async () => {
      const ok = await waitFor(() => everyone.every((worker) => worker.registered() || worker.exited()), 240_000);
      const missingWorkers = everyone.filter((worker) => !worker.registered());
      if (!ok || missingWorkers.length) {
        const exited = missingWorkers.filter((worker) => worker.exited());
        return { ok: false, unavailable: exited.some((worker) => unavailable(worker.result())), detail: `Workers never registered a running native target with the expected provider: ${missingWorkers.map((worker) => `${worker.label}(${worker.exited() ? nativeSummary(worker.result()) : "running"})`).join(", ")}.` };
      }
      return { ok: true };
    },
    releaseControls: async () => { for (const control of controls) release(control.barrier); },
    matchingCeased: async () => {
      const out = {};
      for (const worker of matching) out[worker.source] = await worker.ceased();
      return out;
    },
    controlsAdvanced: async () => {
      const ok = await waitFor(() => controls.every((control) => existsSync(control.sentinel)), 180_000);
      const stuck = controls.filter((control) => !existsSync(control.sentinel)).map((control) => control.label);
      return { ok: ok && controls.length > 0 && !stuck.length && matching.every((worker) => !existsSync(worker.sentinel)), detail: controls.length ? (stuck.length ? `stuck: ${stuck.join(", ")}` : `${controls.map((control) => control.label).join(", ")} wrote post-stop sentinels; matching sentinels absent`) : "no unrelated control available" };
    },
    stop: async () => { for (const worker of everyone) await worker.stop(); if (host) await stopChild(host.child); },
  };
}

// ------------------------------------------------------------------ 6,9,12. model stop

async function scenarioModelStop(source) {
  const id = `model-stop:${source}`;
  const lane = state.lanes[source];
  if (!lane || state.setup[source]) return blocked(id, state.setup[source] ?? "Native lane is unavailable.");
  if (!state.browser) return blocked(id, "No Chromium browser for the real UI stop confirmation.");
  await permissivePolicies();
  const targetBarrier = artifact(`${source}-model-target-barrier`);
  const targetSentinel = artifact(`${source}-model-target`);
  const keepBarrier = artifact(`${source}-model-keep-barrier`);
  const keepSentinel = artifact(`${source}-model-keep-post`);
  let host = null;
  let target;
  let keep;
  try {
    if (source === "claude") {
      const prompt = `Do exactly these steps. 1) Use the Agent tool once with run_in_background=true, subagent_type "general-purpose", model "${MODELS.claudeChildAlias}", prompt: "Run this one shell command and nothing else: ${gated(targetBarrier, `echo MODEL_TARGET > ${targetSentinel}`)}". 2) Without waiting for it, use the Bash tool to run this one command: ${gated(keepBarrier, `echo MODEL_OTHER_POST > ${keepSentinel}`)} 3) Reply DONE.`;
      const worker = managedWorker(lane, "claude", "claude host", ["--model", MODELS.claude, "--prompt", prompt, "--", "--dangerously-skip-permissions"], { provider: "anthropic" });
      target = worker.view({ provider: "anthropic", task: true }, "claude child task");
      keep = worker;
    } else if (source === "codex") {
      const worker = managedWorker(lane, "codex", "codex host", ["--provider", MODELS.codexProvider, "--model", MODELS.codexAlt, "--prompt", shellPrompt(gated(targetBarrier, `echo MODEL_TARGET > ${targetSentinel}`)),
        "--thread-provider", MODELS.codexProvider, "--thread-model", MODELS.codex, "--thread-prompt", shellPrompt(gated(keepBarrier, `echo MODEL_OTHER_POST > ${keepSentinel}`)), ...codexHostArgs()], { provider: MODELS.codexProvider, model: MODELS.codexAlt });
      target = worker;
      keep = worker.view({ provider: MODELS.codexProvider, model: MODELS.codex }, "codex other thread");
    } else {
      host = await startOpenCodeHost(lane);
      if (!host) return blocked(id, "opencode serve did not start.");
      target = openCodeWorker(lane, host, "opencode target", MODELS.opencode, shellPrompt(gated(targetBarrier, `echo MODEL_TARGET > ${targetSentinel}`)), {});
      keep = openCodeWorker(lane, host, "opencode other", MODELS.opencodeAlt, shellPrompt(gated(keepBarrier, `echo MODEL_OTHER_POST > ${keepSentinel}`)), {});
    }
    const registered = await waitFor(() => target.registered() && keep.registered(), 240_000);
    if (!registered) return (target.exited() && unavailable(target.result()) ? blocked : fail)(id, `Mixed-model workers did not register native targets with resolved models (target=${target.registered()} other=${keep.registered()}; ${nativeSummary(target.result?.() ?? {})}).`);
    const identity = target.identity();
    const other = keep.identity();
    if (!identity?.model || !other?.model || identity.model === other.model || identity.pid !== other.pid && source !== "opencode") return fail(id, `Expected two different models in one native host; got ${JSON.stringify(identity)} vs ${JSON.stringify(other)}.`);
    const scope = { kind: "model", provider: identity.provider, model: identity.model };
    const preview = await stopPreview(scope);
    if (!preview?.targets?.some((candidate) => target.matches(candidate)) || preview.targets.some((candidate) => keep.matches(candidate) && candidate.id !== identity.id)) return fail(id, "Model stop preview did not isolate the target model's native work.");
    const operationStart = Date.now();
    const ui = await driveStopBrowser(`button[aria-label="Stop model ${identity.provider}/${identity.model}"]`, identity.model);
    if (!ui.ok) return (ui.ran ? fail : blocked)(id, ui.detail);
    const operation = await latestOperation(scope, operationStart);
    const outcome = operation?.outcomes?.find((candidate) => target.matches({ id: candidate.targetId }));
    release(keepBarrier);
    const ceased = await target.ceased();
    const otherAdvanced = await waitFor(() => existsSync(keepSentinel), 180_000);
    if (!["cancelled", "terminated"].includes(outcome?.status) || !ceased || !otherAdvanced || existsSync(targetSentinel)) return fail(id, `Selective model stop failed: outcome=${outcome?.status ?? "missing"} targetCeased=${ceased} otherPostSentinel=${otherAdvanced} targetSentinel=${existsSync(targetSentinel)}.`);
    await keep.wait?.(180_000);
    await restartServer(true);
    const latched = (await budgetState())?.stops?.some((stop) => sameScope(stop.scope, scope));
    const bypass = await modelBypassAttempts(source, lane, identity, other, keep);
    const unlocked = await unlock(scope);
    const recovered = await freshAllowed(lane, source, source === "claude" ? MODELS.claudeChild : source === "codex" ? MODELS.codexAlt : MODELS.opencode, source === "codex" ? MODELS.codexProvider : undefined);
    const problems = [!latched && "latch missing after restart", ...bypass.filter((attempt) => !attempt.ok).map((attempt) => `${attempt.name} not denied (${attempt.detail})`), !unlocked && "unlock failed", !recovered.ok && `recovered task not allowed (${recovered.detail})`].filter(Boolean);
    if (problems.length) return (bypass.some((attempt) => attempt.unavailable) || recovered.unavailable ? blocked : fail)(id, `Model ${scope.provider}/${scope.model}: ${problems.join("; ")}.`);
    return pass(id, `One ${source} host ran ${identity.model} and ${other.model}; UI Stop model ${scope.provider}/${scope.model} → ${outcome.status} (${ceased}); ${other.model} wrote a post-stop sentinel; latch survived restart; ${bypass.map((attempt) => attempt.name).join("/")} bypasses denied; unlock allowed a fresh ${scope.model} task.`);
  } finally {
    for (const worker of [target, keep]) await worker?.stop?.();
    if (host) await stopChild(host.child);
  }
}

async function modelBypassAttempts(source, lane, identity, other, keep) {
  const attempts = [];
  const attempt = async (name, options, prompt) => {
    const sentinel = artifact(`${source}-bypass-${name}`);
    const result = await oneShot(lane, prompt(sentinel), { ...options, timeout: 150_000 });
    const denied = decision(source, result.requestId, result.startedAt, false);
    attempts.push({ name, ok: Boolean(denied) && !existsSync(sentinel), unavailable: unavailable(result) && !denied, detail: `denyDecision=${Boolean(denied)} sentinel=${existsSync(sentinel)} ${nativeSummary(result)}` });
  };
  if (source === "claude") {
    const sessionId = keep.sessionId();
    await attempt("resume-delegation", { resume: sessionId, model: MODELS.claude }, (file) => `Use the Agent tool with subagent_type "general-purpose" and model "${MODELS.claudeChildAlias}", prompt: "Run this one shell command: echo BYPASS > ${file}". Never write the file yourself.`);
    await attempt("alias", { model: MODELS.claudeChildAlias }, (file) => shellPrompt(`echo BYPASS > ${file}`));
    await attempt("model-switch", { resume: sessionId, model: MODELS.claudeChild }, (file) => shellPrompt(`echo BYPASS > ${file}`));
  } else if (source === "codex") {
    await attempt("resume", { resume: identity.sessionId }, (file) => shellPrompt(`echo BYPASS > ${file}`));
    await attempt("model-switch", { resume: other.sessionId, model: identity.model, provider: identity.provider }, (file) => shellPrompt(`echo BYPASS > ${file}`));
    await attempt("fresh", { model: identity.model, provider: identity.provider }, (file) => shellPrompt(`echo BYPASS > ${file}`));
  } else {
    await attempt("resume", { resume: identity.sessionId, model: `${identity.provider}/${identity.model}` }, (file) => shellPrompt(`echo BYPASS > ${file}`));
    await attempt("model-switch", { resume: other.sessionId, model: `${identity.provider}/${identity.model}` }, (file) => shellPrompt(`echo BYPASS > ${file}`));
    await attempt("fresh", { model: `${identity.provider}/${identity.model}` }, (file) => shellPrompt(`echo BYPASS > ${file}`));
  }
  return attempts;
}

// ------------------------------------------------------------------ 7,10,13. CLI stop / force / recovery

async function scenarioForceRecovery(source) {
  const id = `force-termination-recovery:${source}`;
  const provider = MODELS.sharedProvider;
  const lanes = sharedLanes([source]);
  const lane = lanes[source];
  if (!lane) return blocked(id, `${source} has no lane on the shared upstream ${provider} for a dedicated target.`);
  await permissivePolicies();
  const barrier = artifact(`${source}-force-barrier`);
  const sentinel = artifact(`${source}-force-target`);
  const controlBarrier = artifact(`${source}-force-control-barrier`);
  const controlSentinel = artifact(`${source}-force-control`);
  let host = null;
  let target;
  let control;
  try {
    if (source === "claude") {
      target = managedWorker(lane, "claude", "claude/openrouter", ["--model", MODELS.sharedModel, "--prompt", shellPrompt(gated(barrier, `echo FORCE_STOP > ${sentinel}`)), "--", "--dangerously-skip-permissions"], { provider });
      control = state.lanes.claude ? managedWorker(state.lanes.claude, "claude", "claude/anthropic", ["--model", MODELS.claude, "--prompt", shellPrompt(gated(controlBarrier, `echo FORCE_CONTROL > ${controlSentinel}`)), "--", "--dangerously-skip-permissions"], { provider: "anthropic" }) : null;
    } else if (source === "codex") {
      target = managedWorker(lane, "codex", "codex host", ["--provider", provider, "--model", MODELS.sharedModel, "--prompt", shellPrompt(gated(barrier, `echo FORCE_STOP > ${sentinel}`)),
        "--thread-provider", MODELS.codexProvider, "--thread-model", MODELS.codex, "--thread-prompt", shellPrompt(gated(controlBarrier, `echo FORCE_CONTROL > ${controlSentinel}`)), ...codexHostArgs()], { provider });
      control = target.view({ provider: MODELS.codexProvider, model: MODELS.codex }, "codex control thread");
    } else {
      host = await startOpenCodeHost(lane);
      if (!host) return blocked(id, "opencode serve did not start.");
      target = openCodeWorker(lane, host, "opencode/openrouter", `${provider}/${MODELS.sharedModel}`, shellPrompt(gated(barrier, `echo FORCE_STOP > ${sentinel}`)), { provider });
      control = openCodeWorker(lane, host, "opencode/control", MODELS.opencode, shellPrompt(gated(controlBarrier, `echo FORCE_CONTROL > ${controlSentinel}`)), {});
    }
    if (!control) return blocked(id, "No unrelated real upstream control is available for collateral verification.");
    if (!(await waitFor(() => target.registered() && control.registered(), 240_000))) return (target.exited() && unavailable(target.result()) ? blocked : fail)(id, `Dedicated workers did not register (target=${target.registered()} control=${control.registered()}).`);
    const cli = (...args) => run(process.execPath, [state.packageBin, "budgets", ...args], { cwd: state.workspace, env: state.lanes[source].env(), timeout: 120_000 });
    const preview = await cli("stop", "--provider", provider);
    const previewJson = jsonOutput(preview.output);
    if (preview.status !== 0 || !previewJson?.targets?.some((candidate) => target.matches(candidate))) return fail(id, `CLI preview did not list the dedicated target (exit ${preview.status}).`);
    let stop = await cli("stop", "--provider", provider, "--confirm");
    let operation = jsonOutput(stop.output);
    let ceased = await target.ceased();
    let forced = false;
    if (!ceased) {
      if (operation?.status !== "partial") return fail(id, `Graceful CLI stop neither stopped the target nor reported partial (status=${operation?.status}).`);
      stop = await cli("stop", "--provider", provider, "--confirm", "--force", "--force-confirm");
      operation = jsonOutput(stop.output);
      ceased = await target.ceased();
      forced = true;
    }
    const outcome = operation?.outcomes?.find((candidate) => target.matches({ id: candidate.targetId }));
    release(controlBarrier);
    const controlAdvanced = await waitFor(() => existsSync(controlSentinel), 180_000);
    const fresh = await freshDenied(lane, source, sharedModelFor(source), provider);
    const unlocked = await cli("unlock", "--provider", provider, "--confirm");
    const recovered = await freshAllowed(lane, source, sharedModelFor(source));
    const problems = [
      operation?.status !== "complete" && `operation=${operation?.status}`,
      !["cancelled", "terminated"].includes(outcome?.status) && `outcome=${outcome?.status ?? "missing"}`,
      !ceased && "target did not cease",
      existsSync(sentinel) && "target sentinel written",
      !controlAdvanced && "unrelated control did not advance",
      !fresh.ok && `fresh launch not denied (${fresh.detail})`,
      unlocked.status !== 0 && "CLI unlock failed",
      !recovered.ok && `recovered task not allowed (${recovered.detail})`,
    ].filter(Boolean);
    if (problems.length) return (fresh.unavailable || recovered.unavailable ? blocked : fail)(id, `CLI provider stop: ${problems.join("; ")}.`);
    return pass(id, `Installed CLI preview/confirm${forced ? " plus separately confirmed --force" : " (native cancellation sufficed; force not required)"} → ${outcome.status} (${ceased}); unrelated control advanced; fresh launch denied; CLI unlock allowed a fresh task.`);
  } finally {
    for (const worker of new Set([target, control])) await worker?.stop?.();
    if (host) await stopChild(host.child);
  }
}

// ------------------------------------------------------------------ 14. cross-harness model stop

async function scenarioCrossHarness(requested) {
  const id = "cross-harness-provider-model";
  if (!state.browser) return blocked(id, "No Chromium browser for the real UI stop confirmation.");
  const lanes = sharedLanes(requested);
  if (Object.keys(lanes).length < 2) return blocked(id, `Fewer than two harnesses reach ${MODELS.sharedProvider}/${MODELS.sharedModel}.`);
  await permissivePolicies();
  const scope = { kind: "model", provider: MODELS.sharedProvider, model: MODELS.sharedModel };
  const workers = [];
  let host = null;
  try {
    for (const [source, lane] of Object.entries(lanes)) {
      const barrier = artifact(`${source}-cross-barrier`);
      const sentinel = artifact(`${source}-cross`);
      const prompt = shellPrompt(gated(barrier, `echo CROSS_HARNESS > ${sentinel}`));
      if (source === "claude") workers.push(managedWorker(lane, "claude", "claude", ["--model", MODELS.sharedModel, "--prompt", prompt, "--", "--dangerously-skip-permissions"], { sentinel, provider: scope.provider }));
      else if (source === "codex") workers.push(managedWorker(lane, "codex", "codex", ["--provider", scope.provider, "--model", scope.model, "--prompt", prompt, ...codexHostArgs()], { sentinel, provider: scope.provider }));
      else {
        host = await startOpenCodeHost(lane);
        if (host) workers.push(openCodeWorker(lane, host, "opencode", `${scope.provider}/${scope.model}`, prompt, { sentinel, provider: scope.provider }));
      }
    }
    if (!(await waitFor(() => workers.every((worker) => worker.registered() || worker.exited()), 240_000)) || workers.some((worker) => !worker.registered())) {
      return fail(id, `Workers did not register ${scope.provider}/${scope.model}: ${workers.filter((worker) => !worker.registered()).map((worker) => `${worker.label}(${worker.exited() ? nativeSummary(worker.result()) : "running"})`).join(", ")}.`);
    }
    const preview = await stopPreview(scope);
    if (workers.some((worker) => !preview?.targets?.some((target) => worker.matches(target)))) return fail(id, "Model stop preview did not include every harness's matching worker.");
    const operationStart = Date.now();
    const ui = await driveStopBrowser(`button[aria-label="Stop model ${scope.provider}/${scope.model}"]`, scope.model);
    if (!ui.ok) return (ui.ran ? fail : blocked)(id, ui.detail);
    const operation = await latestOperation(scope, operationStart);
    const statuses = workers.map((worker) => operation?.outcomes?.find((candidate) => worker.matches({ id: candidate.targetId }))?.status ?? "missing");
    const ceased = [];
    for (const worker of workers) ceased.push(await worker.ceased());
    await restartServer(true);
    const unlocked = await unlock(scope);
    const recovered = [];
    for (const source of Object.keys(lanes)) recovered.push(await freshAllowed(lanes[source], source, sharedModelFor(source)));
    const problems = [
      statuses.some((status) => !["cancelled", "terminated"].includes(status)) && `outcomes=${statuses.join(",")}`,
      ceased.some((value) => !value) && "a worker did not cease",
      workers.some((worker) => existsSync(worker.sentinel)) && "a stopped worker wrote its sentinel",
      !unlocked && "unlock failed",
      recovered.some((value) => !value.ok) && `recovery not allowed (${recovered.filter((value) => !value.ok).map((value) => value.detail).join("; ")})`,
    ].filter(Boolean);
    if (problems.length) return fail(id, `Cross-harness model stop: ${problems.join("; ")}.`);
    return pass(id, `UI Stop model ${scope.provider}/${scope.model} stopped ${workers.map((worker, index) => `${worker.label}=${statuses[index]}`).join(", ")} in one operation; unlock allowed fresh tasks in every harness.`);
  } finally {
    for (const worker of workers) await worker.stop();
    if (host) await stopChild(host.child);
  }
}

// ------------------------------------------------------------------ workers

function sharedLanes(sources) {
  const out = {};
  for (const source of sources) {
    if (source === "claude" && state.lanes.claudeShared && !state.setup.claudeShared) out.claude = state.lanes.claudeShared;
    if (source === "codex" && state.lanes.codex && !state.setup.codex && env.TOKEN_FURNACE_QUALIFY_OPENROUTER_KEY_FILE) out.codex = state.lanes.codex;
    if (source === "opencode" && state.lanes.opencode && !state.setup.opencode) out.opencode = state.lanes.opencode;
  }
  return out;
}

function sharedModelFor(source) {
  return source === "opencode" ? `${MODELS.sharedProvider}/${MODELS.sharedModel}` : MODELS.sharedModel;
}

function codexHostArgs() {
  return ["--", "-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"'];
}

function defaultModel(source) {
  return source === "claude" ? MODELS.claude : source === "codex" ? MODELS.codex : MODELS.opencode;
}

/** A `token-furnace native run` host; registration evidence comes from its own registered events. */
function managedWorker(lane, source, label, args, expect) {
  const requestId = newRequestId(source);
  const process_ = streamProcess(process.execPath, [state.packageBin, "native", "run", "--source", source, "--cwd", state.workspace, ...args], lane.env({ TOKEN_FURNACE_QUALIFY_REQUEST_ID: requestId }));
  const registrations = () => {
    const latest = new Map();
    for (const event of process_.events()) if (event.type === "token_furnace" && event.event === "registered") latest.set(event.targetId, event);
    return [...latest.values()];
  };
  const finished = () => new Set(process_.events().filter((event) => event.type === "token_furnace" && /finished$/.test(event.event ?? "")).map((event) => event.targetId));
  // A view selects one registered target of the host (a Codex thread or a Claude task) by its identity.
  const view = (filter, viewLabel) => {
    const pick = () => registrations().find((event) => filter.task === event.targetId.includes(":task:")
      && (!filter.provider || event.provider === filter.provider) && (!filter.model || event.model === filter.model)
      && Boolean(event.model) && (source !== "codex" || Boolean(event.native?.turnId)));
    return {
      source, label: viewLabel, sentinel: filter.sentinel, barrier: filter.barrier, requestId,
      registered: () => Boolean(pick()),
      identity: () => { const event = pick(); return event && { id: event.targetId, provider: event.provider, model: event.model, sessionId: event.sessionId, pid: event.pid }; },
      matches: (target) => Boolean(pick()) && pick().targetId === target.id,
      sessionId: () => process_.events().find((event) => event.type === "system" && event.subtype === "init")?.session_id ?? pick()?.sessionId ?? null,
      exited: () => process_.exited(),
      result: () => process_.result(),
      wait: (timeout) => process_.wait(timeout),
      // Terminal evidence is native: a finished turn/task event, a stopped task notification, or the host exiting.
      ceased: async () => {
        const id = pick()?.targetId;
        const taskStopped = () => filter.task && process_.events().some((event) => event.type === "system" && event.subtype === "task_notification" && id?.endsWith(`:task:${event.task_id}`) && event.status === "stopped");
        const ok = await waitFor(() => (id && finished().has(id)) || taskStopped() || process_.exited(), 30_000);
        return ok ? (taskStopped() ? "native task_notification stopped" : id && finished().has(id) ? "native terminal event" : "native host exited") : false;
      },
      view: (more, moreLabel) => view({ task: false, ...more }, moreLabel),
      stop: () => process_.stop(),
    };
  };
  return view({ task: false, ...expect }, label);
}

/** An OpenCode session attached to a shared `opencode serve`; ownership is the plugin's registration. */
function openCodeWorker(lane, host, label, model, prompt, expect) {
  const requestId = newRequestId("opencode");
  const process_ = streamProcess("opencode", ["run", "--attach", host.url, "--dir", state.workspace, "--auto", "--format", "json", "--model", model, prompt], lane.env({ TOKEN_FURNACE_QUALIFY_REQUEST_ID: requestId }));
  const sessionId = () => process_.events().find((event) => typeof event.sessionID === "string")?.sessionID ?? null;
  const row = () => {
    const id = sessionId();
    if (!id) return null;
    return controlTargets().find((target) => target.source === "opencode" && target.session_id === id && target.model) ?? null;
  };
  return {
    source: "opencode", label, sentinel: expect.sentinel, barrier: expect.barrier, requestId,
    registered: () => Boolean(row()),
    identity: () => { const target = row(); return target && { id: target.id, provider: target.provider, model: target.model, sessionId: target.session_id, pid: target.pid }; },
    matches: (target) => Boolean(row()) && (target.id === row().id || target.sessionId === sessionId()),
    exited: () => process_.exited(),
    result: () => process_.result(),
    wait: (timeout) => process_.wait(timeout),
    // Native terminal evidence: the server reports the session no longer busy.
    ceased: async () => {
      const id = sessionId();
      const idle = async () => {
        const statuses = await fetch(`${host.url}/session/status`).then((response) => response.json()).catch(() => null);
        return statuses && statuses[id]?.type !== "busy";
      };
      return (await waitFor(idle, 30_000)) ? "opencode session not busy (aborted)" : false;
    },
    stop: () => process_.stop(),
  };
}

async function startOpenCodeHost(lane) {
  const child = streamProcess("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], lane.env());
  const started = await waitFor(() => /https?:\/\/127\.0\.0\.1:\d+/.test(child.output()), 30_000);
  const url = child.output().match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!started || !url) { await child.stop(); return null; }
  return { child: child.child, url };
}

/** One-shot native CLI run (fresh or resumed) with correlated request id. */
async function oneShot(lane, prompt, options = {}) {
  const requestId = newRequestId(lane.source);
  const args = nativeArgs(lane.source, prompt, options);
  const process_ = streamProcess(lane.source, args, lane.env({ TOKEN_FURNACE_QUALIFY_REQUEST_ID: requestId }));
  const result = await process_.wait(options.timeout ?? 240_000);
  return { ...result, requestId };
}

function nativeArgs(source, prompt, options) {
  if (source === "claude") return ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", ...(options.resume ? ["--resume", options.resume] : []), ...(options.model ? ["--model", options.model] : []), prompt];
  if (source === "codex") {
    return ["exec", ...(options.resume ? ["resume", options.resume] : []), "--json", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--skip-git-repo-check",
      ...(options.resume ? [] : ["-C", state.workspace]), ...(options.provider ? ["-c", `model_provider="${options.provider}"`] : []), ...(options.model ? ["-m", options.model] : []), prompt];
  }
  return ["run", ...(options.resume ? ["--session", options.resume] : []), "--dir", state.workspace, "--auto", "--format", "json", ...(options.model ? ["--model", options.model] : []), prompt];
}

async function freshDenied(lane, source, model, provider) {
  const sentinel = artifact(`${source}-fresh-denied`);
  const result = await oneShot(lane, shellPrompt(`echo FRESH_BLOCKED > ${sentinel}`), { model, provider: source === "codex" ? provider : undefined, timeout: 150_000 });
  const denied = decision(source, result.requestId, result.startedAt, false);
  return { ok: Boolean(denied) && !existsSync(sentinel), unavailable: !denied && unavailable(result), detail: `denyDecision=${Boolean(denied)} sentinel=${existsSync(sentinel)} ${nativeSummary(result)}` };
}

async function freshAllowed(lane, source, model, provider) {
  const sentinel = artifact(`${source}-recovered`);
  const result = await oneShot(lane, shellPrompt(`echo RECOVERED > ${sentinel}`), { model, provider: source === "codex" ? (provider ?? (model === MODELS.sharedModel ? MODELS.sharedProvider : MODELS.codexProvider)) : undefined, timeout: 240_000 });
  const allowed = decision(source, result.requestId, result.startedAt, true);
  return { ok: completed(result) && existsSync(sentinel) && Boolean(allowed), unavailable: unavailable(result), detail: `allowDecision=${Boolean(allowed)} sentinel=${existsSync(sentinel)} ${nativeSummary(result)}` };
}

function streamProcess(command, args, childEnv) {
  const startedAt = Date.now();
  const child = spawn(command, args, { cwd: state.workspace, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const events = [];
  let output = "";
  let buffer = "";
  let exit = null;
  child.stdout.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-8_000);
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.startsWith("{")) try { events.push(JSON.parse(line)); } catch { /* partial diagnostics */ }
    }
  });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  const exited = new Promise((resolvePromise) => {
    child.once("error", (error) => { exit = { status: -1, signal: null, error: error.message }; children.delete(child); resolvePromise(); });
    child.once("exit", (status, signal) => { exit = { status: status ?? (signal ? 1 : -1), signal }; children.delete(child); resolvePromise(); });
  });
  const result = (timedOut = false) => ({
    status: exit?.status ?? -1, signal: exit?.signal ?? null, timedOut, output, events: [...events], startedAt,
    sessionIds: sessionIdsFrom(command, events),
  });
  return {
    child, events: () => events, output: () => output, exited: () => exit !== null, result: () => result(false),
    wait: async (timeout = 240_000) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2_000).unref(); }, timeout);
      await exited;
      clearTimeout(timer);
      return result(timedOut);
    },
    stop: async () => { await stopChild(child); },
  };
}

function sessionIdsFrom(command, events) {
  const ids = [];
  for (const event of events) {
    const id = command === "claude" ? (event.type === "system" && event.subtype === "init" ? event.session_id : null)
      : command === "codex" ? (event.type === "thread.started" ? event.thread_id : null)
        : command === "opencode" ? event.sessionID : null;
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// ------------------------------------------------------------------ Token Furnace server and API

async function startServer(noPlanUsage = false) {
  const lane = state.lanes.opencode ?? Object.values(state.lanes)[0];
  const serverEnv = {
    ...lane.env(),
    CLAUDE_CONFIG_DIR: state.lanes.claude?.home, CODEX_HOME: state.lanes.codex?.home,
  };
  const child = streamProcess(process.execPath, [state.packageBin, "serve", "--port", "0", ...(noPlanUsage ? ["--no-plan-usage"] : [])], serverEnv);
  const started = await waitFor(() => /http:\/\/127\.0\.0\.1:\d+/.test(child.output()) || child.exited(), 30_000);
  const url = child.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!started || !url) throw new Error(`Token Furnace server did not start: ${safeTail(child.output())}`);
  state.server = { child: child.child, url, stop: child.stop };
}

async function restartServer(noPlanUsage) {
  await state.server?.stop();
  await startServer(noPlanUsage);
}

async function budgetState() {
  return fetch(`${state.server.url}/api/budgets`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null);
}

async function postBudget(path, body) {
  const current = await budgetState();
  if (!current?.mutationToken) return { ok: false, value: null };
  return fetch(`${state.server.url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-token-furnace-mutation": current.mutationToken, origin: state.server.url }, body: JSON.stringify(typeof body === "function" ? body(current) : body) })
    .then(async (response) => ({ ok: response.ok, value: await response.json().catch(() => null) })).catch(() => ({ ok: false, value: null }));
}

function resetPolicies() { return postBudget("/api/budgets", (current) => ({ expectedRevision: current.revision, policies: [] })); }
async function stopPreview(scope) { return (await postBudget("/api/budgets/stop-preview", { scope })).value; }
async function unlock(scope) { return (await postBudget("/api/budgets/unlock", { scope })).ok; }

/** Stop scenarios run with enforcement on (generous Manual limits): hook-launched sessions register only while enforcing. */
function permissivePolicies() {
  return postBudget("/api/budgets", (current) => ({
    expectedRevision: current.revision,
    policies: supported.map((source) => ({ scope: { kind: "source", source }, mode: "manual", unit: "tokens-per-hour", limit: admissionLimit(source) * 10, deadline: null })),
  }));
}

function setSourcePolicy(source, limit) {
  return postBudget("/api/budgets", (current) => ({
    expectedRevision: current.revision,
    policies: [...(current.policies ?? []).filter((policy) => !(policy.scope?.kind === "source" && policy.scope.source === source)), { scope: { kind: "source", source }, mode: "manual", unit: "tokens-per-hour", limit, deadline: null }],
  }));
}

async function latestOperation(scope, since) {
  let found = null;
  await waitFor(async () => {
    const current = await budgetState();
    const stop = (current?.stops ?? []).filter((candidate) => sameScope(candidate.scope, scope) && Date.parse(candidate.createdAt ?? "") >= since - 2_000).at(-1);
    if (!stop?.operationId) return false;
    const response = await fetch(`${state.server.url}/api/budgets/operations/${encodeURIComponent(stop.operationId)}`).then((value) => value.ok ? value.json() : null).catch(() => null);
    found = response;
    return Boolean(response && response.status !== "pending" && (response.outcomes ?? []).every((outcome) => outcome.status !== "requested"));
  }, 30_000);
  return found;
}

function hasManualPolicy(value, source, limit) {
  return Boolean(value?.policies?.some((policy) => policy.scope?.kind === "source" && policy.scope.source === source && policy.mode === "manual" && policy.limit === limit));
}

function sameScope(left, right) {
  return left?.kind === right.kind && (left.source ?? null) === (right.source ?? null) && (left.provider ?? null) === (right.provider ?? null) && (left.model ?? null) === (right.model ?? null);
}

// ------------------------------------------------------------------ durable evidence

function withDb(name, fn, fallback) {
  let db;
  try { db = new DatabaseSync(join(state.tf.TOKEN_FURNACE_STATE_HOME, "token-furnace", name)); return fn(db); }
  catch { return fallback; }
  finally { db?.close(); }
}

/** A real hook decision correlated to this qualification run; its own request id (if any) comes from the native payload. */
function decision(source, correlationId, startedAt, allowed) {
  return withDb("budgets.sqlite", (db) => db.prepare("SELECT allowed, reason, request_id, session_id FROM admission_decisions WHERE source = ? AND correlation_id = ? AND (request_id IS NULL OR request_id <> correlation_id) AND at >= ? ORDER BY at DESC")
    .all(source, correlationId, Math.max(0, startedAt - 2_000)).find((row) => Boolean(row.allowed) === allowed) ?? null, null);
}

function measuredUsage(source, since) {
  return withDb("budgets.sqlite", (db) => Number(db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM usage_events WHERE scope_key = ? AND at >= ? AND amount > 0").get(`source:${source}`, Math.max(0, since - 2_000))?.total ?? 0), 0);
}

function admissionLimit(source) {
  return withDb("budgets.sqlite", (db) => {
    const used = Number(db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM usage_events WHERE scope_key = ?").get(`source:${source}`)?.total ?? 0);
    const reserved = Number(db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM reservations WHERE scope_key = ? AND status = 'reserved'").get(`source:${source}`)?.total ?? 0);
    return admissionLimitForLedger({ used, reserved });
  }, QUALIFY_ADMISSION_FLOOR);
}

function admissionLimitForLedger(ledger) {
  return Math.max(QUALIFY_ADMISSION_FLOOR, Math.ceil((ledger.used > 0 ? ledger.used : 0) + (ledger.reserved > 0 ? ledger.reserved : 0)) * 4);
}

function controlTargets() {
  return withDb("control.sqlite", (db) => db.prepare("SELECT id, source, provider, model, session_id, pid FROM targets").all(), []);
}

// ------------------------------------------------------------------ browser (real Chromium over CDP)

async function withBrowser(fn) {
  const userData = tempDir("token-furnace-browser-");
  const child = spawn(state.browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${userData}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
  children.add(child);
  let socket;
  try {
    const portFile = join(userData, "DevToolsActivePort");
    if (!await waitFor(() => existsSync(portFile), 20_000)) return { ok: false, ran: false, detail: "Browser did not expose a DevTools endpoint." };
    const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) return { ok: false, ran: false, detail: "Browser page target was unavailable." };
    socket = await connectCdp(page.webSocketDebuggerUrl);
    return await fn(socket);
  } catch (error) {
    return { ok: false, ran: true, detail: `Browser error: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    socket?.close();
    await stopChild(child);
  }
}

function driveBudgetsBrowser() {
  return withBrowser(async (socket) => {
    await socket.command("Page.navigate", { url: `${state.server.url}/#budgets` });
    if (!await waitFor(async () => Boolean(await socket.evaluate(`(${budgetControlsReady.toString()})(document)`)), 20_000)) return { ok: false, ran: true, detail: "The Budgets tab did not render all three source budget controls." };
    const result = await socket.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const setValue = (element, value) => {
        Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set?.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const save = async (label) => { document.querySelector('button[aria-label="Save ' + label + ' budget"]')?.click(); await sleep(500); };
      const autoReadings = [];
      for (const label of ["Claude Code", "Codex", "OpenCode"]) {
        const mode = () => document.querySelector('select[aria-label="' + label + ' budget mode"]');
        if (!mode()) return { ok: false, detail: "The " + label + " budget mode control is missing." };
        setValue(mode(), "off"); await sleep(150); await save(label);
        setValue(mode(), "auto"); await sleep(150); await save(label);
        const autoState = await (await fetch('/api/budgets', { cache: 'no-store' })).json();
        const reading = autoState.sources?.find((source) => source.label === label);
        if (reading) autoReadings.push(reading);
        setValue(mode(), "manual"); await sleep(150);
        const limit = document.querySelector('input[aria-label="' + label + ' budget limit"]');
        if (!limit) return { ok: false, detail: "The " + label + " Manual limit field did not render." };
        setValue(limit, "1000"); await sleep(100); await save(label);
      }
      return { ok: true, autoReadings };
    })()`);
    return result?.ok ? { ok: true, ran: true, autoReadings: result.autoReadings } : { ok: false, ran: true, detail: result?.detail ?? "Browser form scenario failed." };
  });
}

function driveStopBrowser(selector, expectedText) {
  return withBrowser(async (socket) => {
    await socket.command("Page.navigate", { url: `${state.server.url}/#budgets` });
    if (!await waitFor(async () => Boolean(await socket.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)), 30_000)) return { ok: false, ran: true, detail: `The Budgets tab did not render ${selector}.` };
    const result = await socket.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const button = document.querySelector(${JSON.stringify(selector)});
      if (button.disabled) return { ok: false, detail: "The stop button is disabled in the Budgets tab." };
      button.click();
      let dialog = null;
      for (let i = 0; i < 150; i++) {
        dialog = document.querySelector('dialog[open], [role="dialog"]');
        if (dialog && !/Loading/i.test(dialog.innerText)) break;
        await sleep(100);
      }
      if (!dialog) return { ok: false, detail: "No stop preview dialog opened." };
      if (!dialog.innerText.includes(${JSON.stringify(expectedText)})) return { ok: false, detail: "The stop preview did not name the expected identity." };
      const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Confirm stop');
      if (!confirm) return { ok: false, detail: "No explicit Confirm stop button." };
      confirm.click();
      for (let i = 0; i < 300; i++) {
        const open = document.querySelector('dialog[open], [role="dialog"]');
        if (!open) return { ok: true };
        if (/remain unresolved/i.test(open.innerText)) return { ok: true, partial: true };
        if (/failed/i.test(open.innerText) && !open.querySelector('button[disabled]')) return { ok: false, detail: "UI stop error: " + open.innerText.slice(-200) };
        await sleep(100);
      }
      return { ok: false, detail: "The UI stop did not finish within its bound." };
    })()`);
    return result?.ok ? { ok: true, ran: true } : { ok: false, ran: true, detail: result?.detail ?? "UI stop confirmation failed." };
  });
}

function budgetControlsReady(documentLike) {
  return ["Claude Code", "Codex", "OpenCode"].every((label) => documentLike.querySelector(`select[aria-label="${label} budget mode"]`) && documentLike.querySelector(`button[aria-label="Save ${label} budget"]`));
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await new Promise((resolvePromise, reject) => { socket.addEventListener("open", resolvePromise, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const command = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const requestId = ++id;
    pending.set(requestId, (message) => (message.error ? reject(new Error(message.error.message)) : resolvePromise(message.result)));
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  await command("Runtime.enable");
  await command("Page.enable");
  return {
    command,
    evaluate: async (expression) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value;
    },
    close: () => socket.close(),
  };
}

function findBrowser() {
  for (const candidate of [env.TOKEN_FURNACE_QUALIFY_BROWSER, "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"].filter(Boolean)) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

// ------------------------------------------------------------------ small helpers

function shellPrompt(command) {
  return `Run exactly this one shell command with your shell/Bash tool and nothing else, then reply OK: ${command}`;
}

function gated(barrier, command) {
  return `while [ ! -f ${barrier} ]; do sleep 1; done; ${command}`;
}

function release(barrier) {
  if (barrier && !existsSync(barrier)) writeFileSync(barrier, "RELEASED\n", { mode: 0o600 });
}

function artifact(name) {
  return join(state.workspace, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sentinel`);
}

function newRequestId(source) {
  return `qualify-${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function completed(result) {
  return result?.status === 0 && !result.timedOut && !result.signal;
}

/** Access/route unavailability (auth, quota, missing option, timeouts) is BLOCKED, not FAIL. */
function unavailable(result) {
  if (!result || result.timedOut || result.signal) return true;
  if (result.status === 0) return false;
  return /(?:\b(?:not found|unknown option|unavailable|timed out|rate.?limit|usage limit|quota|429)\b|\b(?:login|auth(?:entication)?|credential(?:s)?)\b[\s\S]*?\b(?:fail(?:ed|ure)?|error|required|invalid|denied|missing|expired)\b)/i.test(result.output ?? "");
}

function nativeSummary(result) {
  return `exit=${result?.status} timedOut=${Boolean(result?.timedOut)} signal=${result?.signal ?? "none"} sessions=${result?.sessionIds?.length ?? 0} tail="${safeTail(result?.output)}"`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function run(command, args, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-200_000); });
    child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-200_000); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeout);
    child.once("error", (error) => { clearTimeout(timer); resolvePromise({ status: -1, output: error.message }); });
    child.once("exit", (status, signal) => { clearTimeout(timer); resolvePromise({ status: status ?? -1, signal, timedOut, output }); });
  });
}

async function waitFor(check, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return Boolean(await check());
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolvePromise(); }, 3_000);
    child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
  });
}

function tempDir(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function safeTail(value) {
  return String(value || "").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/(token|key|secret|password)["']?\s*[=:]\s*["']?[^\s"',}]+/gi, "$1=[redacted]").replace(/\s+/g, " ").slice(-300);
}

/** The last JSON object line of CLI output (the CLI writes previews to stderr, results to stdout). */
function jsonOutput(value) {
  for (const line of String(value || "").trim().split(/\r?\n/).reverse()) {
    try { const parsed = JSON.parse(line); if (parsed && typeof parsed === "object") return parsed; } catch { /* diagnostics */ }
  }
  return null;
}

function isPersonal(path) {
  const home = realpathOr(homedir());
  return [join(home, ".claude"), join(home, ".codex"), join(home, ".local", "share", "opencode"), home].map(realpathOr).includes(path);
}

function readPackageVersion(rootPath) {
  try { return JSON.parse(readFileSync(join(rootPath, "package.json"), "utf8")).version; } catch { return null; }
}

function realpathOr(path) {
  try { return realpathSync(path); } catch { return path; }
}

function parseSources(args) {
  const index = args.indexOf("--sources");
  const sources = String(index >= 0 ? args[index + 1] ?? "" : supported.join(",")).split(",").map((source) => source.trim()).filter(Boolean);
  if (!sources.length || sources.some((source) => !supported.includes(source))) {
    console.error(`Usage: npm run qualify:budgets -- --sources ${supported.join(",")}`);
    process.exit(2);
  }
  return [...new Set(sources)];
}

function selfTest() {
  const checks = [];
  const expect = (name, ok) => { if (!ok) checks.push(name); };
  state.workspace = "/tmp/ws";
  const claudeResume = nativeArgs("claude", "p", { resume: "s", model: "m" });
  const codexFresh = nativeArgs("codex", "p", { model: "m", provider: "openrouter" });
  const codexResume = nativeArgs("codex", "p", { resume: "t" });
  const opencode = nativeArgs("opencode", "p", { resume: "s", model: "x/y" });
  expect("claude resume", claudeResume.includes("--resume") && claudeResume.includes("--output-format") && claudeResume.at(-1) === "p");
  expect("codex fresh", codexFresh.includes("-C") && codexFresh.includes('model_provider="openrouter"') && codexFresh.includes("--json"));
  expect("codex resume", codexResume[1] === "resume" && !codexResume.includes("-C"));
  expect("opencode session", opencode.includes("--session") && opencode.includes("--format") && opencode.includes("x/y"));
  expect("session ids", sessionIdsFrom("claude", [{ type: "system", subtype: "init", session_id: "a" }])[0] === "a" && sessionIdsFrom("codex", [{ type: "thread.started", thread_id: "t" }])[0] === "t" && sessionIdsFrom("opencode", [{ sessionID: "o" }])[0] === "o");
  expect("unavailable", unavailable({ timedOut: true }) && !unavailable({ status: 0, output: "auth failed narrative" }) && unavailable({ status: 1, output: "Error: usage limit exceeded" }) && !unavailable({ status: 1, output: "denied by Token Furnace budget" }));
  expect("gated", gated("/b", "echo x > /f").includes("while [ ! -f /b ]"));
  expect("artifacts unique", artifact("a") !== artifact("a"));
  expect("admission limit", admissionLimitForLedger({ used: 10, reserved: 5 }) === QUALIFY_ADMISSION_FLOOR && admissionLimitForLedger({ used: 1_000_000, reserved: 0 }) === 4_000_000);
  expect("scope", sameScope({ kind: "model", provider: "p", model: "m" }, { kind: "model", provider: "p", model: "m" }) && !sameScope({ kind: "provider", provider: "p" }, { kind: "provider", provider: "q" }));
  expect("redaction", !safeTail("Authorization: Bearer abc123 sk-or-v1-abcdefghij token=xyz").match(/abc123|abcdefghij|xyz/));
  expect("json output", jsonOutput('noise\n{"status":"complete"}\n')?.status === "complete");
  expect("controls ready", budgetControlsReady({ querySelector: () => ({}) }) && !budgetControlsReady({ querySelector: () => null }));
  if (checks.length) { console.error(`qualification contract failed: ${checks.join(", ")}`); process.exitCode = 1; }
  else console.log("qualification contract ok");
}
