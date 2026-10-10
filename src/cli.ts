/**
 * The CLI: node:util parseArgs, the commands from architecture.md "Entry points", and the exit
 * codes of burn.py main(): 1 with no data, 1 with leaks or a failing doctor, 0 otherwise.
 */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compose, type App } from "./compose";
import { topIssues } from "./core/analyze/issues";
import { reportView } from "./core/analyze/view";
import { renderHtml } from "./render/html";
import { printDoctor, printText } from "./render/text";
import { serve } from "./server";
import type { RawReport, Source } from "./core/model";
import { planWeek } from "./services/usage-client";

const USAGE = `Usage: token-furnace [days] [options]
       token-furnace serve [--port 8765]

Where the token budget actually went. Reads local Claude Code and Codex transcripts.

  days                 how many days back to look (default 7)
  --source <agent>     all (default), claude, or codex
  --json               print the Report JSON and nothing else, for agents and scripts
  --full               the full text report (the old burn.py output)
  --html <path>        also write a self-contained HTML report
  --list-sources       each agent, its path and its transcript count
  --weekly-budget <M>  weekly budget in millions of weighted tokens
  --plan-usage         refresh the subscription window from api.anthropic.com (opt-in network call; a saved reading is always used)
  --no-cache           parse every file, write no cache
  serve [--port 8765]  live report on http://127.0.0.1:<port>, rebuilt per request
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

export async function main(argv: string[] = process.argv.slice(2), app: App = compose()): Promise<number> {
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
      "plan-usage": { type: "boolean" },
      "no-cache": { type: "boolean" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsed.values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const serveMode = parsed.positionals[0] === "serve";
  const positionals = serveMode ? parsed.positionals.slice(1) : parsed.positionals;
  const days = Number(positionals[0] ?? 7);
  if (!Number.isInteger(days) || days < 1) {
    process.stderr.write(`token-furnace: days must be a whole number, got "${positionals[0] ?? ""}"\n`);
    return 2;
  }
  const source = (parsed.values.source ?? "all") as Source | "all";
  if (source !== "all" && source !== "claude" && source !== "codex") {
    process.stderr.write(`token-furnace: --source must be all, claude or codex\n`);
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
    planUsage: Boolean(parsed.values["plan-usage"]),
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
  app.reports.refresh();
  const plan = await planWeek(app.env, now, options.planUsage);
  const report = app.reports.getRaw(options.days, options.source, {
    weeklyBudget: options.weeklyBudget,
    planWeek: plan,
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

// Only when run as the binary: a test imports main() without starting a command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}