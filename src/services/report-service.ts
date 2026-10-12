import type { Headless } from "./processes";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { usageCachePath } from "./usage-client";
import { buildReport } from "../core/analyze/report";
import { reportView } from "../core/analyze/view";
import type { ConfigInput, ParsedFile, RawReport, Report, ScanProgress, SessionInput, Source, Week } from "../core/model";
import type { SessionRepository } from "../repo/session-repo";
import { SessionAgents } from "./session-agents";
import { ParsePool } from "./parse-pool";
import type { AgentSource, Env } from "../sources/agent-source";

export interface ReportOptions {
  /** Millions of weighted tokens, or null. */
  weeklyBudget: number | null;
  /** The subscription window, read by the caller: the saved reading, refreshed from the network when a login exists. */
  planWeek?: Week | null;
  opencodeWeek?: Week | null;
  /** Plan sizes to use for a week with no local spend; the remembered ones fill the rest. */
  limits?: Partial<Record<Source, number>>;
  /** Headless agent runs from the process table, when the caller probed it. */
  headless?: Headless;
  /** The clock. Defaults to now, so a test can freeze it. */
  now?: Date;
}

/**
 * The report over the sources and the repository. Everything the pure buildReport needs arrives
 * in its input, so this class only reads files and hands the contents over. burn.py's build_report
 * and report_view, split at the I/O boundary.
 */
export class ReportService {
  private readonly sessionAgents = new SessionAgents();
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

    // Load native session metadata once per report, without mutating cached session titles
    const metadataBySource = new Map<Source, Map<string, string>>();
    for (const agent of this.sources) {
      if (live.includes(agent.name) && agent.sessionMetadata) {
        metadataBySource.set(agent.name, agent.sessionMetadata());
      }
    }

    const rawSessions = this.repo
      .all(cutoff)
      .sort((a, b) => (this.order.get(a.path) ?? Infinity) - (this.order.get(b.path) ?? Infinity));

    const sessions = rawSessions.map((s) => {
      const meta = metadataBySource.get(s.source);
      const fullId = fullSessionId(s);
      const title = fullId ? meta?.get(fullId) : undefined;
      return title ? { ...s, title } : s;
    });

    const report = buildReport({
      now,
      days,
      weeklyBudget: opts.weeklyBudget,
      live,
      sessions,
      activity: this.repo.activity(),
      config: this.readConfig(live),
      planWeek: opts.planWeek ?? null,
      opencodeWeek: opts.opencodeWeek ?? null,
      limits: { ...this.readLimits(), ...opts.limits },
      codexWeek: live.includes("codex") ? (this.sources.find((s) => s.name === "codex")?.week?.(now) ?? null) : null,
    });
    if (report) this.sessionAgents.enrich(report.active, sessions, this.sources, now);
    if (report) this.rememberLimits(report);
    if (report && opts.headless) report.unseenAgents = unseen(opts.headless, report.active);
    return report;
  }

  /** The Report JSON: /api/report, --json and the inlined --html page all read this. */
  getReport(days: number, source: Source | "all", opts: ReportOptions): Report | null {
    const now = opts.now ?? new Date();
    const raw = this.getRaw(days, source, { ...opts, now });
    return raw ? reportView(raw, now) : null;
  }

  private limitsPath(): string {
    return join(dirname(usageCachePath(this.env)), "limits.json");
  }

  /** The plan sizes last calibrated on this machine. A missing, corrupt or nonsense file reads as none. */
  private readLimits(): Partial<Record<Source, number>> {
    try {
      const saved = JSON.parse(readFileSync(this.limitsPath(), "utf8"));
      const out: Partial<Record<Source, number>> = {};
      for (const source of ["claude", "codex", "opencode"] as const) {
        const value = saved?.[source];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) out[source] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Saves a calibrated plan size when it is more than 2% larger, so a week with unseen spend cannot shrink it. */
  private rememberLimits(report: RawReport): void {
    if (this.env.TOKEN_FURNACE_NO_CACHE && this.env.TOKEN_FURNACE_NO_CACHE !== "0") return;
    const stored = this.readLimits();
    const next = { ...stored };
    for (const source of ["claude", "codex", "opencode"] as const) {
      const week = report.burns[source]?.week;
      const size = week?.limit ?? 0;
      if (!(size > 0)) continue; // a week sized from the stored limit equals it: no write
      const old = stored[source];
      if (!old || size > old * 1.02) next[source] = size; // raise only: delete the file to resize down
    }
    if (JSON.stringify(next) === JSON.stringify(stored)) return;
    try {
      mkdirSync(dirname(this.limitsPath()), { recursive: true });
      writeFileSync(this.limitsPath(), JSON.stringify(next));
    } catch { /* A cache we cannot write is a slow run, not a wrong one. */ }
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

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The full session UUID for a native index lookup. Older cache entries may contain a short ID,
 * so the rollout filename remains a fallback. A short prefix never matches.
 */
function fullSessionId(session: SessionInput): string | null {
  const turn = session.turns[0]?.session ?? "";
  if (UUID_ONLY.test(turn)) return turn;
  const match = UUID_ANY.exec(session.path);
  return match ? match[0] : null;
}

/** Hidden runs always add. Visible ones add only past the sessions the transcripts already show. */
function unseen(found: Headless, active: { source: Source }[]): Partial<Record<Source, number>> {
  const out: Partial<Record<Source, number>> = {};
  for (const source of ["claude", "codex", "opencode"] as const) {
    const seen = active.filter((a) => a.source === source).length;
    const extra = (found.hidden[source] ?? 0) + Math.max((found.visible[source] ?? 0) - seen, 0);
    if (extra) out[source] = extra;
  }
  return out;
}
