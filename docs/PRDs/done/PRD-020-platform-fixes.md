# PRD-020 — Windows and macOS portability fixes

**Status:** DONE
**Priority:** P1 — Windows setup and Auto Fixes fail or target the wrong directory without HOME.
**Complexity:** 1 (LOW); risk override: none
**Owner:** Codex
**Depends on:** None

## Context
PRD-018 identified HOME assumptions, Unix-only read detection, directory symlink privileges and platform-dependent tests. Reuse its root-cause evidence. Runtime scope: setup/fix-config shared by CLI and dashboard; shell-read classification shared by both transcript parsers. No schema, dependency or release changes.

## Solution
Use the scanner's HOME-or-os.homedir convention in setup and repair. Respect agent directory overrides, create Windows directory junctions, recognize Windows read commands with command boundaries, invalidate previous Claude/Codex parser caches, and make tests portable. Add a Linux/Windows/macOS CI matrix for typecheck, full tests and installed-package smoke. Native runs require a future push; local completion proves implementation, not platform certification.

## Acceptance Criteria
- [x] AC-1 [local]: Setup and repair work without HOME, preserve overrides, backups and rollback — proof: targeted setup tests and built CLI probes.
- [x] AC-2 [local]: Both transcript parsers count Windows file reads without counting writes or similar command names — proof: source tests.
- [x] AC-3 [local]: Full tests, typecheck and installed-package smoke pass; platform CI is configured — proof: npm checks and workflow inspection.

## Integration Ledger
| Capability | Consumer | Evidence |
| --- | --- | --- |
| Home resolution and links | CLI setup → runSetup; CLI/dashboard fix-config → runFixConfig | AC-1 |
| Windows read measurements | ClaudeSource/CodexSource → isRead | AC-2 |
| Platform checks | GitHub Actions push/PR/manual → existing npm scripts | AC-3 |

## Execution Phases
### Phase 1: Regressions and fixes
**Status:** DONE
**Files:** src/setup/agents.ts, src/sources/agent-source.ts, src/sources/codex.ts, src/core/providers.ts, related setup/source/churn/SQLite tests, .github/workflows/ci.yml, README.md.
**Implementation:** Small shared-path fixes; retain existing validation and backups. No publish, deployment or credential changes.
**Verification:** Targeted regressions first, then full npm checks on Node 24. Native Windows/macOS and live Keychain remain unverified.

## Results
- Regressions failed on the original HOME handling, Windows read commands, Codex PowerShell command arrays and old parser-cache versions, then passed with the fixes.
- Linux x64: full `npm test` builds and **177 tests / 19 files** passed on **Node 24.16.0 and 22.13.0**. Typechecking passed on both runtimes.
- `npm run smoke` on Node 24.16.0 passed installed npx invocation, meaningful totals, HTML export, worker-backed server routes and CLI/server parity. The same installed-package smoke passed on Node 22.13.0.
- Built CLI probes without HOME passed: setup dry-run uses absolute OS-home paths plus custom agent overrides and writes nothing; fix-config updates both custom configurations only inside a temporary directory.
- Windows setup uses junctions; POSIX uses directory symlinks. Windows/macOS native execution, live agent-hook invocation and macOS Keychain authentication remain unverified. The six-job GitHub Actions matrix is configured, not executed; no push, publish or release was performed.
- Proportionate workflow/document checks and `git diff --check` passed. No added dependencies or database schema changes.
- Concurrent OpenCode implementation appeared in the primary checkout during this task. Its unfinished state caused combined-workspace typecheck/CLI-test failures. Qualification above uses the isolated portability change on base `c15d40012fa110a67bb87ccc75ce589c7945c6b7`; OpenCode changes were preserved. A scoped comparison confirms the same portability implementation and tests are present in the primary checkout, alongside its concurrent additions.
- The original assessment's claim about Windows-forbidden hostile-test filename characters was incorrect: those characters are valid on Windows. The hostile quoting test is retained; its unnecessary SQLite connection was removed to avoid Windows cleanup locks.

## Task checkout
Owner: this Codex session. Branch: `fix/windows-macos`. Path: `/home/joao/projects/token-furnace/.worktrees/windows-macos`. Base: `c15d40012fa110a67bb87ccc75ce589c7945c6b7`. Primary checkout receives the same scoped edits while preserving concurrent OpenCode work. Cleanup: completed. All verification processes exited; the checkout was clean except disposable npm-installed node_modules and generated dist. Scoped implementation/tests were compared with the primary checkout, and commit `c7fb520` on retained local branch `fix/windows-macos` preserves the complete isolated change. Ordinary `git worktree remove` removed the exact checkout (167 MB); its registration and directory were verified absent. No other checkout or branch was deleted.

