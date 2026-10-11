# PRD-023 — Resets and Notifications tabs

**Status:** DONE
**Layout revision verification:** 233 tests passed across 25 files; typecheck, build and package smoke passed on Node v24.16.0. Live desktop (1330 px) shows two cards in one row; mobile (390 px) stacks without horizontal overflow; Enter opens and closes history. Notification delivery remains mocked.
**Priority:** P2 — planned feature work; the two tabs and the alert loop are the whole unfinished scope, and both are now implemented and verified locally.
**Complexity:** 7 → HIGH (7 implementation files = 2, a new notifications subsystem = 2, retry/dedup state plus a background loop = 2, external API integration = 1); risk override: credentials and a same-origin write boundary raise the mode to HIGH.
**Final verification:** Main checkout: `npx vitest run` 25 files / 232 tests passed; `npm run typecheck` and `npm run build` exit 0 (Node v24.16.0). Browser: live feed returned fresh Codex and Claude data; both setup modals opened and closed with Escape; navigation fits at 390 px after wrapping. Real channel delivery was mocked. Run: `node dist/cli.js serve` with Node >=22.13.
**Final fixes:** per-channel catch in `deliver` with sanitized `could not be reached`, no `useSettings`/`postTo` global; upcoming expiry parses after `upcoming:<product>:` plus drops cancelled schedules and honours toggles on retries; usage arm mutates only when enabled; `notifyTick(app, planUsage=true)` wired to the server timer so `--no-plan-usage` never fetches quota; setup modals quote the Telegram URL, require a unique ntfy topic, and name the master switch; one nested settings schema.
**Owner:** João
**Lane:** `.worktrees/resets-notifications`, branch `feat/resets-notifications`, base `3061f0b`. Feature integrated into the main checkout with unrelated edits preserved. João authorized cleanup; the 3.4 MB temporary worktree and its registration were removed after verifying all feature files were preserved. Branch retained.
**Depends on:** None

## Context
The dashboard reported local token burn and subscription weeks but had no view of vendor reset
announcements and no way to be told about them. `src/services/usage-client.ts` already fetched a
subscription week with a 5 minute shared cache, and `src/server.ts` already owned the loopback host
check, so the new work followed both patterns instead of inventing new ones.

## Solution
- `src/services/resets-client.ts`: the agentresets.com JSON feed, validated field by field, fetched
  at most once per 5 minutes for the whole process. A failed fetch keeps the last good feed and
  reports `stale`.
- `src/services/notifications.ts`: settings in the user config directory (atomic write, mode 0600),
  the two channels (ntfy, Telegram bot), the three conditions, and the seen/delivered markers in the
  cache directory so a restart does not re-announce history.
- `src/server.ts`: `GET /api/resets`, `GET/POST /api/notifications`, `POST /api/notifications/test`,
  plus a 60 second server-side tick (overlap guarded, cleared on close) that runs the conditions with
  no browser tab involved.
- `web/src/components/{resets,notifications}.tsx`: the two tabs, dark UI, house `Card` and `Icon`,
  labelled inputs, live-region status, loading and error states. Each channel card has a Setup
  instructions button opening the house `Modal`: ntfy in 4 steps (app from ntfy.sh, private topic,
  full endpoint equivalent, authenticated topic for sensitive alerts, save/test), Telegram in 4
  steps (verified @BotFather /newbot, Start plus getUpdates chat id with placeholders only,
  paste id/token, save/test). No saved token is interpolated into examples or links.

Consumer path: dashboard tab → `GET /api/resets` → validated snapshot → Resets tab. Server tick →
`runAlerts` → ntfy/Telegram. Settings tab → `POST /api/notifications` → `notifications.json` at 0600 →
next tick reads it.

## Acceptance Criteria
- [x] AC-1 [local]: `GET /api/resets` answers with a validated snapshot and one fetch for many requests, keeping the last feed when a refresh fails; out-of-range probabilities stay null (unknown), and failed refreshes back off at the 5 minute cache window. proof: `npx vitest run test/resets-notifications.test.ts` — "fetches once, validates, and keeps the old feed when a later fetch fails", "serves the reset feed and never calls out on its own per request".
- [x] AC-2 [local]: The Resets tab shows an exact time only from an `announced` schedule, otherwise "No reset time announced", the 24 h/48 h/7 d probabilities labelled as global estimates (unknown renders as —), recent history, and http(s)-validated source and attribution links. proof: `npx vitest run web/src/resets-notifications.test.tsx` — 7 passed; "shows the announced times, the labelled probabilities, and the source link".
- [x] AC-3 [local]: Settings save to `notifications.json` with mode 0600, survive a restart, are redacted in every GET, keep a saved token when the field is blank, and are removed only on request. proof: same two runs — "keeps a saved secret when the field is blank, removes it on request, and never returns one", "saves settings on disk at 0600, redacts them, and refuses a cross-site write".
- [x] AC-4 [local]: The three conditions fire on a fresh feed only: new announcements (baseline on the first feed), announced times inside the lead window (guarded by the upcoming switch, certainty announced, expired schedules dropped), and a per-provider usage crossing that re-arms below the threshold. A feed whose generated_at is over 24 h old is not news. proof: `test/resets-notifications.test.ts` — "baselines the first feed…", "alerts an announced time inside the lead window…", "keeps nested enable flags across a restart and guards the upcoming condition", "arms usage per provider…", "fires the usage threshold on the crossing and re-arms below it", "skips a stale feed…".
- [x] AC-5 [local]: A channel that delivered is never sent again (retries pass the due list); a channel that failed retries on the next tick with a bounded backoff and keeps its terminal count after three tries; skipped sends are reported, never stored; pending markers are bounded (50) and survive a restart. proof: `test/resets-notifications.test.ts` — "keeps a failed channel on a bounded retry and never re-sends the one that worked", "publishes ntfy as plain text with a Title header, never a JSON body", "carries the seen and delivered markers across a restart".
- [x] AC-6 [local]: The conditions run from the server loop, not from a request; a disabled master switch skips polling entirely; utilization is the week.used percent the report shows, read fresh per provider (Claude/OpenCode weeks plus the Codex rate-limit week); a write or a test send from a foreign origin or cross-site fetch is refused; an empty test reports no enabled channel rather than a delivery. proof: `test/resets-notifications.test.ts` — "runs the notification conditions from the server loop, not from a request" (403 on `Sec-Fetch-Site: cross-site` and on a foreign `Origin` in the save test).
- [x] AC-7 [local]: The Notifications tab saves settings (one nested schema end to end), shows why a save was refused, retries after a failed load, states the per-channel result of a test send without echoing a token or a URL, and opens/closes each channel setup modal. proof: `web/src/resets-notifications.test.tsx` — 7 passed; "saves the settings and reports the result", "shows why a save was refused", "reports the channels the test send used", "opens and closes each channel setup modal".
- [x] AC-8 [local]: The whole repository still passes: `npm run typecheck` exit 0, `npm run build` exit 0, `npx vitest run` 25 files / 232 tests passed on Node v24.16.0 in the main checkout after integration.

## Integration Ledger
| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Reset feed read | Dashboard Resets tab → `GET /api/resets` (`src/server.ts`) | new | AC-1, AC-2 |
| Reset announcements | Server tick → `runAlerts` (`src/services/notifications.ts`) | new | AC-4 |
| Upcoming announced reset alert | Server tick → lead-window condition | new | AC-4 |
| Usage threshold alert | Server tick → provider subscription week readings | new | AC-4 |
| Notification settings | Notifications tab → `POST /api/notifications` | new | AC-3, AC-7 |
| Test notification | Notifications tab → `POST /api/notifications/test` | new | AC-6 |

## Decisions
- 2026-10-10 (agent): keep the alert state in the cache directory next to `usage.json`, not in the
  config file, so the settings file stays readable by the user.
- 2026-10-10 (agent): an injected sender bypasses the `NODE_ENV=test` send guard; only the built-in
  sender is withheld, so a test can drive both channels and a test run still reaches no network.
- 2026-10-10 (agent): no generic webhook channel. ntfy and Telegram cover the selected conditions.
- 2026-10-11 (agent): the tick reads each provider week directly (same percent the report shows) so a quiet transcript window cannot zero utilization; Codex counts via its logged rate-limit week.

## Execution Phases
#### Phase 1: Reset feed, conditions, routes, and both tabs
**Status:** DONE
**Files:** `src/services/resets-client.ts`, `src/services/notifications.ts`, `src/server.ts`, `web/src/store.ts`, `web/src/App.tsx`, `web/src/components/resets.tsx`, `web/src/components/notifications.tsx`, `test/resets-notifications.test.ts`, `web/src/resets-notifications.test.tsx`.
**Verification:** `npm run typecheck`, `npx vitest run test/resets-notifications.test.ts`, `npx vitest run web/src/resets-notifications.test.tsx`, `npm run build`, `npx vitest run` — all green on node v24.16.0 (the repo needs node >= 22.13 for `node:sqlite`; the default node 20 on PATH cannot run any test).


## Resets layout revision — 2026-10-10
Complexity: 1 → LOW; risk override: none. Same tab, feed and refresh path; only presentation changes. Work directly in the existing checkout to preserve the uncommitted feature integration.

- [x] AC-9 [local]: Provider status precedes compact probability rows; announcements are collapsed, expand accessibly, and retain full text. Proof: `npx vitest run web/src/resets-notifications.test.tsx` plus desktop/mobile browser check.
- [x] AC-10 [local]: Loading/errors, announced schedule, unknown estimates and validated links still work. Proof: targeted UI tests, `npm run typecheck`, `npm run build`.

#### Phase 2: Simplify the Resets page
**Status:** DONE
**Files:** `web/src/components/resets.tsx`, `web/src/resets-notifications.test.tsx`.
**Implementation:** Two provider summaries side by side on desktop, stacked on mobile; status first, unboxed estimates second, native disclosure for history. Reuse house Card and palette. Keep all API and notification behavior.
