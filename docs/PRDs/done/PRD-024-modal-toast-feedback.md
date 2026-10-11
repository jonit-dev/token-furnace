# PRD-024 — Shared modal and toast feedback

**Status:** DONE
**Progress:** 3/3 acceptance criteria verified
**Priority:** P2 — saving a session name leaves its dialog open without confirmation
**Complexity:** 1 (LOW); risk override: none
**Owner:** Codex
**Depends on:** PRD-023

## Solution
Reuse the existing Zustand UI store. Extend its single modal slot to session details and notification setup, preventing concurrent modals. Add transient success/error toast state and one app-level toast host. Save and Reset update names, close the dialog and show confirmation. Success toasts expire after 6 seconds, pause while hovered/focused and allow dismissal; error toasts require dismissal. New notifications replace the previous toast. Toasts and open modals are never persisted.

## Acceptance Criteria
- [x] AC-1 [local]: Save/Reset close the dialog, update the session name and announce success; Cancel leaves names unchanged — proof: 9 session-identification UI tests passed; real browser Save/Reset closed the dialog and showed confirmations, with focus restored to the rename button.
- [x] AC-2 [local]: A reusable toast host supports success/error, replacement, dismissal, expiry and hover/focus pause — proof: 5 toast UI tests passed; browser screenshot inspected, no overflow at 390px.
- [x] AC-3 [local]: Session/configuration/notification setup modal selection uses one Zustand slot; persisted preferences omit modal/toast state — proof: session, notification and toast UI tests plus typecheck passed. Native close events from an already hidden modal cannot clear its replacement.

## Integration Ledger
| Capability | Consumer | Evidence |
|---|---|---|
| Rename feedback | SessionNameEditor → useUi name/modal/toast → App Toasts | AC-1 |
| Shared overlays | ActiveSessions, FixConfig and Notifications → useUi modal; App → Toasts | AC-2, AC-3 |

## Blocked on
None.

## Execution Phases
### Phase 1: Shared feedback
**Status:** DONE
**Files:** web/src/store.ts, App.tsx, components/panels.tsx, components/modal.tsx, components/notifications.tsx, components/toasts.tsx, session-identification.test.tsx, resets-notifications.test.tsx, toasts.test.tsx.
**Verification:** Focused tests, full npm test/build, typecheck, browser Save/reload; restart live dashboards with the new build.

## Verification results
Node 24.16.0: `npm test -- --maxWorkers=2` passed all 244 tests across 26 files and the production build. Typecheck and `git diff --check` passed. An initial full run caught an empty toast region conflicting with existing status feedback; the host now exposes a status/alert role only when populated. The initial scan response timing assertion exceeded 200ms under concurrent load and passed on focused and final full reruns without changing its threshold. Existing async act warning remains in the app tests.

Both servers restarted: systemd user service on 8765 and the existing manual server on 8780. HTTP 200 responses from both contain the rebuilt toast/session UI. Temporary Vite test server stopped. Browser checks used fixture report responses; no live notification delivery was triggered.

## Reuse
Call `useUi.getState().showToast("Saved")` or `showToast("Could not save", "error")`. The single `Toasts` host lives in App. All current dialogs use `useUi.modal`/`setModal`; transient overlay state is excluded from persisted preferences.
