# PRD-014 — Reusable modal with fixed controls

**Status:** DONE
**Complexity:** LOW

## Solution
Extract a native dialog component with a fixed header, accessible top-right close action, scrolling body and fixed footer. Control Auto Fixes visibility through the existing Zustand UI store. Keep repair state local and reset on reopening. Preserve Escape handling and disable dismissing during a write.

## Acceptance criteria
- [x] Auto Fixes uses the reusable modal and store-controlled visibility.
- [x] Close action is visible at the top; header/footer remain visible while options scroll.
- [x] Existing selection, confirmation and busy behavior remain reachable.

## Scope and evidence
Modal component, Auto Fixes consumer, UI store, affected existing component cases. Production build and browser observation; tests will not run unless requested.

## Evidence
Production build passed. Browser at port 8765, viewport 780×499: dialog overflow hidden, body overflow auto; body scrolled 720px while header/footer positions stayed unchanged. Top-right close button remained visible and closed the dialog. Auto Fixes imports the shared Modal and controls visibility through useUi.modal/setModal. Selection and guarded confirmation remain in the existing consumer; both serving processes restarted. Existing component case updated to assert store visibility and header close. Tests not executed; no real config edits performed.
