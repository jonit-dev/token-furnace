# PRD-013 — Selectable Auto Fixes

**Status:** PARTIAL — implementation complete; automated regression execution not requested
**Complexity:** LOW

## Solution
Rename the header action Auto Fixes. Show one checked checkbox per provider setting; send selected repair IDs to the shared backup-first implementation. Disable apply with no selection. Preserve CLI defaults and optional depth flag. Explain depth compatibility beside the depth checkboxes.

## Acceptance criteria
- [x] Modal lists every repair checked by default; users can deselect any repair.
- [ ] Confirm applies only selected settings; unchecked providers are not read or modified. Invalid IDs are rejected before writes.
- [x] Running dashboards serve the new Auto Fixes button and checklist.

## Scope
Shared repair catalogue, setup repair, guarded server endpoint, modal, existing regression cases and README. Build for compilation; do not run tests unless requested.

## Evidence
Production build passed. Live browser at port 8765 observed Auto Fixes, nine checked repairs and Claude Code/Codex groups; cancelled without writing configs. Both serving processes restarted. Existing UI/server regression cases updated for selection filtering, empty selection and invalid IDs; not executed per session instruction. Shared repair implementation gates every setting by its ID and skips reading deselected providers. Selection persistence remains unverified by execution.
