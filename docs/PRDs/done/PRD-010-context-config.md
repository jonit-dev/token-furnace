# PRD-010 — Context targets and config repair

**Status:** DONE
**Priority:** P2 — align config checks with requested context sizes and automate repair.
**Complexity:** 3 (LOW); risk override: none.
**Owner:** Codex
**Depends on:** None

## Solution
Use shared targets (Claude 400000, Codex 300000) in config checks and advice. Add `token-furnace fix-config` to repair context settings, preserving unrelated settings. Validate both files before writing, back up originals beside each config first, respect custom config directories, and report errors with exit 1. Use the same provider targets for transcript benchmarks, late-compaction flags, Checkup median targets, dashboard KPIs, chart legends and repair previews.

## Acceptance Criteria
- [x] AC-1 [local]: checks accept requested targets and warn on other context sizes; advice agrees — proof: `vitest run test/analysis.test.ts -t check_config_notes` — 3 passed; context advice verified in CLI fixtures.
- [x] AC-2 [local]: CLI repair saves original bytes before updating both configs, preserves unrelated data, and repeats without changes — proof: `vitest run test/setup.test.ts -t "token-furnace fix-config"` — 4 passed through `main`.
- [x] AC-3 [local]: invalid config prevents writes; custom directories and backup failures are handled — proof: same setup run covers malformed files, custom paths, and real permission-denied backup failure; typecheck passed.

- [x] AC-4 [local]: dashboard confirmation explains changes; cancel writes nothing; confirm repairs through the guarded server endpoint and refreshes checks — proof: UI `context configuration repair` tests (2 passed) and server `configuration repair endpoint` test (1 passed).

- [x] AC-5 [local]: all context calculations and UI labels use one provider target constant; equality is within target — proof: `test/context-targets.test.ts` boundary and mixed-provider tests; affected 6-file Vitest run: 63 passed; typecheck/build passed.
- [x] AC-6 [local]: the local dashboard serves the new repair UI — proof: Playwright observed the header button and modal at port 8765, provider-specific KPI targets and benchmark legend on real reports, and the header button at port 8780 after replacing the older servers.

## Integration Ledger
| Capability | Consumer | Evidence |
| --- | --- | --- |
| Context checks | report → configNotes/configChecks | AC-1 |
| Repair | src/cli.ts main → runFixConfig | AC-2, AC-3 |
| UI repair | Checks → confirmation → POST /api/fix-config → runFixConfig | AC-4 |

## Execution Phases
### Phase 1: Implement and validate
**Status:** DONE
**Files:** config-checks, flags, issues, setup/agents, cli, affected tests and docs.
**Implementation:** shared targets, validated config edits, backup before mutation, command documentation.
**Verification:** focused Vitest tests, typecheck and build.

## Verification
Node 24: 63 tests passed across context-targets, analysis, CLI, provider-parity, server and UI suites. Typecheck and production build passed. Browser observation confirmed the repair button/modal and live target labels. Ports 8765 and 8780 now run the current CLI server; the previous processes retained older dashboards. Configuration repair itself was exercised against isolated test homes; live changes remain behind the UI confirmation. Mobile layout was not checked.

## Decisions
- 2026-10-10 (João): centralize context policy across Checkup, dashboards and benchmarks in `src/core/context.ts`.
- Mixed-provider spend compares each turn against its provider target; equality is within target. JSON uses `overTarget` and `contextTargets`, replacing the former fixed-window fields.
