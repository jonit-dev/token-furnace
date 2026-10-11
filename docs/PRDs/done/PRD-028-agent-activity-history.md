# PRD-028 — Active agent trend and peaks

**Status:** DONE
**Priority:** P2 — Show active-agent history and simultaneous peaks in the dashboard card.
**Complexity:** 2 (LOW); risk override: none
**Owner:** Codex
**Depends on:** None

## Solution
Reconstruct activity from timestamp-only repository reads across all available local history. Each session stays active for 30 minutes after a turn. Merge overlapping intervals per provider/project/session and sweep their boundaries to calculate exact simultaneous peaks for the last seven days and lifetime (available transcripts). Sample the last 24 hours every 30 minutes for the existing Spark line chart. No hardcoded provider list, new dependencies, persistence store, or schema migration. Deleted transcripts are outside lifetime coverage.

## Acceptance Criteria
- [x] AC-1 [local]: Exact peaks count distinct overlapping sessions across providers, including bursts between chart samples, seven-day boundaries, duplicate turns and expiry — proof: Node 24.16.0, `node node_modules/vitest/vitest.mjs run test/agent-activity.test.ts test/report-service.test.ts test/sqlite-repo.test.ts web/src/app.test.tsx` — 55 passed on the working diff, including four algorithm cases.
- [x] AC-2 [local]: Repository-backed reports retain lifetime peaks older than the report window; memory and SQLite activity reads agree — proof: AC-1 run; one-day service report includes ten simultaneous sessions from ten days ago; both repository implementations return matching timestamp columns.
- [x] AC-3 [local]: Dashboard card displays a trend line, seven-day peak and lifetime peak while retaining provider counts and handling old snapshots — proof: AC-1 run, `npm run typecheck`, `npm run build`, and analysis/provider parity suites (23 passed). Restarted port 8765 and inspected the live SVG and labels at desktop and 390px mobile widths: 12 active, 7d peak 30, lifetime peak 47; no card/page overflow. Tests and build used Node 24.16.0 and the working diff.

## Integration Ledger
| Capability | Consumer/trigger | Disposition | Evidence |
| --- | --- | --- | --- |
| Activity history | src/services/report-service.ts getRaw → repository.activity → src/core/analyze/report.ts buildReport → src/core/analyze/view.ts reportView | Adds compact aggregate to report | AC-1, AC-2 |
| Trend and peaks | web/src/App.tsx → Dashboard → web/src/components/panels.tsx KpiStrip | Replaces top-burner bar in Active agents card | AC-3 |

## Execution Phases
#### Phase 1: History and card
**Status:** DONE
**Files:** src/core/analyze/agent-activity.ts, src/core/model.ts, src/core/analyze/report.ts, src/core/analyze/view.ts, src/repo/{session-repo,memory-repo,sqlite-repo}.ts, src/services/report-service.ts, web/src/components/panels.tsx; focused tests.
**Implementation:** Stream timestamps instead of loading lifetime token/tool payloads. Calculate peaks from interval boundaries, not sampled values. Keep optional report fields for old snapshots.
**Verification:** Focused Vitest suites; typecheck; production build; inspect restarted dashboard.
