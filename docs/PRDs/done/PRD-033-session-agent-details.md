# PRD-033 — Agent details per active session

**Status:** DONE
**Priority:** P2 — Show recorded agent membership and models from each active-session row.
**Complexity:** 1 (LOW); risk override: none
**Owner:** Codex
**Depends on:** None

## Context
The active-session table shows one model per transcript but no parent/subagent relationship. Claude stores children in `<session>/subagents`; Codex session_meta records `source.subagent.thread_spawn.parent_thread_id`. The existing session modal and provider adapters can be reused. Existing unrelated working changes must be preserved.

## Solution
Attach optional recorded-agent details to active report rows. Replace the existing View text with an eye icon opening the existing session modal, with full model names, parent ID, and parent/subagent labels. Count the row itself plus descendants with recorded assistant usage in the last 30 minutes; show older descendants as idle. Cache metadata/child parses by file modification time. Unsupported or unreadable data is explicitly unavailable. This is transcript activity, not process liveness. No database changes, dependencies, or total-card semantic changes.

## Acceptance Criteria
- [x] AC-1 [local]: Report service detects Claude children and Codex parent links, preserves provider identity, distinguishes recent/idle agents, and handles missing metadata — proof: `vitest run test/session-agents.test.ts` — 3 passed, including descendant IDs with colliding display prefixes, changed child transcripts and incomplete data.
- [x] AC-2 [local]: Each row exposes its existing details button, with View replaced by an accessible eye icon; the modal opens with recorded/recent counts, model and relationship details in the existing modal — proof: `vitest run web/src/session-identification.test.tsx` — 11 passed; live Playwright confirmed eye opens modal, parent/child models render, Escape closes, and no horizontal overflow at 390px.
- [x] AC-3 [local]: Existing activity behavior and types remain valid — proof: targeted provider, activity, source, repository, report, parser, analysis, CLI and server tests passed; `npm run typecheck` and `npm run build` passed; `git diff --check` clean.

## Integration Ledger
| Capability | Consumer/trigger | Disposition | Evidence |
| --- | --- | --- | --- |
| Per-session agent details | ReportService.getRaw → report.active → SessionTable → SessionModal | Extend existing report and modal; preserve active total semantics | AC-1, AC-2 |

## Execution Phases
#### Phase 1: Recorded agent membership
**Status:** DONE
**Files:** src/services/session-agents.ts; src/services/report-service.ts; src/core/model.ts; src/sources/codex.ts; src/core/providers.ts; test/session-agents.test.ts; test/sources.test.ts; test/ignored-output.test.ts.
**Implementation:** Read recorded lineage and child usage with existing adapters; enrich only active rows.
**Verification:** Targeted service tests.

#### Phase 2: Session UI
**Status:** DONE
**Files:** web/src/components/panels.tsx; web/src/components/icons.tsx; web/src/session-identification.test.tsx.
**Implementation:** Replace View with an accessible eye icon; show recorded/recent counts and model/relationship details first in the existing modal.
**Verification:** Targeted UI and existing activity/provider tests; typecheck.

## Decisions
- 2026-10-11 (João): Include parent + subagents inside the existing View modal; replace View with an eye icon. No separate row badge.
- Preserve full Codex session IDs internally and bump parser version to reparse existing cached transcripts. A regression fixture reproduced collisions when distinct parent/child IDs shared an eight-character prefix. Display IDs stay short.
- Coverage is limited to available local transcripts. Activity means recorded usage, not OS process state. Unsupported/missing lineage remains explicitly unknown.
