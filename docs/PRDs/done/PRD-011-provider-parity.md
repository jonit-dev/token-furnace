# PRD-011 — Provider parity bug hunt

**Closed:** 2026-10-10 at `9d2e1c4`, archived to `done/`.

**Status:** DONE — 2026-10-10. Every phase and acceptance box verified.
**Priority:** P1 — active sessions and diagnostics must work for every supported provider.
**Complexity:** 6 (MEDIUM: 11+ implementation files, additive cache column, native WASM build boundary); risk override: none.
**Owner:** Codex
**Depends on:** None

## Context
The dashboard defaults to Claude and applies the burn selector to active sessions. Provider-specific parser assumptions and diagnostic advice need auditing. Existing uncommitted PRD-010 changes are preserved.

## Solution
Keep shared analysis on normalized turns. `src/core/providers.ts` owns labels, cache-write capability, compaction advice and parser revisions; `src/sources/index.ts` registers adapters once for both composition and workers. Provider-specific configuration checks remain explicit; OpenCode is not implemented.

Active sessions are independent of the burn selector, use their own provider's quota and warning state, and show source badges. Codex parses JSON command arguments, custom calls, executed code-mode commands and fallback user messages; matches duplicate message formats by occurrence; skips repeated cumulative usage; and counts reasoning within output rather than twice. The WASM line filter preserves the newly consumed records, including large user messages. Cache metadata migrates additively and reparses outdated Codex entries. Issues group by provider, avoid cross-provider config overrides and label spend shares as total spend. Whole-window hot spend now reports a percentage.

## Acceptance Criteria
- [x] AC-1 [local]: mixed-provider dashboard shows all active sessions independently of the burn selector — proof: `npx vitest run web/src/app.test.tsx` — 10 passed, including per-provider quotas and warning state.
- [x] AC-2 [local]: Codex transcript usage, tools and prompts reach report diagnostics correctly — proof: provider-parity and ignored-output regression tests — 14 + 18 passed, including cache migration and large modern records.
- [x] AC-3 [local]: copied compaction advice addresses the affected provider rather than assuming Claude — proof: provider-parity regression tests — Codex advice remains correct with Claude's setting already OK.
- [x] AC-4 [local]: typecheck and full suite pass — proof: `npm run typecheck` and `npm test` — both exit 0 on Node 24.16.0; 142 tests across 16 files; pretest production build passes.

## Integration Ledger
| Capability | Consumer | Evidence |
| --- | --- | --- |
| Active sessions | web/src/App.tsx → Dashboard → ActiveSessions | AC-1 |
| Transcript diagnostics | CodexSource.parse → buildReport → reportView | AC-2 |
| Provider advice | reportView/topIssues → issuePrompt → copy fix | AC-3 |
| Adapter registration | src/compose.ts and src/scan-worker.ts → src/sources/index.ts | AC-2, AC-4 |
| Fast parsing and cache | CodexSource.parse → rebuilt WASM filter; ReportService.refresh → parser revision cache check | AC-2 |

## Execution Phases
### Phase 1: Reproduce and fix provider assumptions
**Status:** DONE
- [x] Deliver provider parity fixes through CLI, workers and dashboard — proof: `npm test` (AC-1–AC-4).
**Files:** provider metadata and registration, source parser and native filter, cache, analysis advice and dashboard, corresponding tests and golden fixtures.
**Implementation:** audit reachable consumers; failing tests first; minimal shared fixes; preserve provider-specific capabilities.
**Verification:** Each confirmed defect was reproduced with failing regression tests before its fix; initial runtime collection errors were resolved by using installed Node 24 instead of default Node 20. Targeted runs passed after fixes. Final `npm test`: 142/142; `npm run typecheck`: exit 0; `git diff --check`: clean. Native WASM rebuilt successfully in 5.26 seconds. Review identified code-mode reads, mixed message formats and provider warning state; all three were fixed and reviewed again without further material findings.

**Limits:** No OpenCode integration, live browser walkthrough or full-corpus performance benchmark. Existing concurrent PRD-010 edits were preserved. Verification exercised both inline and worker parsing through the full suite. Reasoning-token interpretation also checked against [OpenAI token-counting documentation](https://developers.openai.com/api/docs/guides/token-counting) and local rollout counter relationships.
