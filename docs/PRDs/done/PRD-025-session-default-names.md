# PRD-025 — Readable default session names

**Status:** DONE
**Priority:** P2 — Active sessions have opaque prompt excerpts and missing titles.
**Complexity:** 1 (LOW); risk override: none
**Owner:** Codex
**Depends on:** None

## Context
Manual names already override parsed titles in the dashboard. Codex parsing ignores native names in CODEX_HOME/session_index.jsonl (records: id, thread_name, updated_at). Its transcript session IDs are currently shortened to eight characters. Claude supports customTitle/aiTitle. Existing user changes to the dashboard must be preserved.

## Solution
Use saved native Codex names before prompt fallback, refreshing metadata without rescanning unchanged transcripts. Keep manual overrides highest priority. Make path-only handoff fallback titles readable without inventing task summaries; when no usable title exists show project plus short ID. Display a short ID beneath the project in active rows to distinguish duplicate names. Reuse existing AI-generated native titles; add no API calls or dependencies.

## Acceptance Criteria
- [x] AC-1 [local]: Reports prefer native Codex titles and observe metadata-only renames without transcript reparsing — proof: focused report-service tests.
- [x] AC-2 [local]: Handoff filenames become readable fallback names; unnamed sessions use project plus ID; explicit native/manual titles stay intact — proof: focused source/report/UI tests.
- [x] AC-3 [local]: Active rows distinguish duplicate titles using visible short IDs and preserve manual renaming — proof: session-identification UI tests and typecheck.

## Integration Ledger
| Capability | Consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Readable session names | ReportService.getRaw → buildReport → active/session tables | Existing first-prompt-only Codex naming | AC-1, AC-2 |
| Distinguish duplicate names | ActiveSessions → active row project cell | Project alone | AC-3 |

## Decisions
- 2026-10-10 (user delegated decision): Prefer existing native AI titles with local deterministic fallback; no additional paid model calls.

## Execution Phases
#### Phase 1: Names and identification
**Status:** DONE
**Files:** src/sources/codex.ts, src/sources/agent-source.ts, src/services/report-service.ts, web/src/components/panels.tsx and focused tests.
**Implementation:** Read native metadata once per report; resolve full UUIDs from rollout filenames while preserving existing identity and cache behavior. Tolerate absent/malformed index lines. Keep fallback stable; do not read arbitrary handoff files. Preserve pre-existing UI edits.
**Verification:** Node 24 + focused Vitest tests, npm run typecheck; record concise results here and close under done/.

## Worktree
Owner: this Codex session. Branch: feat/session-default-names. Path: /home/joao/projects/token-furnace/.worktrees/session-default-names. Primary base: f769af1005d67021a3c976442a0ba5016cdd853f. Baseline commit preserves current primary edits; only changes after that baseline may be applied back. Cleanup: exact isolated checkout removed and registration/directory absence verified; approximately 2.1 MB removed. Task commits retained on feat/session-default-names; changes integrated in primary checkout.

## Verification
- Node 24.16.0: 35 parser/report/identification tests passed; 10 UI tests passed in a separate single-worker run with a 15-second per-test limit. Initial parallel run had one existing grouping test exceed its 5-second limit; separate rerun passed.
- npm run typecheck passed for backend and web; git diff --check passed.
- Native metadata-only rename is observed without transcript reparsing; malformed/missing indexes and same-prefix wrong UUID fall back safely. Manual rename persistence and visible short IDs pass.
- Delegated attempts: Gemini draft reviewed and rejected; Haiku timed out without edits; DeepSeek left a corrected patch on timeout. Parent reviewed and verified that patch without another coding attempt.
- No additional model calls in product, no dependency changes, no live browser check. Production build passed in primary checkout; reviewed patch applied with git apply and reverse-check confirmed integration.

## Release preparation — 0.1.10
User authorized commit, push and public republishing. Full npm test -- --maxWorkers=1 --testTimeout=15000 passed: 251 tests in 26 files. npm run smoke passed the packed/install/npx/HTML/live-server consumer checks on Node 24.16.0. Previous backend/web typechecks remain valid; only package version metadata changed afterward. Release includes the pending PRD-023 manual renaming and PRD-024 modal/toast work. Publication outcome is reported in the final response.
