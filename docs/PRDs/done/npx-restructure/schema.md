# Data contracts and cache schema — npx restructure

**Status:** IMPLEMENTED — archived; npm publish pending the package owner.
**Date:** 2026-10-09

All types live in `src/core/model.ts`. The server and `web/` import the same `Report` type. The Python names are in brackets where they differ.

## Turn

One normalized assistant turn. Every `AgentSource` yields these and nothing else. Python: `turn()` in `scripts/burn.py:81`.

```ts
type Wake = "human" | "teammate" | "task" | "peer";

interface Turn {
  source: "claude" | "codex";   // new: Python keyed this by the SOURCES dict
  project: string;
  session: string;              // session id
  model: string;
  when: Date;                   // UTC
  baseIn: number;               // [base_in] uncached input tokens
  cacheRead: number;            // [cache_read]
  cacheWrite: number;           // [cache_write]
  output: number;
  tools: string[];              // tool names called in this turn
  reads: number;                // tool calls that read files or logs into the caller's context
  wakes: Wake[];                // what arrived before this turn
}
```

Rules:

- `reads` counts `Read`, `Grep`, `Glob`, and shell commands that match `READ_COMMAND` (`burn.py:96`).
- Context size of a turn is `baseIn + cacheRead + cacheWrite`.
- A turn never holds message text. `classify_prompt()` turns user text into a `Wake` in the source, then the text is dropped.

## Session title

`ClaudeSource.title(path)` returns the session title or `null` (`claude_title()`, `burn.py:141`). The title is the only text value that comes from a transcript. It is display text, never a prompt.

## Report

`Report` is the exact JSON that `report_view()` returns today (`burn.py:1415`). It is the contract for `/api/report`, `--json`, the inlined `--html` page, and the React dashboard. Keep the key names as they are, including the mixed `snake_case` keys, so the old `dashboard.html` keeps working during PRD-003.

```ts
interface Report {
  generated: string;            // ISO time
  days: number;
  total: number;                // weighted tokens in the window
  sessions: number;
  turns: number;
  over300k: number;
  burns: Record<Source, Burn>;
  burn: Burn | null;            // burns.claude, else the first burn
  actions: string[];            // "Act now" lines for live sessions
  issues: Issue[];              // ranked leaks
  active: ActiveSession[];
  burndown: [string, number, number][];   // [hour end, actual, benchmark]
  benchWindow: number;          // 200_000
  budget: unknown;              // passthrough of r["budget"]
  kpis: { name: string; unit: "k" | "%"; target: number; values: number[] }[];
  timeline: [string, number, number][];   // [hour, cool, hot]
  checkHours: number;           // 24
  baseline: unknown;            // passthrough of baseline(r)
  topSessions: unknown[];       // passthrough of r["sessions"]
  buckets: { label: string; hot: boolean; share: number; turns: number }[];
  projects: unknown[];
  config: unknown[];            // config check rows
  tools: unknown[];
  unpriced: unknown;
}

interface Issue {
  title: string; fix: string;
  priority: 1 | 2 | 3; level: "critical" | "warn" | "info";
  source: Source | null; share: number; sessions: number;
  prompt: string;               // the copy-to-Claude prompt
}

interface Burn {
  rate: number; goal: number | null; basis: string;
  resets: string | null; hoursLeft: number | null; used: number | null;
  gains: unknown; limit: number | null; ratePct: number | null; idealPct: number | null;
  start: string | null; weekBurndown: [string, number, number][] | null;
  projection: { ratePct: number; hoursToEmpty: number | null; runsOut: string | null } | null;
}
```

PRD-002 replaces each `unknown` with the exact type it finds while it ports `build_report()` (`burn.py:527`). The parity test proves the shape, so the sketch here does not need to be complete.

## SQLite cache (PRD-004)

File: `${XDG_CACHE_HOME:-~/.cache}/token-furnace/cache.sqlite`. The cache is disposable. Delete the file and the next run rebuilds it.

```sql
PRAGMA user_version = 1;          -- schema version; on mismatch, drop all tables and rebuild

CREATE TABLE files (
  path        TEXT PRIMARY KEY,
  source      TEXT NOT NULL,       -- 'claude' | 'codex'
  mtime_ns    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  title       TEXT,                -- session title, Claude only
  bad_lines   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE turns (
  path        TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,    -- turn order inside the file
  project     TEXT NOT NULL,
  session     TEXT NOT NULL,
  model       TEXT NOT NULL,
  at          INTEGER NOT NULL,    -- epoch ms, UTC
  base_in     INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  tools       TEXT NOT NULL,       -- JSON array of tool names
  reads       INTEGER NOT NULL,
  wakes       TEXT NOT NULL,       -- JSON array of Wake
  PRIMARY KEY (path, seq)
);
CREATE INDEX turns_at ON turns(at);
```

Rules:

- A file is reparsed when its `mtime_ns` or `size` differs. This is the same key as `cached()` in `burn.py:516`. Reparse deletes the old rows of that file first.
- A file that is gone from disk is deleted from `files`, and its turns cascade.
- No column holds message text.
