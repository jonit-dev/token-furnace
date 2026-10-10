import { existsSync } from "node:fs";
import { buildReport } from "../core/analyze/report";
import { reportView } from "../core/analyze/view";
import type { ConfigInput, ParsedFile, RawReport, Report, ScanProgress, Source, Week } from "../core/model";
import type { SessionRepository } from "../repo/session-repo";
import { ParsePool } from "./parse-pool";
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
    /** The built worker script and how many threads parse. Null parses on the main thread. */
    private readonly workers: { url: URL; size: number } | null = null,
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
    const save = (item: (typeof todo)[number], parsed: ParsedFile): void => {
      this.repo.save(
        { source: item.source.name, path: item.file.path, mtimeMs: item.file.mtimeMs, title: parsed.title, turns: parsed.turns },
        item.file.size,
      );
    };
    const done = (item: (typeof todo)[number]): void => {
      progress.filesDone += 1;
      progress.bytesDone += item.file.size;
      progress.updatedAt = Date.now();
      onProgress?.(progress);
    };

    const poolSize = this.workers && todo.length ? Math.min(this.workers.size, todo.length) : 0;
    const pool = poolSize >= 1 ? new ParsePool(this.workers!.url, this.env, poolSize) : null;
    try {
      if (pool) {
        // One lane per worker: each takes the next file, newest first, as soon as it is free.
        let next = 0;
        const lane = async (index: number): Promise<void> => {
          while (next < todo.length) {
            const item = todo[next++];
            let parsed: ParsedFile;
            try {
              parsed = await pool.parse(index, item.source.name, item.file.path);
            } catch {
              // Fall back to in-process parsing if the worker fails or crashes
              parsed = item.source.parse(item.file.path);
            }
            save(item, parsed);
            done(item);
          }
        };
        await Promise.all(Array.from({ length: poolSize }, (_, index) => lane(index)));
      } else {
        let lastYield = Date.now();
        for (const item of todo) {
          save(item, item.source.parse(item.file.path));
          done(item);
          if (Date.now() - lastYield >= 25) {
            await new Promise<void>((next) => setImmediate(next)); // let requests through
            lastYield = Date.now();
          }
        }
      }
    } finally {
      await pool?.close();
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
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    return buildReport({
      now,
      days,
      weeklyBudget: opts.weeklyBudget,
      live,
      sessions: this.repo
        .all(cutoff)
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
