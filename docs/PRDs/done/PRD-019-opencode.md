# PRD-019 — OpenCode and Go subscription support

**Closed:** 2026-10-10 at `c15d400`, archived to `done/`.

**Status:** DONE — 2026-10-10. Every phase and acceptance box verified.
**Complexity:** 5 → MEDIUM; risk override: none
**Owner:** Codex
**Progress:** 100% — all phases and acceptance criteria verified.

## Scope and design
Read the locally installed OpenCode SQLite store through the existing AgentSource interface. Register OpenCode alongside Claude/Codex for CLI, worker parsing, cache, report and dashboard. Use session identities as virtual source paths and session/message/part update times for incremental invalidation. Read only normalized metadata and tool calls; never retain message bodies or credentials. Use the authenticated Go usage endpoint for the actual weekly percentage and reset, preserving existing no-network/no-cache controls. Existing weighted-token calibration is an estimate, not provider billing. Unknown models retain the existing unpriced warning. OpenCode context target: 128k, a diagnostic heuristic rather than a model context limit.

Existing user scope authorizes implementation on develop. No new worktree or external publication. Preserve the untracked PRD-018. No OpenCode configuration repairs or legacy JSON storage support in this change.

## Acceptance criteria
- [x] AC-1 [local, Codex]: Real SQLite assistant usage becomes normalized turns, including cache/reasoning and tools, without double counting step-finish parts; source remains read only.
- [x] AC-2 [local, Codex]: CLI and server provider filtering, worker parsing, persistent cache refresh/deletion and dashboard provider selection support OpenCode; existing providers retain behavior.
- [x] AC-3 [local, Codex]: Local OpenCode Go credentials verify against the usage endpoint; actual weekly usage/reset reaches the report, with safe invalid/offline handling and no secret output.
- [x] AC-4 [local, Codex]: Browser walkthrough with real local sessions shows OpenCode charts, quota and sessions; typecheck, tests and package smoke pass.

## Phases
### Phase 1 — Adapter
- [x] Add read-only SQLite adapter and focused fixture tests.
### Phase 2 — Integration
- [x] Wire provider, weekly quota, CLI/server and dashboard; update documentation.
### Phase 3 — Verification
- [x] Run regression/package checks and live browser walkthrough; record results here and close.

## Verification
Initial local inspection: 711 SQLite sessions; authenticated Go usage HTTP 200 (weekly 63%, rolling 2%, monthly 31%). No credential values printed. Branch feat/npx-restructure fast-forwarded into develop at c15d400 and pushed.

Final verification (2026-10-10, Node 24.16.0): `npm run typecheck` passed; `npx vitest run --maxWorkers 2` passed 186 tests in 20 files; `npm run smoke` passed installed tarball, real npx, CLI/HTTP parity and bundled HTML checks. The unrestricted parallel run had a response timing test exceed its 200 ms threshold under concurrent local load; the bounded-worker full run passed without changing that assertion.

Focused OpenCode tests cover normalized assistant/cache/reasoning/tool/wake data, no duplicate step-finish usage, absent installations/XDG paths, cache invalidation and removal, real built-worker execution (main-thread parsing deliberately throws), HTTP filtering, quota reuse/expiry/failure/throttling/no-cache, and mixed-provider Go calibration. Dashboard tests cover provider selection/pin persistence and distinct three-provider quota series.

Real local verification: initial CLI 5 sessions/85 turns; the subsequent live scan saw 6 sessions/97 turns as the local data changed. Authenticated Go API HTTP 200 and dashboard both show weekly 63%, reset 2026-10-12T00:00:00Z. Browser at http://127.0.0.1:8776 verified independent OpenCode chart selectors, rendered weekly quota series, session/title/tool tables and 9 OpenCode check rows. No horizontal overflow or console errors. Screenshot: .playwright-mcp/opencode-dashboard.png (local ignored artifact).

SQLite connection recovery needed a 5-second busy timeout for simultaneous read-only worker connections. Browser server uses a temporary isolated cache and disables discovery of Claude/Codex, while reading the actual OpenCode store; a concurrent platform task was writing the normal shared cache. Existing provider regressions pass in the full suite. No agent configuration, credential files or OpenCode source rows were modified.

Limits: current SQLite schema only; 5-hour/monthly meters are verified but not displayed. Models outside existing pricing ratios remain explicitly unpriced, so weighted burn estimates are approximate. Only opencode-go model usage calibrates the Go weekly quota; other OpenCode providers remain in local totals. No native Windows/macOS browser execution for this feature.


## Post-delivery detection hardening
The first dashboard link pointed to an OpenCode-only verification process whose CLAUDE_CONFIG_DIR and CODEX_HOME intentionally referenced missing temporary directories. Restarted port 8776 with normal discovery and an isolated metadata cache. Live browser checks now show Claude/Codex/OpenCode in both selectors and the weekly chart, with nonempty source-filtered reports (146/183/6 sessions respectively at verification). No detection production change was necessary.

Source audit found no personal machine roots: Claude uses CLAUDE_CONFIG_DIR then HOME/homedir/.claude; Codex uses CODEX_HOME then HOME/homedir/.codex; OpenCode uses OPENCODE_DATA_DIR, XDG_DATA_HOME/opencode, then HOME/homedir/.local/share/opencode.

Added five synthetic-home regression tests via the save-tokens skill's delegated Go arm: real default and override discovery, actual XDG database loading, all-provider burns/timelines with isolated-report equality, missing OpenCode preserving Claude/Codex totals, and reopened persistent cache with zero reparsed files. Node 24 typecheck passed; full suite passed 191 tests in 21 files. No new CLI/HTTP test was added in this follow-up; existing entry-point tests and the live all-provider browser checks provide that coverage.
