# PRD-029 — Explain dashboard metrics

**Status:** DONE
**Priority:** P2 — Make each KPI understandable through an accessible info button.
**Complexity:** 1 (LOW); risk override: none
**Owner:** Codex
**Depends on:** None

## Solution
Add a small info button to the shared Tile component. Open the existing Modal with a full metric name and plain-language explanation of its value, time window, chart, and target. Every KPI supplies help; provider-specific spend help derives provider names and context targets from report/registry data. Explain that above-target spend counts the whole turn's weighted tokens. Preserve the natural-height grid fix and visible agent history.

## Acceptance Criteria
- [x] AC-1 [local]: Every KPI info button opens a named modal and dismisses through the existing modal controls — proof: `node node_modules/vitest/vitest.mjs run web/src/app.test.tsx` under Node 24.16.0, 35 passed on the working diff. Live Escape check returned focus to the opening info button. The shared modal saves its opener for unmount cleanup; its affected dashboard/session/notification suites previously passed 51 tests.
- [x] AC-2 [local]: Provider spend help explains its percentage, provider context threshold, weighted spend and time window; other metric categories have specific explanations — proof: AC-1 tests; typecheck passed. Inspected the live Claude help: 59% weighted spend above its 400k context target, total spend 2.3B over seven days, entire-turn counting, chart and 10% goal explained.
- [x] AC-3 [local]: Cards remain compact on desktop and fit mobile; updated server serves the changes — proof: production build passed and port 8765 restarted. Desktop KPI tiles all 86.5px outer height; mobile 390px modal fits without horizontal overflow and has 24px info-button targets. Agent summary now has a full top-row panel under PRD-032.

## Integration Ledger
| Capability | Consumer/trigger | Disposition | Evidence |
| --- | --- | --- | --- |
| KPI explanation | web/src/components/panels.tsx KpiStrip/ActiveAgents → ui.tsx MetricInfo → modal.tsx Modal | Adds help alongside existing metric values | AC-1, AC-2, AC-3 |

## Execution Phases
#### Phase 1: Info buttons and help
**Status:** DONE
**Files:** web/src/components/{ui,icons,panels,modal}.tsx; web/src/app.test.tsx.
**Implementation:** Require help content for every Tile. Use a 24px button with a small icon without enlarging card rows. Reuse native modal focus and dismissal behavior.
**Verification:** Dashboard tests, typecheck, build, live desktop/mobile and keyboard checks.
