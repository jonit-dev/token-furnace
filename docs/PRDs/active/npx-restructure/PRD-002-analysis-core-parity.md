# PRD-002 — Port the analysis core with parity against Python

**Status:** NOT STARTED
**Priority:** P1 — the leak findings are the product. AC-1 proves the port changes no result.
**Complexity:** 7 (HIGH)
**Owner:** João
**Depends on:** PRD-001

## Context

The analysis in `scripts/burn.py` is pure logic over turn dicts and config files:

| Python | Lines | Target |
|---|---|---|
| Rates and buckets: `MODEL_RATE`, `model_rate`, `bucket_label`, rate constants | 38–73 | `src/core/analyze/pricing.ts` |
| Thresholds, `session_flags` | 295–334 | `src/core/analyze/flags.ts` |
| Config readers and `config_notes`, `config_checks` | 335–512 | `src/core/analyze/config-checks.ts` |
| `build_report` | 527–842 | `src/core/analyze/report.ts` |
| `week_points`, `burn_goal` | 843–925 | `src/core/analyze/burn.ts` |
| `codex_week` (local `rate_limits`, no network) | 926–952 | `CodexSource.week()` |
| `severity`, `_provider_levers`, `baseline` | 1072–1141 | `src/core/analyze/baseline.ts` |
| `ISSUES`, `ISSUE_EXTRA`, `top_issues`, `issue_priority`, `issue_prompt` | 1201–1414 | `src/core/analyze/issues.ts` |
| `report_view` | 1415–1497 | `src/core/analyze/view.ts` |

`plan_week()` (network) is not in this PRD. PRD-003 ports it behind `--plan-usage`. Here `buildReport()` takes the plan week as an optional input.

`scripts/test_burn.py` is a script, not pytest. It writes fixture transcripts into a temp `CLAUDE_CONFIG_DIR`, runs `burn.py` as a subprocess, and asserts on the text output (`check_last_24h`, `check_severity`, `check_weekly_quota`, `check_config_notes`, `check_codex_week`, and `main`, 49 asserts).

## Solution

- `buildReport(input)` is pure. Input: turns, titles, config file contents, the Codex week, the plan week, `days`, `weeklyBudget`, and `now`. Python reads the clock and the files inside `build_report`. The port moves those reads out, so tests fix `now`.
- `toView(report)` returns the `Report` from schema.md.
- Parity test: `test/parity.test.ts` writes a fixture `CLAUDE_CONFIG_DIR` and `CODEX_HOME` with times relative to now. It runs Python and TypeScript on the same directory and deep-compares the two `Report` values. Python side: `python3 -c` imports `burn`, then prints `json.dumps(report_view(build_report(args)), default=str)`. Ignore `generated`. Compare floats to 1e-9.
- Port the `test_burn.py` checks to `test/analysis.test.ts`. These checks stay after the Python is deleted in PRD-003.

## Acceptance Criteria

- [ ] AC-1 [local]: The parity test passes for `--source all`, `claude`, and `codex`, with and without `--weekly-budget`. proof: `npx vitest run test/parity.test.ts` — Evidence: pending.
- [ ] AC-2 [local]: The parity fixture triggers all five session leaks and every config check in FR-6 and FR-7, so parity covers each branch. proof: assert in `test/parity.test.ts` that each issue title is present — Evidence: pending.
- [ ] AC-3 [local]: Every assert in `scripts/test_burn.py` has a matching assert in `test/analysis.test.ts`, and the suite passes. proof: `npx vitest run test/analysis.test.ts` — Evidence: pending.
- [ ] AC-4 [local]: `src/core/` has no `node:fs`, `node:os`, `process`, or `Date.now()` use. proof: `grep -rnE "node:fs|node:os|process\.|Date\.now" src/core` returns no lines — Evidence: pending.
- [ ] AC-5 [local]: `Report` in `src/core/model.ts` has no `unknown` field left. proof: `grep -n unknown src/core/model.ts` returns no lines — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Report building | `ReportService.getReport()` (PRD-003) | `build_report` + `report_view`, deleted in PRD-003 | AC-1 |
| Leak and config findings | `Report.issues`, `Report.config` | `session_flags`, `config_checks`, `top_issues` | AC-2, AC-3 |

## Execution Phases

#### Phase 1: Parity harness first
**Status:** NOT STARTED
**Files:** `test/parity.test.ts`, `test/fixtures/build.ts`
**Implementation:** Write the fixture builder and the Python side of the harness first. Make the test fail on a stub `buildReport`. Unset the env vars that `test_burn.py` `run()` unsets, so the developer's own settings do not leak in. Point `XDG_CACHE_HOME` at the temp dir.
**Verification:** The test runs and fails on the stub only.

#### Phase 2: Pricing, flags, config checks
**Status:** NOT STARTED
**Files:** `src/core/analyze/pricing.ts`, `flags.ts`, `config-checks.ts`
**Implementation:** Port as they are, with the same constants and message strings. Config checks receive file contents and env values as arguments.
**Verification:** `npx vitest run test/analysis.test.ts` — `check_config_notes` and `check_severity` ports pass.

#### Phase 3: Report, burn, baseline, issues, view
**Status:** NOT STARTED
**Files:** `src/core/analyze/report.ts`, `burn.ts`, `baseline.ts`, `issues.ts`, `view.ts`, `src/sources/codex.ts` (`week()`)
**Implementation:** Read `burn.py:527–952` and `1072–1497` fully first. Keep the issue texts and prompts byte for byte. Replace each `unknown` in `Report` with the real type.
**Verification:** `npx vitest run test/parity.test.ts test/analysis.test.ts` — AC-1 to AC-5.
