# PRD-032 — Give active agents a full dashboard panel

**Status:** DONE
**Priority:** P2 — Restore compact KPI rows and give agent activity enough space.
**Complexity:** 1 (LOW); risk override: none
**Owner:** Codex
**Depends on:** None

## Solution
Move Active agents from KpiStrip to a full Card to the right of Weekly quota/Burndown. Use a four-column desktop grid: combustion one column, quota two, agents one. Stack these panels on smaller screens. Preserve dynamic provider discovery, recent count, 24-hour line, exact peaks, old-snapshot fallback and info modal. Keep count neutral rather than tying it to an unrelated provider burn alert.

## Acceptance Criteria
- [x] AC-1 [local]: Dashboard renders the agent panel beside quota on desktop and removes it from KPI rows — proof: `node node_modules/vitest/vitest.mjs run web/src/app.test.tsx`, 35 passed; charts suite, 5 passed, Node 24.16.0 on the working diff. At 1440px desktop: quota x=412, width=614; agents x=1044, width=298; both y=61 and height=360. All 12 KPI tiles have equal 85px inner height (86.5px including borders).
- [x] AC-2 [local]: Provider counts, history, peaks and explanation still work, including missing history and additional providers — proof: AC-1 dashboard cases; `npm run typecheck` passed. Live agent popup closes with Escape and restores focus to About Active agents.
- [x] AC-3 [local]: Mobile stacks panels without overflow; server is restarted with the production build — proof: `npm run build` passed, port 8765 restarted. At 390px, agent panel stacks below quota, its chart is 64px high, and neither panel nor page has horizontal overflow. Desktop screenshot visually inspected at .playwright-mcp/active-agents-panel-desktop.png.

## Integration Ledger
| Capability | Consumer/trigger | Disposition | Evidence |
| --- | --- | --- | --- |
| Agent summary | web/src/App.tsx → panels.tsx Dashboard → ActiveAgents | Moves out of KpiStrip; same report data | AC-1, AC-2, AC-3 |
| Metric help | web/src/components/ui.tsx Tile / panels.tsx ActiveAgents → ui.tsx MetricInfo → modal.tsx Modal | Reuses existing info interaction | AC-2 |

## Execution Phases
#### Phase 1: Panel layout
**Status:** DONE
**Files:** web/src/components/{panels,ui}.tsx; web/src/app.test.tsx.
**Implementation:** Reuse Card and Spark; share the existing info button. No backend changes.
**Verification:** Dashboard/chart tests; typecheck; build; desktop/mobile live checks.
