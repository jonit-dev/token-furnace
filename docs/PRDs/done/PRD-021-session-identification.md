# PRD-021 — Session Identification and Actionability

**Status:** DONE
**Complexity:** LOW

## Solution
Make active and historical sessions recognizable and actionable in the Sessions dashboard. Group active sessions into "Needs attention" (sessions with actual flags) and "Other active sessions", clearly distinguishing measured flags from high burn. Show provider burn share with clear provider denominator labeling (e.g. Claude Code vs Codex). Display flag reasons and actionable fixes visibly with full measured strings and click-to-copy/access actions, supported by native expandable session details showing full paths/activity. Extract clean task titles for untitled Codex sessions from user prompt excerpts while skipping boilerplate. Ensure session IDs copy full actual IDs while preserving compact display.

## Acceptance Criteria
- [x] Active sessions group flagged sessions under "Needs attention" and unflagged under "Other active sessions" with proper empty states.
- [x] Provider burn share is clearly labeled with readable provider denominator without hovering.
- [x] Flag reasons and fixes are displayed visibly and actionably from measured strings without unreadable table dumping; expandable row details provide complete context.
- [x] Codex sessions without custom titles extract a human task fallback from early user prompts, ignoring setup/agents boilerplate.
- [x] Copy ID action copies full session ID for both active and top sessions while compact UI displays shortened ID.
- [x] Backward compatibility and existing test suites pass.

## Scope
`src/core/model.ts`, `src/sources/agent-source.ts`, `src/sources/codex.ts`, `src/core/providers.ts`, `src/core/analyze/report.ts`, `web/src/components/panels.tsx`, `web/src/components/tables.tsx`, unit tests in `test/` and `web/src/`.

## Evidence
Full test suite passed before final review (23 files, 196 tests). After review corrections, focused parser/report/UI tests passed (3 files, 28 tests), including active and historical full-ID copying and expanded titles. Typescript typecheck passed (`tsc --noEmit && tsc --noEmit -p web`). Production build passed (`tsup && vite build`).

## Limitations
Details expose the project name, full title and ID, not the full working-directory/worktree path: that metadata is unavailable in the current report. No live browser observation was performed. The follow-up worker stopped on a reported Google quota exhaustion; its partial changes were inspected and passed the focused checks above.
