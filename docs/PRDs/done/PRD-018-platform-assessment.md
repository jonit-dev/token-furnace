# PRD-018 — Windows and macOS compatibility assessment

**Status:** DONE
**Priority:** P2 — Determine portability and concrete blockers before claiming support.
**Complexity:** 0 (LOW); risk override: none
**Owner:** Codex
**Depends on:** None

## Context
Assess the existing npm CLI, dashboard, setup/hook, and package checks from Linux. No Windows or macOS host is available. This task is an assessment, not platform certification or a feature implementation.

## Solution
Inspect platform assumptions, execute existing build/tests/package smoke on a supported Node runtime, and reproduce suspected failures with isolated inputs. Record findings here; keep product code unchanged.

## Acceptance Criteria
- [x] AC-1 [local]: Identify platform-specific behavior through CLI, setup and package entry points — proof: source inspection and isolated setup reproduction.
- [x] AC-2 [local]: Establish the Linux baseline on supported Node — proof: `npm run typecheck`, `npm test`, `npm run smoke` using Node 24.
- [x] AC-3 [local]: Deliver a qualified Windows/macOS verdict with concrete limitations — proof: findings below and final response.

## Integration Ledger
Integration: unchanged — assessment only; no runtime behavior or wiring changes.

## Execution Phases
### Phase 1: Assess portability
**Status:** DONE
**Files:** This PRD; inspect src/, test/, scripts/, package.json and README.md.
**Implementation:** Trace paths, shell commands, SQLite, WASM, workers, setup and credentials. Reproduce without modifying real user configuration.
**Verification:** Existing checks and temporary-directory probes; native execution remains unverified and is not an assessment acceptance criterion.

## Findings

Assessment completed 2026-10-10. Product code is unchanged.

### Verdict
- **macOS:** Likely compatible with the scanner, CLI, HTML export and local dashboard. No macOS-only blocker found by inspection. Intel/Apple Silicon execution, Keychain credentials and agent hook invocation remain unverified.
- **Native Windows:** Core scanning/dashboard likely portable, but setup and configuration repair are not ready for normal environments without HOME. Read-heavy workflow measurements also undercount PowerShell commands.
- **WSL:** Expected to behave like Linux when Node and transcripts are inside WSL; native Windows transcripts are not discovered automatically across the environment boundary. Not executed in WSL.

### Confirmed blockers and smallest remedies
1. `src/setup/agents.ts:127`: `runSetup` uses `env.HOME ?? ""`, unlike the scanner/cache fallback to `os.homedir()`. With HOME removed and USERPROFILE plus agent overrides supplied, the built CLI dry run plans relative `.agents`, `.claude` and `.codex` paths instead of the supplied home. An apply would target the working directory. Remedy: use the shared home-resolution convention and respect agent directory overrides.
2. `src/setup/agents.ts:709`: `runFixConfig` requires HOME even with explicit CLAUDE_CONFIG_DIR/CODEX_HOME. Built CLI probe exits 1 and prints `fix-config: HOME must be set` to stdout. The dashboard Auto Fixes route calls the same function (`src/server.ts:133`), so it shares this blocker. Remedy: resolve home with `os.homedir()` rather than requiring HOME.
3. `src/sources/agent-source.ts:26`: read-command recognition is Unix-oriented. An assert probe confirms `cat src/main.ts` counts, but PowerShell `Get-Content src/main.ts` and cmd `type src\\main.ts` do not. Token totals can still parse; read-related diagnostics undercount. Remedy: recognize supported Windows read commands, with focused cases.

### Platform-specific risks, not reproduced failures
- Setup creates directory symlinks (`src/setup/agents.ts:446`) without a Windows junction strategy or permission fallback. Windows permissions/Developer Mode may prevent installation. Existing targets permit Node to detect directory type; missing explicit type is not itself proven broken. Generated `restore.sh` requires Bash, while `setup --rollback` restores through Node and does not execute that script.
- The hook command is `npx -y token-furnace hook churn`; it contains no Unix-only shell syntax. Claude Code documents Git Bash or PowerShell execution on Windows. PATH and PowerShell script policy still need native testing.
- The cache defaults to `~/.cache/token-furnace` on all platforms. This is unconventional on Windows/macOS, but not an inherent runtime failure.
- Plan usage reads `.credentials.json`, then tries macOS `security find-generic-password`. Credential storage/service-name compatibility and real API authentication were not checked; failure returns no fresh plan reading rather than preventing transcript scans.
- No external native addon installation is required by the scanner: SQLite is provided by Node and the Rust validator is embedded WebAssembly with a JavaScript parsing fallback. Source build scripts use portable Node tooling; Rust rebuild documentation and the local benchmark script contain Unix-specific paths and are not required for npm users.

### Verification
- Linux x64, Node **24.16.0**: `npm run typecheck` passed; `npm test` built CLI/dashboard and passed **159 tests in 19 files**; `npm run smoke` passed tarball installation, actual npx invocation, meaningful report totals, HTML export, worker-backed server routes and CLI/server parity.
- Temporary assert probes confirmed both HOME failures without applying setup or creating user configuration. The initial repair probe incorrectly expected the error on stderr; corrected to the implementation's stdout and passed.
- Both real transcript parsers produced identical turns and malformed-line counts with LF versus CRLF fixture files. Windows `path.win32.basename` handles both separator styles. These checks do not simulate Windows filesystem behavior.
- Existing tests need portability changes before a Windows CI matrix can be fully green: Unix path-string expectations (`test/sources.test.ts:102,127`), symlink privilege assumptions, and POSIX chmod permission-denial semantics (`test/setup.test.ts:477`). No Windows/macOS jobs exist in this checkout, and no native CI run was started.
- Recommended qualification: GitHub Actions on ubuntu/windows/macos with supported Node versions, running typecheck, tests and the existing installed-package smoke. Fix the confirmed HOME issues and Windows test assumptions first. Native runners are available as a future route without buying hardware; they were not exercised in this assessment.

### Official references
- [Node home resolution](https://nodejs.org/api/os.html#oshomedir): Windows uses USERPROFILE; POSIX uses HOME.
- [Node symlink behavior](https://nodejs.org/api/fs.html#fssymlinktarget-path-type-callback): directory detection and Windows junction semantics.
- [Node 22 SQLite](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html): unflagged from 22.13, matching the package minimum.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks): shell execution on Windows and PowerShell tool support.


## Follow-up
Runtime fixes, portable regressions and CI configuration are implemented in [PRD-020](PRD-020-platform-fixes.md). Native Windows/macOS qualification remains unverified. The previously cited hostile filename contains no Windows-forbidden characters; it is retained as a valid quoting test.
