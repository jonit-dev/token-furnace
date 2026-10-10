import { existsSync } from "node:fs";
import { buildReport } from "../core/analyze/report";
import { reportView } from "../core/analyze/view";
import type { ConfigInput, RawReport, Report, Source, Week } from "../core/model";
import type { SessionRepository } from "../repo/session-repo";
import type { AgentSource, Env } from "../sources/agent-source";

export interface ReportOptions {
  /** Millions of weighted tokens, or null. */
  weeklyBudget: number | null;
  /** The subscription window, read by the caller. Only --plan-usage asks for it. */
  planWeek?: Week | null;
  /** The clock. Defaults to now, so a test can freeze it. */
  now?: Date;
}

/**
 * The report over the sources and the repository. Everything the pure buildReport needs arrives
 * in its input, so this class only reads files and hands the contents over. burn.py's build_report
 * and report_view, split at the I/O boundary.
 */
export class ReportService {
  constructor(
    private readonly sources: AgentSource[],
    private readonly repo: SessionRepository,
    private readonly env: Env,
  ) {}

  /** Parse every file whose mtime or size changed since the last scan, one file at a time. */
  refresh(): void {
    const live = this.sources.filter((agent) => existsSync(agent.root())); // not installed
    const files = live.flatMap((source) => source.files().map((file) => ({ source, file })));
    const changed = new Set(this.repo.changed(files.map(({ file }) => file)).map((file) => file.path));
    for (const { source, file } of files) {
      if (!changed.has(file.path)) continue;
      const parsed = source.parse(file.path);
      this.repo.save(
        {
          source: source.name,
          path: file.path,
          mtimeMs: file.mtimeMs,
          title: parsed.title,
          turns: parsed.turns,
        },
        file.size,
      );
    }
  }

  /** The agents to scan: the ones installed, in source order. burn.py:289 */
  live(source: Source | "all"): Source[] {
    return this.sources
      .filter((agent) => (source === "all" || source === agent.name) && existsSync(agent.root()))
      .map((agent) => agent.name);
  }

  /** The raw report, which the text renderers read with burn.py's own key names. */
  getRaw(days: number, source: Source | "all", opts: ReportOptions): RawReport | null {
    const now = opts.now ?? new Date();
    const live = this.live(source);
    if (!live.length) return null;
    return buildReport({
      now,
      days,
      weeklyBudget: opts.weeklyBudget,
      live,
      sessions: this.repo.all(),
      config: this.readConfig(live),
      planWeek: opts.planWeek ?? null,
      codexWeek: live.includes("codex") ? (this.sources.find((s) => s.name === "codex")?.week?.(now) ?? null) : null,
    });
  }

  /** The Report JSON: /api/report, --json and the inlined --html page all read this. */
  getReport(days: number, source: Source | "all", opts: ReportOptions): Report | null {
    const now = opts.now ?? new Date();
    const raw = this.getRaw(days, source, { ...opts, now });
    return raw ? reportView(raw, now) : null;
  }

  /** Every config file the checks read, through the agent that owns it. */
  private readConfig(live: Source[]): ConfigInput {
    const claude = this.sources.find((s) => s.name === "claude");
    const codex = this.sources.find((s) => s.name === "codex");
    return {
      claudeBase: claude?.base() ?? "",
      claudeHome: claude?.home() ?? "",
      settings: claude?.readFile("settings.json") ?? null,
      codexConfig: codex?.readFile("config.toml") ?? null,
      memoryIndexes: live.includes("claude") ? (claude?.memoryIndexes?.() ?? []) : [],
      env: this.env,
    };
  }
}