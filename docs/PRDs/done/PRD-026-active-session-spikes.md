# PRD-026 — Active session spike alerts

**Status:** DONE
**Priority:** P2 — Identify and alert on active sessions burning above the provider pace.
**Complexity:** 2 (LOW); risk override: none
**Owner:** Codex
**Depends on:** None

## Solution
Reuse the last-hour weighted spend of sessions active within 30 minutes. A session is critical when its own burn exceeds twice its provider's hourly goal. A known exhausted quota (zero goal) also flags positive spend; an unavailable goal does not. This is sustained high burn relative to ideal pace, not sudden acceleration detection.

Show a Critical tag in Active sessions, include the session in Needs attention and Act now, and offer an opt-in notification condition using the existing channels. The server checks once per minute without requiring an open tab. Use full session identity for deduplication, retry through existing delivery logic, and rearm after recovery/inactivity. Do not send real notifications during verification.

## Acceptance Criteria
- [x] AC-1 [local]: Reports identify the responsible session using its provider goal, with threshold/zero/missing-goal coverage — proof: focused Vitest tests.
- [x] AC-2 [local]: Active sessions show Critical and Needs attention even without leak flags; Act now names the session — proof: dashboard tests.
- [x] AC-3 [local]: Optional notifications send once per spike, survive restarts, retry failures, and rearm after recovery; settings persist — proof: notification tests and typecheck.

## Integration Ledger
| Capability | Consumer/trigger | Disposition | Evidence |
| --- | --- | --- | --- |
| Spike identification | reportView → actions; ActiveSessions → session row | Reuses existing rate and goal | AC-1, AC-2 |
| Spike notifications | notifyTick → ReportService → runAlerts | Adds optional condition to existing delivery | AC-3 |

## Execution Phases
#### Phase 1: Detection, UI and notifications
**Status:** DONE
**Files:** src/core/analyze/burn.ts, view.ts, web/src/components/panels.tsx, notifications.tsx, src/services/notifications.ts, src/server.ts; focused tests.
**Implementation:** Share one predicate across consumers; preserve old settings via default false. Clear obsolete spike markers before retrying and retain channel deduplication while the spike persists.
**Verification:** Focused Vitest tests, backend/web typecheck, production build, diff check.

## Verification
- Node 24.16.0: `npm test -- --maxWorkers=1 --testTimeout=15000` passed all 257 tests in 27 files; the pretest production build passed.
- `npm run typecheck` passed for backend and web. `git diff --check` passed.
- Actual server tick → transcript refresh → report → spike condition passes without a dashboard request. UI tests cover Critical/Needs attention and clearing at the boundary. Notification form saves the new opt-in; persisted delivery markers suppress repeat sends and rearm on recovery/inactivity.
- Playwright on a generated local transcript HTML preview: named Act now alert and Critical row visible, no page overflow at desktop and 390px mobile; screenshots inspected. Static preview API requests return 404 because the preview host has no live API.
- No real ntfy/Telegram delivery, no publication or deployment. No worktree was created. Existing unrelated PRD-027 work was preserved.
