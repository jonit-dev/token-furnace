# PRD-027 — Cross-provider active agent count

**Status:** DONE
**Priority:** P2 — Make the current active agent count visible across providers in the KPI row.
**Complexity:** 1 (LOW); risk override: none
**Owner:** Codex
**Depends on:** None

## Solution
Update the existing Active sessions KPI to Active agents, with the total and visible provider counts. Discover providers from report.burns plus report.active, and resolve labels through the existing provider registry with a raw-name fallback. The card has no hardcoded provider list; Source already derives from that registry. Reuse the existing refresh cycle. Active means a session with a transcript turn within the last 30 minutes; this is an activity estimate, not an OS process count. Keep the active-session table and existing top-burner indicator. No new tracking or dependencies.

## Acceptance Criteria
- [x] AC-1 [local]: Dashboard KPI shows the total and per-provider counts independently of the combustion selector, including an additional provider without card edits — proof: `npx --yes --package=node@22 -c 'node node_modules/vitest/vitest.mjs run web/src/app.test.tsx'` — 28 tests passed on the working diff, Node 22.23.3; includes cross-provider and additional-adapter cases.
- [x] AC-2 [local]: Empty activity shows zero and the 30-minute definition remains visible — proof: AC-1 run, empty and partial report case passed.
- [x] AC-3 [local]: Existing dashboard behavior and types remain valid — proof: AC-1 run; `npm run typecheck` and `npm run build` under Node 22.23.3 both passed on the working diff.

## Integration Ledger
| Capability | Consumer/trigger | Disposition | Evidence |
| --- | --- | --- | --- |
| Active agent count | web/src/App.tsx → Dashboard → web/src/components/panels.tsx:491 KpiStrip | Enhance existing active-session KPI; reuse report.active | AC-1, AC-2 |

## Execution Phases
#### Phase 1: Count card
**Status:** DONE
**Files:** web/src/components/panels.tsx; web/src/app.test.tsx.
**Implementation:** Relabel the KPI, expose activity window and render provider counts with existing badges. Preserve unrelated in-progress changes in panels.tsx.
**Verification:** npx vitest run web/src/app.test.tsx; npm run typecheck; npm run build.
