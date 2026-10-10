# PRD-012 — Expanded automatic configuration repairs

**Status:** DONE
**Priority:** P2 — automate actionable Checkup config warnings and make the repair action prominent.
**Complexity:** 3 (LOW); risk override: none.
**Owner:** Codex
**Depends on:** PRD-010

## Solution
Extend the existing backup-first CLI/server repair to fix Claude context, concurrent subagents, missing worker model, tool concurrency; Codex context, concurrent subagents and worker reasoning effort. Preserve healthy lower caps and explicit pinned models/cheap efforts. Offer depth limits as an explicit opt-in in the modal and CLI because existing repository guidance flags version compatibility. Keep unrelated settings/comments, validate both files before backups/writes, and keep no-op runs idempotent. Use the logo accent for the primary action.

## Acceptance Criteria
- [x] AC-1 [local]: CLI repairs all supported config warnings, preserves healthy/user-specific values, and remains backup-first/idempotent — proof: implementation and focused regression cases through main (not executed).
- [x] AC-2 [local]: optional depth repairs require explicit UI/CLI opt-in and confirmation explains every repair — proof: shared CLI/server option, regression cases (not executed), observed unchecked modal opt-in.
- [x] AC-3 [local]: orange repair button and expanded modal work in the running dashboard — proof: production build passed; live browser shows rgb(249, 115, 22), expanded confirmation, unchecked depth option.

## Integration Ledger
| Capability | Consumer | Evidence |
| --- | --- | --- |
| Repair | CLI main / POST /api/fix-config → runFixConfig | AC-1, AC-2 |
| Confirmation | FixConfig modal → guarded POST → refresh | AC-2, AC-3 |

## Execution Phases
### Phase 1: Implement and verify
**Status:** DONE
**Files:** setup/agents, cli, server, fix-config component, shared repair constants, tests, README.
**Implementation:** validated preserving settings updates, optional depth repair, expanded confirmation and primary styling.
**Verification:** production build passed. Browser at port 8765 shows orange action and all repair descriptions. Servers at 8765 and 8780 restarted with rebuilt code. Focused CLI/server/UI regression cases added but not run; no separate typecheck run. Real agent configuration was not modified. Unsupported TOML layouts fail validation before any config writes.
