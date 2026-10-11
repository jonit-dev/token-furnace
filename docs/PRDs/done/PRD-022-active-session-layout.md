# PRD-022: Active session layout
**Status:** DONE
**Progress:** 3/3 acceptance criteria verified
**Complexity:** 1 → LOW; risk override: none

Integration: unchanged — dashboard → ActiveSessions → SessionTable.

## Acceptance criteria (local; actor: Codex)
- [x] Long model names truncate and expose the full model on hover.
- [x] Flags and copy fixes use pills and remain visible without horizontal scrolling at desktop, 772px and mobile widths.
- [x] Session details, provider metrics and copying retain their behavior.

## Implementation
Constrain model/session columns; adapt the existing table to its container width, placing flags below metrics when needed. Scope: panels.tsx, style.css and existing session UI tests. Verify with focused Vitest, typecheck and browser screenshots/geometry assertions.

## Verification
28 focused UI tests passed on Node 24; the extended model-title/copy-fix test also passed (5 session tests). Typecheck and production build passed. Browser screenshots inspected at 390, 772 and 1024px; geometry checked at 1440px too. Session card scrollWidth equals clientWidth at all four widths; expanded details at 772px also fit. Long model measured 191px in a 112px truncating box with the complete title. Existing app test emits an act warning.
