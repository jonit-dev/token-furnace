# PRD-015 — Provider dashboard controls and useful stats

**Status:** DONE
**Priority:** P2 — select providers independently and use the sparse KPI row
**Complexity:** 2 → LOW; risk override: none
**Owner:** Codex
**Depends on:** None

## Solution
Add independent provider dropdowns to combustion and hourly context spend. Preserve the combined hourly view, with no single-provider goal. Aggregate provider timelines from normalized turns and expose them in report JSON. Each Pin button remembers its chart provider across reloads in optional browser storage. Unpinned selections reset on reload. Missing providers fall back without discarding the saved preference. Reuse existing cards and report fields for provider spend, turns, sessions, projects and tool calls. Let KPI columns distribute evenly rather than leaving a single orphan tile.

## Acceptance Criteria
- [x] AC-1 [local]: Hourly provider selection changes actual bars and matching goal; combined rows equal the sum of provider rows. Proof: targeted analysis and dashboard tests.
- [x] AC-2 [local]: Combustion and hourly dropdowns work independently; pin control follows clarified behavior and tolerates unavailable storage/providers. Proof: dashboard tests.
- [x] AC-3 [local]: Additional statistics use existing report values and tiles distribute across the available width. Proof: dashboard tests and browser inspection.
- [x] AC-4 [local]: Web typecheck, targeted tests and production build pass. Full repository typecheck also run; existing setup error noted below. Proof: npx tsc --noEmit -p web; npx vitest run test/context-targets.test.ts web/src/app.test.tsx web/src/charts.test.tsx; npm run build.

## Integration Ledger
ReportInput → buildReport → reportView → App → Dashboard → Hourly / Gauge. Preserve aggregate timeline for existing consumers; optional new JSON field supports older snapshots.

## Execution Phases
### Phase 1: Provider timelines
**Status:** DONE
**Files:** src/core/model.ts, src/core/analyze/report.ts, src/core/analyze/view.ts, test/context-targets.test.ts
**Implementation:** Accumulate cool/hot spend per provider using the same context thresholds as the aggregate timeline.
**Verification:** Targeted analysis assertions cover provider sums and above-target classification.

### Phase 2: Controls and statistics
**Status:** DONE
**Files:** web/src/store.ts, web/src/components/panels.tsx, web/src/components/ui.tsx, web/src/app.test.tsx
**Implementation:** Accessible dropdowns, pin preference, existing-data statistics, balanced responsive grid.
**Verification:** Dashboard interaction tests, web typecheck, build, browser layout inspection.

## Evidence
- 39 tests passed across context-targets, dashboard, charts, analysis and report-service suites under Node 24. Final pin-state refinement: 3 relevant interaction tests passed again.
- `npx tsc --noEmit -p web`, `npm run build`, and `git diff --check` passed.
- `npm run typecheck` reports the pre-existing `src/setup/agents.ts:772` Record<string, unknown> / TomlValue mismatch. This task does not change setup code.
- Real Chromium checks at 1440×900, 1024×768 and 390×844: independent charts, pin survives reload, no horizontal overflow or page errors. Desktop and mobile screenshots inspected: `/tmp/tf-provider-{desktop,tablet,mobile}.png`.
- New project and tool-call counts are computed before top-project/tool truncation. Existing snapshots retain their combined timeline and show unavailable new stats as dashes.
- Pin interpreted as remembering provider selection, as stated during implementation; no user clarification received. No dependencies added; no worktree created. Full test suite not run.

Release follow-up (PRD-017): the TOML type mismatch is fixed; root/web typechecks and the full 158-test suite pass on Node 24.21.0 with two test workers.
