# PRD-034 — Personal Banked Resets (Read API and Dashboard)

**Status:** DONE
**Priority:** P2 — planned feature work; exposes expiring account-level banked resets (Claude and Codex) through Token Furnace's read API, CLI JSON, and dashboard UI.
**Complexity:** 7 (MEDIUM-HIGH); risk override: none (implementation files 11–20 = 3, new banked-resets read/cache module = 2, external API/RPC integration = 1, new stdio MCP subsystem = 1; strictly read-only, no new credential surface).
**Owner:** João
**Depends on:** None

## Context

Token Furnace currently shows **global** provider reset announcements from the public `agentresets.com/api/v1/resets.json` feed (`src/services/resets-client.ts`, `web/src/components/resets.tsx`), which includes public banked-reset announcements (`kind: "banked"`), but has no view of a user's **personal** banked resets (how many unused reset credits sit in the local account and when each one expires).

Live read-only verification on this machine established what each tracked provider exposes today:

1. **Codex (OpenAI) — Available via official local JSON-RPC (`codex app-server --stdio`):**
   - Sending JSON-RPC `initialize` → `initialized` → `account/rateLimits/read` (`codex-cli 0.172.0`, ~1.1 s round-trip) returns `rateLimitResetCredits`:
     - `availableCount: number`
     - `credits: Array<{ id, resetType, status, grantedAt, expiresAt, title, description }> | null` (timestamps in epoch seconds; `status` is `"available" | "redeeming" | "redeemed" | "unknown"`).
   - Reuses Codex's own auth and token refresh so Token Furnace never reads or transmits `~/.codex/auth.json` bearer tokens (matching the `agyWeek` pattern in `src/services/usage-client.ts`).
   - Note: `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` also returns the same credits directly, but `codex app-server --stdio` is preferred because it is Codex's own protocol and avoids direct token handling.
2. **Claude (Anthropic) — Available via existing OAuth usage read API:**
   - Token Furnace already calls `GET https://api.anthropic.com/api/oauth/usage` with the local OAuth token in `src/services/usage-client.ts`.
   - Appending `?cedar_ember=1&skip_spend=1` with `User-Agent: claude-cli/<installed-version> (external, cli)` returns `cedar_ember` in the same response (zero additional HTTP requests):
     - `eligible: boolean`, `ineligible_reason: string | null`, `next_grant_id: string | null`, `cooldown_until: string | null`
     - `grants: Array<{ id, label, resets_total, resets_left, starts_at, ends_at, clears, type, usable_now, paused, gives_back_weekly, unavailable_reason }>`
   - Without the `claude-cli/<version>` User-Agent, Anthropic returns `eligible: false, ineligible_reason: "surface", grants: []`. Because `cedar_ember` is an undocumented internal field, parsing must degrade gracefully without breaking `seven_day` quota readings.
3. **OpenCode Go (`opencode.ai/zen/go/v1/usage`) — Unsupported by provider:** returns only `{ usage: { rolling, weekly, monthly } }` with no banked reset concept.
4. **Antigravity / Google AI (`agy -p /usage`) — Unsupported by provider:** prints only weekly and 5-hour remaining percentages; Google issues global resets rather than user-banked resets.
5. **MCP availability:** Token Furnace had no MCP server (`src/server.ts` is an Express + `routing-controllers` loopback HTTP API), and neither Claude nor Codex exposes banked resets via an MCP server. This PRD now adds a stdio MCP surface, so an agent can read the same snapshot without the loopback HTTP API.

Relevant files inspected: `src/services/usage-client.ts`, `src/services/resets-client.ts`, `src/server.ts`, `src/cli.ts`, `src/core/model.ts`, `src/core/analyze/view.ts`, `src/services/report-service.ts`, `web/src/App.tsx`, `web/src/components/resets.tsx`, `web/src/components/panels.tsx`, `test/usage-client.test.ts`.

## Solution

Expose personal banked resets strictly **read-only** across four layers, matching existing `usage-client.ts` caching, `--no-plan-usage` / `--no-cache` flags, and loopback-only HTTP guarantees:

1. **Normalized model (`src/core/model.ts`):**
   - Add `BankedResetGrant` (`id`, `title`, `description`, `status`, `remaining`, `total`, `scope`, `grantedAt`, `expiresAt`, `next?`), `ProviderBankedResets` (`source`, `availableCount`, `nextExpiresAt`, `grants`, `fetchedAt`, `stale`, `state: "ok" | "no_login" | "unsupported" | "unavailable"`, `note?`), and `BankedResetsSnapshot` (`providers: Partial<Record<Source, ProviderBankedResets>>`, `fetchedAt`).
   - Add optional `bankedResets?: BankedResetsSnapshot` to `Report` (and `RawReport` / `ReportInput` / `ReportOptions`) so `GET /api/report`, `token-furnace --json`, and static `--html` snapshots carry the same normalized data.
2. **Provider read & cache layer (`src/services/usage-client.ts`, `src/services/banked-resets-client.ts`):**
   - **Claude:** Extend `fetchWeek` in `src/services/usage-client.ts` to request `https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1`, sending `User-Agent: claude-cli/<version> (external, cli)` using a once-per-process cached `claude --version` lookup (falling back cleanly if `claude` is absent). Persist the raw `cedar_ember` in `~/.cache/token-furnace/banked/claude-<hash of the Claude home>.json`, leaving `usage.json` exactly the shape a status line writes. Parse `cedar_ember` defensively into `ProviderBankedResets`; never break `planWeek` if `cedar_ember` is null, malformed, or ineligible.
   - **Codex:** Add `codexBankedResets(env, now, network)` in `src/services/banked-resets-client.ts`. If `CodexSource.base()` does not exist, return `state: "no_login"` without spawning a process. Otherwise cache in `~/.cache/token-furnace/banked/codex-<hash of base()>.json` (one file per home, 5-minute reuse window, 60-second retry backoff, in-flight dedup, honoring `TOKEN_FURNACE_NO_CACHE` and `network=false`). On refresh, spawn `codex app-server --stdio` (passing `CODEX_HOME` when set, 10 s timeout, unconditional child cleanup in `finally`), send `initialize` → `initialized` → `account/rateLimits/read`, validate `rateLimitResetCredits`, convert epoch seconds to ISO timestamps, and mark past-expiry credits as `"expired"`.
   - **OpenCode & Antigravity:** Report `state: "unsupported"` with zero I/O.
   - **Safety:** Never call any consumption/redemption endpoint (`account/rateLimitResetCredit/consume` or Anthropic reset-consume routes).
3. **Server read API & CLI (`src/server.ts`, `src/cli.ts`, `src/services/report-service.ts`, `src/core/analyze/view.ts`):**
   - Add `GET /api/banked-resets` (loopback-only via existing `LoopbackHostOnly`, `Cache-Control: no-store`): answers immediately from the saved/in-memory cache without blocking on subprocesses or network, and triggers a deduplicated background `setImmediate` refresh when `options.planUsage` is true.
   - Include cached `bankedResets` in `Report` (`GET /api/report`, `token-furnace --json`, and `--html` snapshots). Respect `--no-plan-usage` (cached-only, zero network/RPC) and `--no-cache` (no disk writes).
4. **Dashboard UI (`web/src/components/resets.tsx`, `web/src/components/panels.tsx`, `web/src/App.tsx`):**
   - **Resets tab:** Add a **"Your banked resets"** section above **"Global resets"** (keeping personal balances visually distinct from public `agentresets.com` history). Render one card per supported provider (`Claude Code`, `Codex`) showing available count, earliest expiry countdown (accent/warn highlight when expiring within 7 days), individual grant rows (title, scope tag, remaining/total if >1, granted & expiry dates, "Next" badge), stale/no-login/unavailable states, and a read-only note pointing to the provider's own UI/CLI to redeem. On `file://` snapshots, fall back to `report.bankedResets`.
   - **Dashboard tab:** Add a compact banked-resets summary link (`#resets`) inside the Weekly Quota card header (or alongside its reset info) when at least one provider has available banked resets, flagging soon-expiring grants (<= 7 days).

5. **MCP server (`src/mcp.ts`, `src/cli.ts`):**
   - `token-furnace mcp` serves MCP over stdio: `initialize` (echoing a revision it speaks, else its newest), `notifications/initialized` (no reply), `tools/list`, `tools/call`, `ping`; an unknown method gets `-32601` and an unknown tool `-32602`, and a line that is not JSON gets `-32700` without ending the loop.
   - One tool, `banked_resets`, with `annotations.readOnlyHint: true` and an empty argument schema. It answers exactly the `GET /api/banked-resets` snapshot as `structuredContent` plus the same JSON as text, so a client that only renders text loses nothing.
   - No new dependency: the transport is newline-delimited JSON-RPC on stdin/stdout, implemented in the repository. Stdout carries the protocol alone.

Consumer path:
- Live UI: Resets tab → `GET /api/banked-resets` (plus Dashboard → `GET /api/report`) → `bankedResetsSnapshot` → cached Claude `banked/claude-<hash>.json` + Codex `banked/codex-<hash>.json` (background-refreshed via `api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1` and `codex app-server --stdio`).
- Scripts / agents: `GET /api/banked-resets` or `token-furnace --json` (`report.bankedResets`).
- MCP clients: `token-furnace mcp` → tool `banked_resets` → `bankedResetsSnapshot(env, now, true)`.

### Key Risks & Mitigations
- **Anthropic `cedar_ember` schema or User-Agent gate changes:** Validated defensively; `seven_day` weekly quota parsing is completely isolated so a breaking `cedar_ember` change only flips Claude's banked-resets card to `unavailable` and never degrades weekly quota tracking.
- **Hanging `codex app-server` subprocess:** Hard 10 s timeout, single in-flight promise, and guaranteed `child.kill()` in `finally`.
- **Accidental reset redemption:** Strictly read-only endpoints/methods; no write route or consume RPC exists anywhere in the codebase.

## Non-Goals
- Redeeming or consuming banked resets from Token Furnace (always read-only).
- A lock across processes for the cache files. Each home has a file of its own, keyed by the resolved home path, written whole through a temp file and an atomic rename. A writer compares its instant against the file before publishing and skips the write when the file is ahead; that comparison and the rename are not one atomic step, so two processes publishing the same home within microseconds of each other can leave the older of the two. Both are whole snapshots of one account, each was true when it was read, and the next refresh (at most five minutes later) replaces it, so the effect is freshness, never a balance the account never had.
- Writing `usage.json` through a symlink. A link that points at a usage reading is still *read*, so a status line that keeps the file elsewhere keeps working, but every write replaces the name with a file of our own: deciding whether a link's target is "really" a usage reading cannot be done safely, and getting it wrong destroys someone else's file.
- Any MCP tool beyond `banked_resets`: the report, transcripts and config stay on the loopback API and the CLI. Add a tool when a consumer needs one.
- Changing what happens when the transcript window holds no turns. `buildReport` returns null there (`src/core/analyze/report.ts:289`), so `token-furnace --json`, `GET /api/report` and the served page answer "no transcripts" — the app's own transcript-first contract, unchanged by this PRD. The credits are read independently of any transcript, so in that state they stay reachable through `GET /api/banked-resets` and the MCP tool, which is where a consumer that has no transcripts can ask. Rendering a dashboard or a `Report` with no turns is a separate change with its own blast radius (text renderers, exit codes, goldens).
- Direct `chatgpt.com/backend-api/wham/rate-limit-reset-credits` HTTP polling using raw `~/.codex/auth.json` bearer tokens.
- Notification alerts for newly granted or soon-expiring banked resets (can be added as a follow-up condition in `src/services/notifications.ts`).
- Fake or inferred banked-reset balances for OpenCode Go or Antigravity, whose providers do not offer banked resets.

## Acceptance Criteria
- [x] AC-1 [local]: Claude banked resets are parsed from the single `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1` call, cached in a file of the Claude home's own (`banked/claude-<hash>.json`) that never touches `usage.json`, preserve `planWeek` when `cedar_ember` is absent/malformed/ineligible, and honor `network=false` and `--no-cache` — proof: `npx vitest run test/usage-client.test.ts test/banked-resets.test.ts` — 22 passed: the URL and `User-Agent: claude-cli/<version> (external, cli)` are asserted, one call fills the week and the credits together, an absent/malformed/ineligible `cedar_ember` still returns `used: 42` from `planWeek`, a grants list this code cannot read reports unavailable instead of zero, a call that stops carrying the field reports no credits instead of stamping the old ones fresh, a saved reading past the reuse window is `stale`, a `clears` list of poisoned keys cannot throw, `network=false` reads the file and fetches nothing, `--no-cache` writes neither file. Live: `node dist/cli.js --json` => `claude` state `ok`, `availableCount` 4, next expiry 2026-12-10.
- [x] AC-2 [local]: Codex banked resets are read via `codex app-server --stdio` (`account/rateLimits/read`), cached one file per Codex home (`banked/codex-<hash>.json`) with 5-minute reuse and 60-second failure backoff, mark past-expiry credits as expired, kill the child process on completion/timeout, skip spawning when `~/.codex` is absent, and never invoke any consume method — proof: `npx vitest run test/banked-resets.test.ts` — 48 passed: a real fake `codex` on PATH answers the newline-delimited JSON-RPC and its pid is gone afterwards, a child that never answers resolves null in 150 ms and its pid is gone, no Codex home means the runner is never called, the saved reading is reused inside 5 minutes and reread after, a failed read keeps the last credits and backs off 60 s, `network=false` and `--no-cache` write nothing, concurrent callers share one read, past-expiry epoch credits become `expired`, an answer whose `credits` is not a list is refused instead of zeroing the balance, a reading another process wrote after the first look is picked up, a failed read never overwrites a newer reading another process saved, a child that ignores SIGTERM is still gone after the timeout, a row without an id or a documented status is refused rather than counted, each Codex home gets its own cache file so two homes never share a reading, a corrupt timestamp cannot throw out of a snapshot, and a call that carries the credits but no week still saves both halves. No consume method exists anywhere in `src/`.
- [x] AC-3 [local]: `GET /api/banked-resets` answers non-blockingly from cache with `Cache-Control: no-store` behind `LoopbackHostOnly`, triggers background refresh only when `planUsage` is true, and `Report.bankedResets` is populated in both `GET /api/report` and `token-furnace --json` (respecting `--no-plan-usage` and `--no-cache`) — proof: `npx vitest run test/server.test.ts test/cli.test.ts test/progress.test.ts` — 35 passed: the route answers the saved reading before any fetch, a foreign Host gets 403, the first answer carries no credits and the next one does after one background fetch, `planUsage: false` makes zero fetch calls from either route, the credits route runs no provider usage command (a fake `agy` on PATH proves the report path still does), `/api/report` carries the same snapshot, and `--json` carries `report.bankedResets`. Live: `GET /api/banked-resets` => 200, `Cache-Control: no-store`, 3188-byte body; `--html` inlines `report.bankedResets`.
- [x] AC-4 [local]: The Resets tab renders "Your banked resets" above "Global resets" with per-provider available counts, individual grant expiry countdowns, <=7-day expiry warning highlight, stale/unavailable/no-login states, and static `file://` snapshot fallback; the Dashboard shows a compact banked-resets link to `#resets` when credits are available — proof: `npx vitest run web/src/resets-notifications.test.tsx web/src/app.test.tsx` — 54 passed: the personal section precedes the public feed in the DOM, both credit counts render one per provider, the 3-day credit carries `text-accent` and the 40-day one does not, `unavailable`/`no_login`/`no credits left`/expired-struck-through/stale states render their own words, a `file:` page renders `report.bankedResets` and fetches nothing, and the Dashboard links `#resets` only when a credit is held (accent when it lapses within a week).
- [x] AC-6 [local]: `token-furnace mcp` speaks MCP over stdio, lists one read-only tool `banked_resets`, answers it with the same snapshot as `GET /api/banked-resets`, answers every request by id, gives a notification no reply, and refuses an unknown method, an unknown tool and a line that is not JSON without ending the loop — proof: `npx vitest run test/mcp.test.ts test/cli.test.ts` — 39 passed: handshake with the client's own revision and a fallback, `ping`, `tools/list` with `readOnlyHint`, `tools/call` whose text equals its `structuredContent`, `-32601`/`-32602`/`-32700` with the right ids, a last line with no trailing newline, and no network call on a machine with no login. Live: a piped session answered `initialize`, `tools/list`, `tools/call` (Claude 4 credits, Codex 4) and both errors.
- [x] AC-5 [local]: Full repository typecheck, build, and test suite pass with zero regressions — proof: `npm run typecheck && npm run build && npx vitest run` — typecheck clean, build clean (353 kB single-file page), 36 files / 443 tests passed, repeated clean runs.

## Integration Ledger
| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Claude banked resets read | `GET /api/banked-resets` & `Report` → `usage-client.ts` (`refreshUsage` + `claudeBankedResets` + `parseCedarEmber`) | Extends the existing `/api/oauth/usage` call; `planWeek` keeps its week | AC-1, AC-3 |
| Codex banked resets read | `GET /api/banked-resets` & `Report` → `banked-resets-client.ts` → `codexAppServer` → `codex app-server --stdio` | New read-only RPC client | AC-2, AC-3 |
| Banked resets HTTP & CLI JSON API | Dashboard / scripts → `GET /api/banked-resets` (`src/server.ts`) & `token-furnace --json` (`src/cli.ts`) | New route + `Report.bankedResets` field | AC-3 |
| Banked resets over MCP | MCP client → `token-furnace mcp` (`src/mcp.ts`) → `banked_resets` tool | New stdio server, one read-only tool, same snapshot as the HTTP route | AC-6 |
| Personal banked resets UI | Resets tab (`web/src/components/resets.tsx`) & Dashboard (`web/src/components/panels.tsx`) | Extends existing tabs; Global resets preserved | AC-4 |

## Decisions
- 2026-11-27 (investigation): Use `codex app-server --stdio` (`account/rateLimits/read`) instead of direct `chatgpt.com/backend-api/wham/rate-limit-reset-credits` HTTP calls so Token Furnace never reads or transmits Codex bearer tokens and Codex handles OAuth refresh.
- 2026-11-27 (investigation): Piggyback Claude's `cedar_ember=1&skip_spend=1` onto the existing `api.anthropic.com/api/oauth/usage` request in `usage-client.ts` rather than adding a second Anthropic endpoint call, avoiding extra rate-limit pressure.
- 2026-11-27 (investigation): Expose banked resets via Token Furnace's loopback HTTP API (`GET /api/banked-resets`, `GET /api/report`) and `token-furnace --json` rather than introducing a new MCP server subsystem in this PRD.
- 2026-11-28 (design): each provider home caches its credits in a file of its own under `~/.cache/token-furnace/banked/`, named by a hash of the home, instead of sharing `usage.json` or one map file. Two homes can no longer touch the same file, `usage.json` keeps exactly the shape a status line writes, and a write is a whole-snapshot atomic rename rather than a merge.
- 2026-11-28 (scope change, João): the data must also be readable over MCP. Supersedes the MCP non-goal: `token-furnace mcp` is a stdio server (newline-delimited JSON-RPC, no new dependency) with the single read-only tool `banked_resets`. The HTTP route and the CLI JSON are unchanged and stay the cheaper path for scripts.

## Execution Phases

#### Phase 1: Banked resets read & cache service (Claude + Codex)
**Status:** DONE
**Files:** `src/core/model.ts`, `src/services/usage-client.ts`, `src/services/banked-resets-client.ts`, `test/usage-client.test.ts`, `test/banked-resets.test.ts`
**Implementation:**
- Add `BankedResetGrant`, `ProviderBankedResets`, and `BankedResetsSnapshot` types to `src/core/model.ts`.
- Extend `src/services/usage-client.ts` to append `?cedar_ember=1&skip_spend=1` and `User-Agent: claude-cli/<version> (external, cli)` (from cached `claude --version` when present), persist `cedar_ember` in the home's own file under `banked/`, and export a cached reader/parser for Claude banked resets. Update `test/usage-client.test.ts` URL assertion accordingly while preserving all existing cache/opt-out invariants.
- Create `src/services/banked-resets-client.ts` implementing `codexBankedResets` (spawning `codex app-server --stdio` through the injectable `codexAppServer` runner for deterministic tests, 10 s timeout, guaranteed kill, 5 min cache / 60 s backoff in `banked/codex-<hash>.json`, one file per home), explicit `"unsupported"` entries for `opencode` and `agy`, and unified `bankedResetsSnapshot(env, now, network)`. Claude's own reader (`claudeBankedResets` + `parseCedarEmber`) lives in `usage-client.ts`, where the cache file and the single usage call already are, so the credits reuse that call instead of a second copy of the gate.
- [x] Claude and Codex banked-resets clients parse, cache, expire, and degrade cleanly with zero network/subprocess side effects under `network=false` or missing installs — proof: `npx vitest run test/usage-client.test.ts test/banked-resets.test.ts` — covers AC-1, AC-2.

#### Phase 2: Server read API, Report integration, and CLI JSON
**Status:** DONE
**Files:** `src/server.ts`, `src/cli.ts`, `src/services/report-service.ts`, `src/core/analyze/report.ts`, `src/core/analyze/view.ts`, `test/server.test.ts`, `test/cli.test.ts`
**Implementation:**
- Add `GET /api/banked-resets` to `ReportController` in `src/server.ts`: reads cached `bankedResetsSnapshot(app.env, app.now(), false)`, returns JSON with `Cache-Control: no-store`, and schedules background refresh via `setImmediate` when `options.planUsage` is true (sharing the deduplicated refresh gate).
- Wire `bankedResets` through `ReportOptions` / `ReportInput` / `RawReport` / `reportView` into `Report.bankedResets` for both `server.ts` (cached read + background refresh) and `cli.ts` (`options.planUsage` gated).
- Add integration tests in `test/server.test.ts` (loopback check, non-blocking cached response, `--no-plan-usage` makes no refresh call) and `test/cli.test.ts` (`--json` includes `bankedResets`).
- [x] `GET /api/banked-resets`, `GET /api/report`, and `token-furnace --json` expose normalized banked resets and respect `--no-plan-usage` and `--no-cache` — proof: `npx vitest run test/server.test.ts test/cli.test.ts` — covers AC-3.

#### Phase 3: Resets tab and Dashboard UI
**Status:** DONE
**Files:** `web/src/components/resets.tsx`, `web/src/components/panels.tsx`, `web/src/App.tsx`, `web/src/resets-notifications.test.tsx`, `web/src/app.test.tsx`
**Implementation:**
- Pass `report?.bankedResets` into `<Resets />` from `web/src/App.tsx` as initial/snapshot data; on `http(s):` poll `GET /api/banked-resets` alongside `/api/resets` (5-minute interval).
- Render a **"Your banked resets"** section above **"Global resets"** in `web/src/components/resets.tsx` with per-provider cards (Claude Code, Codex): available count, earliest expiry countdown with <=7-day warning styling, individual grant rows (title, scope, remaining/total, granted/expires timestamps, next badge), stale/no-login/unavailable states, and a read-only redemption note.
- Add a compact banked-resets link (`#resets`) to the Weekly Quota card header in `web/src/components/panels.tsx` whenever `r.bankedResets` has available credits (highlighting if any expire within 7 days).
- Add UI tests covering populated credits, <=7-day warning, stale/unavailable states, `file://` snapshot fallback, and Dashboard link, then run the full repository verification gate.
- [x] Resets tab and Dashboard display personal banked resets accurately across live and snapshot modes, and the full repo check passes — proof: `npm run typecheck && npm run build && npx vitest run` — covers AC-4, AC-5.

#### Phase 4: MCP surface
**Status:** DONE
**Files:** `src/mcp.ts`, `src/cli.ts`, `test/mcp.test.ts`, `README.md`
**Implementation:**
- Add `src/mcp.ts`: `answer(message, env, now)` for one JSON-RPC message and `mcp(env, now, input, output)` for the stream, over the shared `bankedResetsSnapshot`, with no new dependency.
- Add the `mcp` command to `src/cli.ts` (no arguments; stdout carries the protocol alone) and list it in the usage text and the README.
- [x] The tool answers the same snapshot as the HTTP route and the loop is fault-tolerant — proof: `npx vitest run test/mcp.test.ts test/cli.test.ts` — covers AC-6.
