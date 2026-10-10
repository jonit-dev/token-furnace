import { existsSync } from "node:fs";
import { buildReport } from "../core/analyze/report";
import { reportView } from "../core/analyze/view";
import type { ConfigInput, RawReport, Report, ScanProgress, Source, Week } from "../core/model";
import type { SessionRepository } from "../repo/session-repo";
import type { AgentSource, Env } from "../sources/agent-source";

export interface ReportOptions {
  /** Millions of weighted tokens, or null. */
  weeklyBudget: number | null;
  /** The subscription window, read by the caller: the saved reading, refreshed from the network when a login exists. */
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

  /** Where the scan stands. `/api/status` and the CLI read it. */
  progress: ScanProgress = { phase: "idle", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, startedAt: 0, updatedAt: 0 };

  /** True once one full scan has finished: from then on a report is always there to serve. */
  hasScanned = false;

  private inflight: Promise<void> | null = null;

  /** Each path's place in the sources' own file order, so scanning newest first changes no report. */
  private order = new Map<string, number>();

  /**
   * Parse every file whose mtime or size changed since the last scan, newest first. It yields to
   * the event loop between files, so a server keeps answering during a cold scan of gigabytes.
   * Overlapping calls share one scan.
   */
  refresh(onProgress?: (progress: ScanProgress) => void): Promise<void> {
    this.inflight ??= this.scan(onProgress).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async scan(onProgress?: (progress: ScanProgress) => void): Promise<void> {
    const live = this.sources.filter((agent) => existsSync(agent.root())); // not installed
    const files = live.flatMap((source) => source.files().map((file) => ({ source, file })));
    this.order = new Map(files.map(({ file }, index) => [file.path, index]));
    const changed = new Set(this.repo.changed(files.map(({ file }) => file)).map((file) => file.path));
    const todo = files.filter(({ file }) => changed.has(file.path)).sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
    const progress = this.progress;
    Object.assign(progress, {
      phase: "scanning",
      filesDone: 0,
      filesTotal: todo.length,
      bytesDone: 0,
      bytesTotal: todo.reduce((sum, { file }) => sum + file.size, 0),
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    let lastYield = Date.now();
    try {
      for (const { source, file } of todo) {
        const parsed = source.parse(file.path);
        this.repo.save(
          { source: source.name, path: file.path, mtimeMs: file.mtimeMs, title: parsed.title, turns: parsed.turns },
          file.size,
        );
        progress.filesDone += 1;
        progress.bytesDone += file.size;
        if (Date.now() - lastYield >= 50) {
          progress.updatedAt = Date.now();
          onProgress?.(progress);
          await new Promise<void>((next) => setImmediate(next)); // let requests through
          lastYield = Date.now();
        }
      }
    } finally {
      progress.phase = "ready";
      progress.updatedAt = Date.now();
      this.hasScanned = true;
      onProgress?.(progress);
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
      sessions: this.repo
        .all()
        .sort((a, b) => (this.order.get(a.path) ?? Infinity) - (this.order.get(b.path) ?? Infinity)),
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