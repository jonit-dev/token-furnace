/** Data contracts shared by every layer. See docs/PRDs/active/npx-restructure/schema.md. */

export type Source = keyof typeof import("./providers").PROVIDERS;

/** What arrived before a turn: a human prompt, a teammate, a task, or a peer agent. */
export type Wake = "human" | "teammate" | "task" | "peer";

/** One normalized assistant turn. A source yields these and nothing else. */
export interface Turn {
  source: Source;
  project: string;
  /** Session id. */
  session: string;
  model: string;
  /** UTC. */
  when: Date;
  /** Uncached input tokens. */
  baseIn: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Tool names called in this turn. */
  tools: string[];
  /** Tool calls that read files or logs into the caller's own context. */
  reads: number;
  wakes: Wake[];
}

/** A transcript file that an agent can scan. */
export interface SourceFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** What one transcript file yields. Message text never survives the parse. */
export interface ParsedFile {
  turns: Turn[];
  /** Session title, Claude only. */
  title: string | null;
  /** Transcript lines that were not valid JSON. */
  badLines: number;
}

/** A leak priority and the word the page shows. burn.py:298 */
export type Level = "ok" | "warn" | "critical" | "info";
export type Priority = 1 | 2 | 3;

/** Wake counts, like Python's collections.Counter with only these keys. */
export interface WakeCounts {
  human: number;
  teammate: number;
  task: number;
  peer: number;
}

/** Where a transcript scan stands. Epoch milliseconds, because the scan is I/O and reads the clock. */
export interface ScanProgress {
  phase: "idle" | "scanning" | "ready";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
  updatedAt: number;
}

/** The subscription's or Codex's 7-day window, as burn.py's week dict. */
export interface Week {
  start: Date;
  resets: Date;
  /** Percent of the weekly limit already spent. */
  used: number;
  /** The plan's own meter over this week, oldest first: [epoch ms, percent]. Only OpenCode keeps one. */
  readings?: [number, number][];
}

/** One recommended setting, judged from the config on disk. burn.py:434 */
export interface ConfigNote {
  name: string;
  source: Source;
  value: string;
  target: string;
  ok: boolean;
  level: Level;
  ratio: number | null;
  /** The sentence the Checks table and the config leaks show. */
  line: string;
}

/** Everything the config checks read, passed in so the core stays free of I/O. */
export interface ConfigInput {
  /** CLAUDE_CONFIG_DIR, or ~/.claude. */
  claudeBase: string;
  /** ~/.claude as the user spells it, for the display path. */
  claudeHome: string;
  /** Raw settings.json text, or null when there is no file. */
  settings: string | null;
  /** Raw Codex config.toml text, or null when there is no file. */
  codexConfig: string | null;
  /** Every MEMORY.md under projects/, with the line count of each. */
  memoryIndexes: { path: string; lines: number }[];
  env: Record<string, string | undefined>;
}

/** One transcript file and what it yielded. */
export interface SessionInput {
  source: Source;
  path: string;
  mtimeMs: number;
  title: string | null;
  turns: Turn[];
}

/** Everything buildReport reads. burn.py's build_report moved its I/O out. */
export interface ReportInput {
  now: Date;
  days: number;
  /** Millions of weighted tokens, or null. */
  weeklyBudget: number | null;
  /** Agents whose directory exists, in source order. */
  live: Source[];
  sessions: SessionInput[];
  /** All available transcript activity, independent of the token-report window. */
  activity?: Iterable<ActivityTurn>;
  config: ConfigInput;
  planWeek: Week | null;
  codexWeek: Week | null;
  opencodeWeek?: Week | null;
  /** Last calibrated plan size in weighted tokens, per source: sizes a week with no local spend yet. */
  limits?: Partial<Record<Source, number>>;
}

export interface ActivityTurn {
  source: Source;
  project: string;
  session: string;
  at: number;
}

export interface AgentActivity {
  /** ISO sample time and concurrent active sessions, last 24 h. */
  timeline: [string, number][];
  peak7d: number;
  /** Peak across available local transcripts, not deleted history. */
  peakLifetime: number;
}

/** Aggregates for the last CHECK_HOURS, as one dict Python shares per source. */
export interface RawRecent {
  total: number;
  over: number;
  turns: number;
  contexts: number[];
  tool_calls: number;
  reads: number;
  wakes: WakeCounts;
  preambles: number[];
  cache_write: number;
  cache_input: number;
  top: number;
  sessions: number;
}

/** Tool calls and wake kinds over the whole window. */
export interface Totals {
  tool_calls: number;
  reads: number;
  human: number;
  teammate: number;
  task: number;
  peer: number;
}

export interface RawStats {
  cache_write: number;
  cache_input: number;
  turns: number;
  top: number;
}

export interface SessionRow {
  source: Source;
  project: string;
  id: string;
  fullId?: string;
  title: string | null;
  path: string | null;
  share: number;
  turns: number;
  peak: number;
  hours: number;
  flags: string[];
}

export interface SessionAgent {
  id: string;
  parentId: string | null;
  name?: string;
  role: "parent" | "subagent" | "unknown";
  model: string | null;
  lastSeen: string | null;
  active: boolean;
}

export interface ActiveSession {
  agents?: { members: SessionAgent[]; activeCount: number; complete: boolean };
  source: Source;
  project: string;
  id: string;
  fullId?: string;
  title: string | null;
  /** Transcript file of the session, when the source knows it. */
  path?: string | null;
  share: number;
  turns: number;
  peak: number;
  hours: number;
  context: number;
  /** Weighted tokens the latest turn cost; grows with context, so it says when to compact. */
  lastTurn: number;
  idle: number;
  flags: string[];
  model: string | null;
  rate: number;
  rateShare: number;
}

export interface HourSlot {
  bench: number;
  ctx: number[];
  ctxBySource: Partial<Record<Source, number[]>>;
  aboveTurns: number;
  reads: number;
  calls: number;
}

/** burn.py's week dict, before report_view renames its keys. */
export interface RawWeek {
  resets: Date;
  hours_left: number;
  used: number;
  /** Tokens per hour to the reset; null when the plan size is unknown and only the meter is read. */
  ideal: number | null;
  limit: number | null;
  start: Date;
  rate_pct: number;
  ideal_pct: number;
  burndown: [Date, number, number][];
  projection: { rate_pct: number; hours_to_empty: number | null; runs_out: Date | null };
  gains: Record<string, number>;
}

export interface RawBurn {
  rate: number;
  total: number;
  week: RawWeek | null;
  /** The plan reported a week below 1% used: too little to calibrate the plan limit. */
  pending?: { used: number; resets: Date };
}

export interface RawPerSource {
  recent: RawRecent;
  stats7: RawStats;
  totals: Totals;
  turns: number;
  total: number;
  over_target: number;
  session_count: number;
  hours24: number;
  hours_all: number;
  contexts: number[];
  preambles: number[];
  preamble: [number, number] | null;
}

export interface BaselineRow {
  name: string;
  now_24h: string;
  value_7d: string | null;
  target: string;
  ok: boolean;
  level: Level;
  ratio: number | null;
  advisory: boolean;
  source: Source;
}

/** The report dict burn.py builds, before report_view renames its keys. */
export interface RawReport {
  days: number;
  total: number;
  turns: number;
  session_count: number;
  sources: [Source, number][];
  /** [label, low edge in k, share %, turns, share within bucket above provider target] */
  buckets: [string, number, number, number, number][];
  over_target: number;
  /** [p50, p90, share of every token read] */
  preamble: [number, number, number] | null;
  projects: [string, number][];
  sessions: SessionRow[];
  recent_sessions: SessionRow[];
  recent: RawRecent;
  tools: [string, number][];
  config: string[];
  /** [share %, worst models] */
  unpriced: [number, [string, number][]] | null;
  active: ActiveSession[];
  /** Running headless agents the transcripts cannot show, per source. */
  unseenAgents?: Partial<Record<Source, number>>;
  agentActivity?: AgentActivity;
  /** [hour, [cool spend, hot spend]] */
  timeline: [Date, [number, number]][];
  project_count?: number;
  tool_calls?: number;
  timelines?: Partial<Record<Source, [Date, [number, number]][]>>;
  hourly: [Date, HourSlot][];
  bench_total: number;
  budget: number | null;
  stats7: RawStats;
  per_source: Partial<Record<Source, RawPerSource>>;
  baseline: BaselineRow[];
  burns: Partial<Record<Source, RawBurn>>;
}

/** The JSON the CLI, the server and the dashboard read. burn.py:1415 */
export interface Report {
  /** ISO time. */
  generated: string;
  days: number;
  /** Weighted tokens in the window. */
  total: number;
  sessions: number;
  turns: number;
  overTarget: number;
  burns: Partial<Record<Source, Burn>>;
  /** burns.claude, else the first burn. */
  burn: Burn | null;
  /** "Act now" lines for live sessions. */
  actions: string[];
  issues: Issue[];
  active: ActiveSession[];
  unseenAgents?: Partial<Record<Source, number>>;
  agentActivity?: AgentActivity;
  /** [hour end, actual, benchmark] */
  burndown: [string, number, number][];
  contextTargets: Record<Source, number>;
  budget: number | null;
  kpis: { name: string; unit: "k" | "%"; target: number; values: number[] }[];
  /** [hour, cool, hot] */
  timeline: [string, number, number][];
  projectCount?: number;
  toolCalls?: number;
  timelines?: Partial<Record<Source, [string, number, number][]>>;
  /** 24 */
  checkHours: number;
  baseline: BaselineRow[];
  topSessions: SessionRow[];
  buckets: { label: string; aboveTargetShare: number; share: number; turns: number }[];
  projects: [string, number][];
  config: string[];
  tools: [string, number][];
  /** [share %, worst models] */
  unpriced: [number, [string, number][]] | null;
}

/** One ranked leak or config problem, before report_view turns it into an Issue. */
export interface RawIssue {
  title: string;
  fix: string;
  why: string;
  action: string;
  /** A flag prefix, or the config title. */
  kind: string;
  source: Source | "all" | null;
  share: number | null;
  /** The sessions and flags that hit it. */
  hits: [SessionRow, string][];
  priority: Priority;
}

export interface Issue {
  title: string;
  fix: string;
  priority: Priority;
  level: Level;
  source: Source | "all" | null;
  share: number | null;
  sessions: number;
  /** The copy-to-Claude prompt. */
  prompt: string;
}

export interface Burn {
  rate: number;
  goal: number | null;
  basis: string;
  resets: string | null;
  hoursLeft: number | null;
  used: number | null;
  gains: Record<string, number> | null;
  limit: number | null;
  ratePct: number | null;
  idealPct: number | null;
  start: string | null;
  weekBurndown: [string, number, number][] | null;
  projection: { ratePct: number; hoursToEmpty: number | null; runsOut: string | null } | null;
  pending?: { used: number; resets: string } | null;
}
