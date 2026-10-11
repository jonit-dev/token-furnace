#!/usr/bin/env node
/**
 * The CLI: node:util parseArgs, the commands from architecture.md "Entry points", and the exit
 * codes of burn.py main(): 1 with no data, 1 with leaks or a failing doctor, 0 otherwise.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CONTEXT_TARGET_LABEL } from "./core/context";
import { PROVIDERS } from "./core/providers";
import type { BudgetScope } from "./core/budgets";
import { compose, type App } from "./compose";
import { topIssues } from "./core/analyze/issues";
import { reportView } from "./core/analyze/view";
import { renderHtml } from "./render/html";
import { printDoctor, printText } from "./render/text";
import { serve } from "./server";
import type { RawReport, ScanProgress, Source } from "./core/model";
import { openCodeWeek, planWeek } from "./services/usage-client";
import { controlTargetProof, type ControlOutcome, type NativeTarget } from "./services/agent-control";
import { runChurnHook, readStdin } from "./setup/churn-hook";
import { installBudgetAdapters, runFixConfig, runSetup } from "./setup/agents";

const USAGE = `Usage: token-furnace [days] [options]
       token-furnace serve [--port 8765]
       token-furnace setup [--apply] [--rollback] [--aggressive] [--verify]
       token-furnace fix-config
       token-furnace hook churn
       token-furnace hook budget [--source <source>]
       token-furnace budgets status
       token-furnace budgets enable --confirm [--rollback]
       token-furnace budgets stop --source <source> | --provider <id> | --model <provider/model> [--confirm] [--force --force-confirm]
       token-furnace budgets unlock --source <source> | --provider <id> | --model <provider/model> --confirm

Where the token budget actually went. Reads local Claude Code and Codex transcripts.

  days                 how many days back to look (default 7)
  --source <agent>     all (default), claude, codex, or opencode
  --json               print the Report JSON and nothing else, for agents and scripts
  --full               the full text report (the old burn.py output)
  --html <path>        also write a self-contained HTML report
  --list-sources       each agent, its path and its transcript count
  --weekly-budget <M>  weekly budget in millions of weighted tokens
  --no-plan-usage      never fetch subscription usage from Anthropic or OpenCode Go (a saved reading is still used)
  --no-cache           parse every file, write no cache
  serve [--port 8765]  live report on http://127.0.0.1:<port>, refreshed in the background
  fix-config          repair context and worker settings (backs up first; --include-depth optional)
  -h, --help           this text
`;

interface Options {
  days: number;
  source: Source | "all";
  json: boolean;
  full: boolean;
  html: string | null;
  listSources: boolean;
  weeklyBudget: number | null;
  planUsage: boolean;
  port: number;
}

export async function main(argv: string[] = process.argv.slice(2), app?: App): Promise<number> {
  if (argv[0] === "hook" && argv[1] === "budget") {
    const ownsApp = !app;
    const budgetApp = app ?? compose(process.env, { noCache: true });
    const source = argv[2] === "--source" && (argv[3] === "claude" || argv[3] === "codex" || argv[3] === "opencode") ? argv[3] : undefined;
    try { return runBudgetHook(readStdin(), budgetApp, source); } finally { if (ownsApp) budgetApp.close(); }
  }
  if (argv[0] === "hook" && argv[1] === "churn") {
    return runChurnHook(readStdin(), (app?.env ?? process.env), process.stdout);
  }
  if (argv[0] === "fix-config") {
    if (argv.length > 2 || (argv[1] !== undefined && argv[1] !== "--include-depth")) {
      process.stderr.write("Usage: token-furnace fix-config [--include-depth]\n");
      return 2;
    }
    return runFixConfig(app?.env ?? process.env, process.stdout, { includeDepth: argv[1] === "--include-depth" });
  }
  if (argv[0] === "setup") {
    const setupArgs = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        apply: { type: "boolean" },
        rollback: { type: "boolean" },
        aggressive: { type: "boolean" },
        verify: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (setupArgs.values.help) {
      process.stdout.write(
        "Usage: token-furnace setup [--apply] [--aggressive] [--verify] [--rollback]\n\n" +
          "  --apply       write changes (default: dry run)\n" +
          "  --aggressive  also set the flagged-risky subagent spawn depth\n" +
          "  --verify      check an existing install; exits 1 on any failure\n" +
          "  --rollback    restore the most recent backup\n",
      );
      return 0;
    }
    return runSetup(
      {
        apply: setupArgs.values.apply,
        rollback: setupArgs.values.rollback,
        aggressive: setupArgs.values.aggressive,
        verify: setupArgs.values.verify,
      },
      app?.env ?? process.env,
      process.stdout,
    );
  }

  if (argv[0] === "budgets") {
    const ownsApp = !app;
    const budgetApp = app ?? compose(process.env, { noCache: true });
    try { return await runBudgets(argv.slice(1), budgetApp); } finally { if (ownsApp) budgetApp.close(); }
  }

  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      source: { type: "string" },
      json: { type: "boolean" },
      full: { type: "boolean" },
      html: { type: "string" },
      "list-sources": { type: "boolean" },
      "weekly-budget": { type: "string" },
      "plan-usage": { type: "boolean" }, // the default now; accepted so old scripts keep working
      "no-plan-usage": { type: "boolean" },
      "no-cache": { type: "boolean" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsed.values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const ownsApp = !app;
  if (!app) {
    app = compose(process.env, { noCache: Boolean(parsed.values["no-cache"]) });
  }
  const commandApp = app;
  try {

  const serveMode = parsed.positionals[0] === "serve";
  const positionals = serveMode ? parsed.positionals.slice(1) : parsed.positionals;
  const days = Number(positionals[0] ?? 7);
  if (!Number.isInteger(days) || days < 1) {
    process.stderr.write(`token-furnace: days must be a whole number, got "${positionals[0] ?? ""}"\n`);
    return 2;
  }
  const source = (parsed.values.source ?? "all") as Source | "all";
  if (source !== "all" && !app.sources.some((agent) => agent.name === source)) {
    process.stderr.write(`token-furnace: --source must be all, ${app.sources.map((agent) => agent.name).join(" or ")}\n`);
    return 2;
  }
  const weeklyBudget = weeklyBudgetOf(app.env, parsed.values["weekly-budget"]);
  const port = Number(parsed.values.port ?? 8765);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    process.stderr.write("token-furnace: --port must be a port number\n");
    return 2;
  }
  const options: Options = {
    days,
    source,
    json: Boolean(parsed.values.json),
    full: Boolean(parsed.values.full),
    html: parsed.values.html ?? null,
    listSources: Boolean(parsed.values["list-sources"]),
    weeklyBudget,
    planUsage: !parsed.values["no-plan-usage"],
    port,
  };

  if (options.listSources) {
    listSources(commandApp);
    return 0;
  }
  if (serveMode) {
    await serve(app, options);
    return 0;
  }

  const now = app.now();
  await commandApp.reports.refresh(stderrProgress());
  const [plan, goPlan] = await Promise.all([planWeek(commandApp.env, now, options.planUsage), openCodeWeek(commandApp.env, now, options.planUsage)]);
  const report = commandApp.reports.getRaw(options.days, options.source, {
    weeklyBudget: options.weeklyBudget,
    planWeek: plan,
    opencodeWeek: goPlan,
    now,
  });
  if (!report) {
    // --json keeps stdout to the Report alone, so the notice goes to stderr there.
    (options.json ? process.stderr : process.stdout).write(
      "No transcripts found. Try --list-sources.\n",
    );
    return 1;
  }

  const htmlPath = writeHtml(report, now, options.html);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(reportView(report, now))}\n`);
    return 0;
  }
  if (options.full) {
    process.stdout.write(printText(report));
    if (htmlPath) process.stdout.write(`\nHTML report: ${htmlPath}\n`);
    return 0;
  }
  process.stdout.write(printDoctor(report, htmlPath));
  return topIssues(report).length ? 1 : 0;
  } finally {
    if (ownsApp) commandApp.close();
  }
}

async function runBudgets(argv: string[], app: App): Promise<number> {
  const command = argv[0] ?? "status";
  const parsed = parseArgs({
    args: argv.slice(1), allowPositionals: true,
    options: {
      provider: { type: "string" }, model: { type: "string" }, source: { type: "string" },
      confirm: { type: "boolean" }, rollback: { type: "boolean" }, force: { type: "boolean" }, "force-confirm": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    process.stdout.write("Usage: token-furnace budgets status | enable --confirm [--rollback] | stop --source <source> | --provider <id> | --model <provider/model> [--confirm] | unlock --source <source> | --provider <id> | --model <provider/model> --confirm\n");
    return 0;
  }
  const scope = budgetScope(parsed.values.provider, parsed.values.model, parsed.values.source);
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(app.budgets.snapshot(budgetSources(app)))}\n`);
    return 0;
  }
  if (command === "enable") {
    if (!parsed.values.confirm) {
      process.stderr.write("Refusing to enable enforcement without --confirm.\n");
      return 2;
    }
    return installBudgetAdapters(app.env, { apply: true, rollback: Boolean(parsed.values.rollback) }, process.stdout);
  }
  if ((command !== "stop" && command !== "unlock") || !scope) {
    process.stderr.write("Usage: token-furnace budgets stop|unlock --source <source> | --provider <id> | --model <provider/model>\n");
    return 2;
  }
  if (command === "unlock") {
    if (!parsed.values.confirm) {
      process.stderr.write("Refusing unlock without --confirm.\n");
      return 2;
    }
    app.budgets.unlock(scope);
    process.stdout.write(`${JSON.stringify({ ok: true, scope })}\n`);
    return 0;
  }
  const controlPreview = app.control.preview(scope);
  const targets = controlPreview.targets;
  const preview = app.budgets.previewStop(scope, targets.map((target) => target.id), controlTargetProof(targets));
  if (!parsed.values.confirm) {
    process.stdout.write(`${JSON.stringify({ action: "preview", ...preview, targets: targets.map((target) => ({ id: target.id, source: target.source, provider: target.provider, account: target.account ?? null, model: target.model, pid: target.pid, processStartTime: target.processStartTime, ownerUid: target.ownerUid, executable: target.executable })), unverified: controlPreview.unverified, collateral: controlPreview.collateral })}\n`);
    return 0;
  }
  if (parsed.values.force && !parsed.values["force-confirm"]) {
    process.stderr.write("Force stop requires --force-confirm.\n");
    return 2;
  }
  const currentTargets = app.control.preview(scope).targets;
  const currentTargetIds = currentTargets.map((target) => target.id).sort();
  if (JSON.stringify(currentTargetIds) !== JSON.stringify(preview.targetIds) || controlTargetProof(currentTargets) !== (preview.targetProof ?? controlTargetProof(currentTargets))) {
    process.stderr.write("Stop preview targets changed; preview again.\n");
    return 2;
  }
  const initial = preview.targetIds.map((targetId) => ({ targetId, status: "requested" as const }));
  const operation = app.budgets.commitStop(preview.id, preview.fingerprint, initial);
  let outcomes: ControlOutcome[];
  try {
    outcomes = await app.control.stop(scope, Boolean(parsed.values.force));
  } catch (error) {
    outcomes = preview.targetIds.map((targetId) => ({
      targetId,
      status: "failed" as const,
      detail: error instanceof Error ? error.message : String(error),
    }));
  }
  const updated = app.budgets.updateOperation(operation.id, outcomes) ?? operation;
  process.stdout.write(`${JSON.stringify(updated)}\n`);
  return updated.status === "complete" ? 0 : 1;
}

export function runBudgetHook(stdin: string, app: App, sourceOverride?: Source): number {
  const configuredSource = sourceOverride ?? sourceValue(app.env.TOKEN_FURNACE_SOURCE);
  let event: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Budget hook input must be a JSON object.");
    event = parsed as Record<string, unknown>;
  } catch {
    if (configuredSource === "claude" || configuredSource === "codex") return 2;
    process.stdout.write(JSON.stringify({ decision: "deny", allow: false, reason: "Malformed budget hook input." }));
    return 0;
  }
  const source = sourceOverride ?? sourceValue(event.source) ?? configuredSource;
  const hintedProvider = stringValue(event.provider ?? event.providerID ?? event.provider_id);
  const hintedModel = stringValue(event.model ?? event.modelID ?? event.model_id);
  const hookEvent = stringValue(event.hook_event_name ?? event.hookEventName ?? event.eventName);
  const phase = stringValue(event.phase ?? event.lifecycle) ?? (hookEvent === "PostToolUse" ? "complete" : hookEvent === "Stop" || hookEvent === "SessionEnd" ? "abandon" : "start");
  const reservationId = stringValue(event.reservationId ?? event.reservation_id);
  const requestId = stringValue(event.requestId ?? event.request_id ?? event.tool_use_id ?? event.toolUseId ?? event.callID ?? event.call_id ?? event.turn_id ?? event.turnId);
  const correlationId = stringValue(app.env.TOKEN_FURNACE_QUALIFY_REQUEST_ID);
  const sessionId = stringValue(event.session_id ?? event.sessionId);
  const metadata = source ? resolveNativeMetadata(app, event, source, hookEvent, hintedProvider, hintedModel) : null;
  const provider = metadata?.provider ?? null;
  const model = metadata?.model ?? null;
  const account = source ? app.budgets.verifiedAccount(source, provider, metadata?.account) : null;
  const identity = source ? { source, provider, model, account } : null;
  if (identity && (phase === "start" || provider || model || metadata?.account || nativeFromEvent(event, identity.source))) {
    registerHookTarget(app, event, identity);
  }
  if ((reservationId || requestId || sessionId) && (phase === "complete" || phase === "completed" || phase === "reconcile" || phase === "cancel" || phase === "cancelled" || phase === "abandon" || phase === "abandoned")) {
    const amount = usageAmount(event) ?? metadata?.usage ?? null;
    if (amount !== null && (phase === "complete" || phase === "completed" || phase === "reconcile")) {
      const eventId = stringValue(event.eventId ?? event.event_id) ?? `${reservationId ?? requestId ?? sessionId}:${phase}`;
      const observedAt = eventObservedAt(event);
      if (reservationId) app.budgets.reconcile(reservationId, amount, eventId, observedAt);
      else if (requestId) app.budgets.reconcileRequest(requestId, amount, eventId, observedAt);
      else if (sessionId) app.budgets.reconcileSession(sessionId, amount, eventId, observedAt);
    } else if (phase === "cancel" || phase === "cancelled" || phase === "abandon" || phase === "abandoned") {
      const sessionId = stringValue(event.session_id ?? event.sessionId);
      if (!source || !sessionId || !app.control.ownsSession(source, sessionId)) {
        writeBudgetHookOutput(source, hookEvent, false, "Native abandonment was not tied to a verified owned session.", null, reservationId);
        return 0;
      }
      if (reservationId) app.budgets.release(reservationId);
      else if (requestId) app.budgets.releaseRequest(requestId);
      else app.budgets.releaseSession(sessionId);
    } else if (phase === "complete" && (hookEvent === "PostToolUse" || event.completed === true) && (reservationId || requestId || sessionId)) {
      writeBudgetHookOutput(source, hookEvent, true, "Native completion observed; reservation retained until attributable usage or verified abandonment.", null, reservationId);
      return 0;
    } else {
      writeBudgetHookOutput(source, hookEvent, false, "Completion has no attributable usage telemetry.", null, reservationId);
      return 0;
    }
    writeBudgetHookOutput(source, hookEvent, true, "Reservation reconciled.", null, reservationId);
    return 0;
  }
  const state = app.budgets.snapshot();
  const decision = source
    ? app.budgets.admit({
        identity: identity!,
        estimatedCost: numberValue(event.estimatedCost ?? event.estimated_cost ?? event.cost) ?? undefined,
        costUnit: event.costUnit === "percentage-per-hour" || event.costUnit === "tokens-per-hour" || event.costUnit === "tokens-total" ? event.costUnit : undefined,
        requestId: requestId ?? undefined,
        correlationId: correlationId ?? undefined,
        sessionId: sessionId ?? undefined,
      })
    : state.policies.some((policy) => policy.mode !== "off") || state.stops.length > 0
      ? { allowed: false, reason: "Budget hook input has no verified source.", retryAt: null, reservationId: null, matched: [] }
      : { allowed: true, reason: "Budget enforcement is Off; source identity was not required.", retryAt: null, reservationId: null, matched: [] };
  writeBudgetHookOutput(source, hookEvent, decision.allowed, decision.reason, decision.retryAt, decision.reservationId);
  return 0;
}

function writeBudgetHookOutput(
  source: Source | null,
  hookEvent: string | null,
  allowed: boolean,
  reason: string,
  retryAt: string | null,
  reservationId: string | null,
): void {
  if ((source === "claude" || source === "codex") && hookEvent) {
    process.stdout.write(JSON.stringify(nativeBudgetHookOutput(source, hookEvent, allowed, reason)));
    return;
  }
  process.stdout.write(JSON.stringify({
    decision: allowed ? "allow" : "deny",
    allow: allowed,
    reason,
    retryAt,
    reservationId,
  }));
}

function nativeBudgetHookOutput(source: "claude" | "codex", hookEvent: string | null, allowed: boolean, reason: string): Record<string, unknown> {
  switch (hookEvent) {
    case "PreToolUse":
      if (allowed) return {};
      return source === "claude"
        ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
        : { decision: "block", reason };
    case "UserPromptSubmit":
      return allowed ? {} : { decision: "block", reason };
    case "PostToolUse":
    case "Stop":
    case "SessionEnd":
      return {};
    default:
      return {};
  }
}

function registerHookTarget(app: App, event: Record<string, unknown>, identity: { source: Source; provider: string | null; model: string | null; account: string | null }): void {
  const pid = numberValue(event.pid ?? event.processId ?? event.process_id) ?? process.ppid;
  const expectedExecutable = stringValue(event.executable ?? event.executablePath ?? event.executable_path);
  const observed = pid ? app.control.owningProcess(pid, identity.source, expectedExecutable) : null;
  if (!observed || !Number.isFinite(observed.processStartTime) || (observed.ownerUid === null && !observed.ownerIdentity && !observed.ownerSid)) return;
  const native = nativeFromEvent(event, identity.source);
  const sessionId = stringValue(event.sessionId ?? event.session_id) ?? native?.sessionId ?? null;
  app.control.register({
    id: sessionId ?? `${identity.source}:${observed.pid}:${observed.processStartTime}`,
    source: identity.source,
    provider: identity.provider,
    account: identity.account,
    model: identity.model,
    pid: observed.pid,
    processStartTime: observed.processStartTime,
    ownerUid: observed.ownerUid,
    ownerIdentity: observed.ownerIdentity,
    ownerSid: observed.ownerSid,
    executable: observed.executable,
    sessionId,
    native: native ? { ...native, sessionId: native.sessionId ?? sessionId ?? undefined } : undefined,
    exclusive: event.exclusive === true && observed.pid === pid,
  });
}

function nativeFromEvent(event: Record<string, unknown>, source: Source): NativeTarget | undefined {
  const value = event.native;
  if (!value || typeof value !== "object") return undefined;
  const native = value as Record<string, unknown>;
  const endpoint = stringValue(native.endpoint);
  const expectedKind: NativeTarget["kind"] | null = source === "opencode" ? "opencode" : source === "codex" ? "codex" : null;
  if (!endpoint || !expectedKind || native.kind !== expectedKind) return undefined;
  const transport = native.transport === "websocket" || native.transport === "unix" || native.transport === "stdio" || native.transport === "http" ? native.transport : undefined;
  const rawAuth = native.auth;
  const auth: NativeTarget["auth"] = rawAuth && typeof rawAuth === "object" ? (() => {
    const value = rawAuth as Record<string, unknown>;
    if (value.scheme !== "basic" && value.scheme !== "bearer") return undefined;
    const envName = (candidate: unknown): string | undefined => typeof candidate === "string" && /^[A-Z_][A-Z0-9_]*$/.test(candidate) ? candidate : undefined;
    return { scheme: value.scheme as "basic" | "bearer", tokenEnv: envName(value.tokenEnv), usernameEnv: envName(value.usernameEnv), passwordEnv: envName(value.passwordEnv) };
  })() : undefined;
  if (rawAuth && !auth) return undefined;
  const sessionId = stringValue(native.sessionId ?? native.session_id);
  const threadId = stringValue(native.threadId ?? native.thread_id);
  const turnId = stringValue(native.turnId ?? native.turn_id);
  if (expectedKind === "opencode" && !sessionId) return undefined;
  return { kind: expectedKind, endpoint, transport, auth, sessionId: sessionId ?? undefined, threadId: threadId ?? undefined, turnId: turnId ?? undefined };
}

function usageAmount(event: Record<string, unknown>): number | null {
  const direct = numberValue(event.actualCost ?? event.actual_cost ?? event.tokens ?? event.weightedTokens ?? event.weighted_tokens);
  if (direct !== null && direct >= 0) return direct;
  const usage = event.usage ?? (event.tool_response && typeof event.tool_response === "object" ? (event.tool_response as Record<string, unknown>).usage : null);
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const values = ["input_tokens", "inputTokens", "output_tokens", "outputTokens", "reasoning_tokens", "reasoningTokens", "reasoning_output_tokens", "reasoningOutputTokens", "cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cacheReadInputTokens", "cache_creation_input_tokens", "cacheCreationInputTokens", "cache_write_tokens", "cacheWriteTokens", "total_tokens", "totalTokens"]
    .map((key) => numberValue(record[key]) ?? 0);
  const total = Number.isFinite(Number(record.total_tokens ?? record.totalTokens))
    ? Number(record.total_tokens ?? record.totalTokens)
    : values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? total : null;
}

function eventObservedAt(event: Record<string, unknown>): Date | undefined {
  const value = event.timestamp ?? event.timestampMs ?? event.timestamp_ms ?? event.at ?? event.time;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  return undefined;
}

interface NativeMetadata {
  provider: string | null;
  model: string | null;
  account: string | null;
  usage: number | null;
}

function resolveNativeMetadata(app: App, event: Record<string, unknown>, source: Source, hookEvent: string | null, hintedProvider: string | null, hintedModel: string | null): NativeMetadata {
  const transcriptPath = stringValue(event.transcript_path ?? event.transcriptPath);
  const fromTranscript = transcriptPath ? readNativeTranscriptMetadata(app, source, transcriptPath) : null;
  const nativePayload = Boolean(hookEvent && (hintedProvider || hintedModel));
  let provider = fromTranscript?.provider ?? (nativePayload || event.identityVerified === true ? hintedProvider : null);
  let model = fromTranscript?.model ?? (nativePayload || event.identityVerified === true ? hintedModel : null);
  if (provider && model?.includes("/")) {
    const slash = model.indexOf("/");
    if (provider.toLowerCase() === model.slice(0, slash).toLowerCase()) model = model.slice(slash + 1);
  }
  return {
    provider,
    model,
    account: fromTranscript?.account ?? ((nativePayload || event.identityVerified === true) ? stringValue(event.account ?? event.accountId ?? event.account_id) : null),
    usage: fromTranscript?.usage ?? null,
  };
}

function readNativeTranscriptMetadata(app: App, source: Source, path: string): NativeMetadata | null {
  if (!isAbsolute(path)) return null;
  try {
    const sourceRoot = app.sources.find((candidate) => candidate.name === source)?.base();
    const transcript = realpathSync(path);
    const root = sourceRoot ? realpathSync(sourceRoot) : null;
    if (!root) return null;
    const withinRoot = relative(root, transcript);
    if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) return null;
    if (statSync(transcript).size > 2_000_000) return null;
    const text = readFileSync(transcript, "utf8").slice(-512_000);
    const metadata: NativeMetadata = { provider: null, model: null, account: null, usage: null };
    for (const line of text.split(/\r?\n/)) {
      try { collectNativeMetadata(JSON.parse(line) as unknown, metadata); } catch { /* native logs may contain non-JSON lines */ }
    }
    return metadata;
  } catch { return null; }
}

function collectNativeMetadata(value: unknown, metadata: NativeMetadata, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 5) return;
  const record = value as Record<string, unknown>;
  metadata.provider = stringValue(record.model_provider) ?? stringValue(record.provider ?? record.providerID ?? record.provider_id) ?? metadata.provider;
  metadata.model = stringValue(record.model ?? record.modelID ?? record.model_id) ?? metadata.model;
  metadata.account = stringValue(record.account ?? record.accountId ?? record.account_id ?? record.subscription_id) ?? metadata.account;
  const usage = record.usage ?? record.tokenUsage ?? record.token_usage ?? record.last_token_usage ?? record.lastTokenUsage ?? record.total_token_usage ?? record.totalTokenUsage;
  if (usage && typeof usage === "object") metadata.usage = usageAmount(usage as Record<string, unknown>) ?? metadata.usage;
  for (const key of ["message", "response", "result", "turn", "info", "metadata", "data", "event", "payload", "usage", "tokens", "last_token_usage", "lastTokenUsage", "total_token_usage", "totalTokenUsage"]) {
    const child = record[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) for (const item of child) collectNativeMetadata(item, metadata, depth + 1);
      else collectNativeMetadata(child, metadata, depth + 1);
    }
  }
}

function budgetScope(provider: string | undefined, model: string | undefined, source: string | undefined): BudgetScope | null {
  if (model) {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) return null;
    return { kind: "model", provider: model.slice(0, slash), model: model.slice(slash + 1) };
  }
  if (provider?.trim()) return { kind: "provider", provider };
  if (source === "claude" || source === "codex" || source === "opencode") return { kind: "source", source };
  return null;
}

function budgetSources(app: App) {
  const models = new Map<Source, Set<string>>();
  const providers = new Map<Source, Set<string>>();
  for (const session of app.repo.all()) {
    const sourceModels = models.get(session.source) ?? new Set<string>();
    const sourceProviders = providers.get(session.source) ?? new Set<string>();
    for (const turn of session.turns) {
      if (turn.model.trim()) sourceModels.add(turn.model.trim());
      const slash = turn.model.indexOf("/");
      if (slash > 0) sourceProviders.add(turn.model.slice(0, slash).trim().toLowerCase());
    }
    models.set(session.source, sourceModels);
    providers.set(session.source, sourceProviders);
  }
  for (const target of app.control.registered()) {
    if (!target.provider) continue;
    const values = providers.get(target.source) ?? new Set<string>();
    values.add(target.provider);
    providers.set(target.source, values);
  }
  for (const [source, observed] of app.budgets.observedProviders()) {
    const values = providers.get(source) ?? new Set<string>();
    for (const provider of observed) values.add(provider);
    providers.set(source, values);
  }
  return (Object.keys(PROVIDERS) as Source[]).map((source) => {
    const adapter = app.sources.find((candidate) => candidate.name === source);
    return { source, label: PROVIDERS[source].label, installed: Boolean(adapter && existsSync(adapter.root())), models: [...(models.get(source) ?? [])].sort(), providers: [...(providers.get(source) ?? [])].sort() };
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceValue(value: unknown): Source | null {
  return value === "claude" || value === "codex" || value === "opencode" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
}

/** A redrawn `Scanning 3,412 / 7,700 files (44%)` line on a terminal's stderr. Nothing otherwise. */
function stderrProgress(): ((progress: ScanProgress) => void) | undefined {
  if (!process.stderr.isTTY) return undefined;
  return (p) => {
    if (!p.filesTotal) return;
    const text = p.phase === "ready" ? "" : `Scanning ${p.filesDone.toLocaleString()} / ${p.filesTotal.toLocaleString()} files (${Math.round((100 * p.bytesDone) / Math.max(1, p.bytesTotal))}%)`;
    process.stderr.write(`\r\x1b[K${text}`);
  };
}

/** `--weekly-budget M`, or TOKEN_FURNACE_WEEKLY_BUDGET, in millions of weighted tokens. */
function weeklyBudgetOf(env: NodeJS.ProcessEnv, flag: string | undefined): number | null {
  const text = flag || env.TOKEN_FURNACE_WEEKLY_BUDGET || "";
  const value = Number.parseFloat(text);
  return text && Number.isFinite(value) ? value : null;
}

/** Each agent, its path and its transcript count, like burn.py --list-sources. */
function listSources(app: App): void {
  for (const agent of app.sources) {
    const path = agent.root();
    const found = existsDir(path) ? agent.files().length : 0;
    process.stdout.write(
      `  ${agent.name.padEnd(8)} ${path.padEnd(46)} ${found ? `${found} transcripts` : "not installed"}\n`,
    );
  }
}

/** Writes the static page and returns its absolute path. */
function writeHtml(report: RawReport, now: Date, path: string | null): string | null {
  if (!path) return null;
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, renderHtml(report, now));
  return full;
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when this module is the process entry, even through an npm bin symlink. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

// Only when run as the binary: a test imports main() without starting a command.
if (isEntryPoint()) {
  process.exitCode = await main();
}
