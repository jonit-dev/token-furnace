#!/usr/bin/env node
/**
 * The CLI: node:util parseArgs, the commands from architecture.md "Entry points", and the exit
 * codes of burn.py main(): 1 with no data, 1 with leaks or a failing doctor, 0 otherwise.
 */

import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
import type { ControlOutcome } from "./services/agent-control";
import { runChurnHook, readStdin } from "./setup/churn-hook";
import { installBudgetAdapters, runFixConfig, runSetup } from "./setup/agents";

const USAGE = `Usage: token-furnace [days] [options]
       token-furnace serve [--port 8765]
       token-furnace setup [--apply] [--rollback] [--aggressive] [--verify]
       token-furnace fix-config
       token-furnace hook churn
       token-furnace hook budget [--source <source>]
       token-furnace budgets status
       token-furnace budgets stop --provider <id> [--confirm] [--force --force-confirm]
       token-furnace budgets stop --model <provider/model> [--confirm] [--force --force-confirm]
       token-furnace budgets unlock --provider <id> --confirm

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
    const budgetApp = app ?? compose(process.env, { noCache: true });
    const source = argv[2] === "--source" && (argv[3] === "claude" || argv[3] === "codex" || argv[3] === "opencode") ? argv[3] : undefined;
    return runBudgetHook(readStdin(), budgetApp, source);
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
    const budgetApp = app ?? compose(process.env, { noCache: true });
    return runBudgets(argv.slice(1), budgetApp);
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

  if (!app) {
    app = compose(process.env, { noCache: Boolean(parsed.values["no-cache"]) });
  }

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
    listSources(app);
    return 0;
  }
  if (serveMode) {
    await serve(app, options);
    return 0;
  }

  const now = app.now();
  await app.reports.refresh(stderrProgress());
  const [plan, goPlan] = await Promise.all([planWeek(app.env, now, options.planUsage), openCodeWeek(app.env, now, options.planUsage)]);
  const report = app.reports.getRaw(options.days, options.source, {
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
}

async function runBudgets(argv: string[], app: App): Promise<number> {
  const command = argv[0] ?? "status";
  const parsed = parseArgs({
    args: argv.slice(1), allowPositionals: true,
    options: {
      provider: { type: "string" }, model: { type: "string" }, source: { type: "string" },
      confirm: { type: "boolean" }, force: { type: "boolean" }, "force-confirm": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    process.stdout.write("Usage: token-furnace budgets status | enable --confirm | stop --provider <id> [--confirm] | stop --model <provider/model> [--confirm] | unlock --provider <id> --confirm\n");
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
    return installBudgetAdapters(app.env, { apply: true }, process.stdout);
  }
  if ((command !== "stop" && command !== "unlock") || !scope) {
    process.stderr.write("Usage: token-furnace budgets stop|unlock --provider <id> | --model <provider/model>\n");
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
  const targets = app.control.discover(scope);
  const preview = app.budgets.previewStop(scope, targets.map((target) => target.id));
  if (!parsed.values.confirm) {
    process.stdout.write(`${JSON.stringify({ action: "preview", ...preview, targets: targets.map((target) => ({ id: target.id, source: target.source, provider: target.provider, model: target.model })) })}\n`);
    return 0;
  }
  if (parsed.values.force && !parsed.values["force-confirm"]) {
    process.stderr.write("Force stop requires --force-confirm.\n");
    return 2;
  }
  const currentTargetIds = app.control.discover(scope).map((target) => target.id).sort();
  if (JSON.stringify(currentTargetIds) !== JSON.stringify(preview.targetIds)) {
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

function runBudgetHook(stdin: string, app: App, sourceOverride?: Source): number {
  let event: Record<string, unknown> = {};
  try { event = JSON.parse(stdin) as Record<string, unknown>; } catch {
    process.stdout.write(JSON.stringify({ decision: "deny", allow: false, reason: "Malformed budget hook input." }));
    return 0;
  }
  const source = sourceOverride ?? (event.source === "claude" || event.source === "codex" || event.source === "opencode"
    ? event.source
    : app.env.TOKEN_FURNACE_SOURCE === "claude" || app.env.TOKEN_FURNACE_SOURCE === "codex" || app.env.TOKEN_FURNACE_SOURCE === "opencode" ? app.env.TOKEN_FURNACE_SOURCE : null);
  const provider = stringValue(event.provider ?? event.providerID ?? event.provider_id);
  const model = stringValue(event.model ?? event.modelID ?? event.model_id);
  const state = app.budgets.snapshot();
  const decision = source
    ? app.budgets.admit({
        identity: { source, provider, model },
        estimatedCost: numberValue(event.estimatedCost ?? event.estimated_cost ?? event.cost) ?? 1,
        costUnit: event.costUnit === "percentage-per-hour" || event.costUnit === "tokens-per-hour" || event.costUnit === "tokens-total" ? event.costUnit : undefined,
        requestId: stringValue(event.requestId ?? event.request_id) ?? undefined,
      })
    : state.policies.some((policy) => policy.mode !== "off") || state.stops.length > 0
      ? { allowed: false, reason: "Budget hook input has no verified source.", retryAt: null, reservationId: null, matched: [] }
      : { allowed: true, reason: "Budget enforcement is Off; source identity was not required.", retryAt: null, reservationId: null, matched: [] };
  const body = {
    decision: decision.allowed ? "allow" : "deny",
    allow: decision.allowed,
    reason: decision.reason,
    retryAt: decision.retryAt,
    ...(decision.allowed ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } }),
  };
  process.stdout.write(JSON.stringify(body));
  return 0;
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
  return (Object.keys(PROVIDERS) as Source[]).map((source) => {
    const adapter = app.sources.find((candidate) => candidate.name === source);
    return { source, label: PROVIDERS[source].label, installed: Boolean(adapter && existsSync(adapter.root())), models: [] };
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
