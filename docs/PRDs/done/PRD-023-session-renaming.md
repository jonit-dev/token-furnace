# PRD-023 — Edit active session names

**Status:** DONE
**Progress:** 3/3 acceptance criteria verified
**Priority:** P2 — generated names make active sessions hard to identify
**Complexity:** 1 (LOW); risk override: none
**Owner:** Codex
**Depends on:** None

## Context
Active session titles come from transcripts. Project names share the Session cell and have no header.

## Solution
Reuse the session modal and persisted Zustand preferences. Add Rename beside each active title, a labeled name field with Save, Cancel and Reset, and a separate Project column. Key overrides by provider and full session ID. Apply aliases to active rows, modal titles and Top sessions; transcript files remain untouched. Names persist in the current browser/origin.

## Acceptance Criteria
- [x] AC-1 [local]: Rename updates the row, modal and Top sessions, survives report refresh and preference rehydration, and isolates provider/full IDs — proof: `npx vitest run web/src/session-identification.test.tsx` — 8 tests passed; browser rename survived reload.
- [x] AC-2 [local]: Cancel preserves the name; blank input is rejected; Reset restores the generated name — proof: same UI tests — passed.
- [x] AC-3 [local]: Project has its own header and mobile label — proof: UI tests and CSS inspection — passed; browser card scrollWidth equals clientWidth at 390, 772 and 1440px viewport widths. Screenshot inspected at 772px.

## Blocked on
None.

## Integration Ledger
| Capability | Consumer | Evidence |
|---|---|---|
| Rename | ActiveSessions → SessionTable Rename → SessionModal form → persisted useUi → active/modal/top-session titles | AC-1, AC-2 |
| Project label | SessionTable → separate Project cell and header | AC-3 |

## Execution Phases
### Phase 1: Rename and label sessions
**Status:** DONE
**Files:** web/src/store.ts, components/panels.tsx, components/tables.tsx, style.css, session-identification.test.tsx.
**Implementation:** Reuse dashboard preference storage and modal; trim names, limit to 200 characters, ignore malformed saved values. No server/transcript writes or new dependencies.
**Verification:** Targeted UI tests, typecheck, full test/build command.

## Verification results
Node 24.16.0: `npm test` passed all 238 tests across 25 files, including the production build. `npm run typecheck` and `git diff --check` passed. Existing app test emits an async act warning. Initial Node 20 test attempt could not load jsdom; switched to the installed supported Node 24 runtime. Browser checks used fixture report responses and exercised real UI/preferences. No transcript or server metadata writes; aliases are specific to browser/origin.
