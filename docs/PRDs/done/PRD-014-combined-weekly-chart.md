# PRD-014 — Combined provider weekly chart

**Status:** DONE
**Priority:** P2 — compare provider quota usage on one chart
**Complexity:** 1 → LOW; risk override: none
**Owner:** Codex
**Depends on:** None

## Solution
Dashboard → WeeklyQuota receives all report burns, independent of the gauge selector. Reuse calibrated provider percentages: Claude Code orange, Codex blue. Shared calendar axis spans both providers' actual weekly windows; shared percentage axis includes over-quota readings. Preserve provider-specific even pace, capped history, and projections. Missing quota providers are omitted without hiding available providers.

## Acceptance Criteria
- [x] AC-1 [local]: Dashboard shows both colored provider histories independently of the selector, including when selected provider lacks quota. Proof: focused web tests.
- [x] AC-2 [local]: Equal percentage values share y coordinates despite unequal token limits; timestamps share x coordinates across different windows; projections stop at quota/reset without backward segments; over-quota readings stay visible. Proof: chart coordinate tests.
- [x] AC-3 [local]: Production build/web typecheck pass; browser screenshots inspected at desktop, tablet and mobile. Proof: build, typecheck and Playwright.

## Integration Ledger
Dashboard in web/src/components/panels.tsx → WeeklyQuota in web/src/components/charts.tsx; replaces selected-provider chart inputs. Evidence recorded below.

## Execution Phases
### Phase 1: Combined chart and checks
**Status:** DONE
**Files:** charts.tsx, panels.tsx, chart tests
**Implementation:** Common calendar and percentage scales; per-provider series and legend.
**Verification:** npx vitest run web/src/app.test.tsx web/src/charts.test.tsx; npm run typecheck; npm run build; browser inspection.

## Evidence
- Node 24: `vitest run web/src/charts.test.tsx web/src/app.test.tsx` — 16 tests passed. Final tick-spacing edit: 4 chart tests passed again.
- `npm run build` passed; `tsc --noEmit -p web` passed; targeted diff whitespace check passed.
- Full repository typecheck remains blocked by existing `src/setup/agents.ts:772` TomlValue assignment error; unrelated setup edits preserved.
- Isolated Playwright browser loaded the production bundle with live report data; both series retained after gauge selection; no page errors, horizontal overflow or out-of-bounds current points at 1440×900, 1024×768 and 390×844. Screenshots `/tmp/tf-weekly-{desktop,tablet,mobile}.png` inspected.
- Browser selector check compares provider labels/percentages rather than raw paths: the gauge changes grid height, legitimately resizing chart coordinates.
- Running dashboard at port 8765 serves the rebuilt chart (confirmed response contains the shared-scale subtitle and series markup); no process restart needed by this task.
