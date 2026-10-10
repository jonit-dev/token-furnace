# PRD-007 — Package smoke test and release

**Status:** COMPLETE (LOCAL PREPARATION) — npm publish pending the package owner (João)
**Priority:** P2 — AC-1 and AC-2 prove the `npx` install path that the epic exists to deliver.
**Complexity:** 2 (LOW)
**Owner:** João
**Depends on:** PRD-005, PRD-006, PRD-008

## Context

PRDs 001 to 006 produce a working package from the repository. This PRD proves that the packed tarball works on a clean machine, and prepares the release.

## Solution

- `package.json` `files` contains only `dist/`, `SKILL.md`, `references/`, and `README.md`.
- `npm run smoke` packs the tarball, then runs it with `npx` in a temp directory with a temp `HOME` that contains fixture transcripts.
- A user-facing `README.md` at the repository root covers install, commands, privacy, and the cache location.

## Acceptance Criteria

- [x] AC-1 [local]: `npm run smoke` on Node 22.13 installs the packed tarball in a temp directory and runs `npx --no-install token-furnace --json` against fixtures and gets a valid `Report`. proof: `npm run smoke` — Evidence: full smoke passed on Node 22.13 (pack, temp install, `npx --no-install` CLI, `--html`, `serve`, distinct totals, no external assets). The earlier Node 22 failure was an inherited `npm_config_package` from the `npm exec` wrapper; the smoke script now clears it.
- [x] AC-2 [local]: The same smoke run passes on Node 24. proof: `npx -p node@24 npm run smoke` — Evidence: full smoke passed on Node 24.16.
- [x] AC-3 [local]: The tarball contains no `.py`, `.sh`, test, or fixture files. proof: `npm pack --dry-run` — Evidence: smoke forbidden-file check passes; application allowlist is `dist/`, `SKILL.md`, `references/`, `README.md`, plus npm metadata and the license.
- [x] AC-4 [local]: The root `README.md` documents every command in architecture.md "Entry points", plus the cache path and `--no-plan-usage`. proof: review against architecture.md — Evidence: every entry point, the cache path, and `--no-plan-usage` are present.

## Blocked on

- Publishing to npm — owner gate. João runs `npm publish` after the package-name check. Local preparation is complete; no other work remains.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| npx install | `npx token-furnace` → `package.json` `bin` → `dist/cli.js` | `scripts/doctor` (removed in PRD-003) | AC-1, AC-2 |

## Execution Phases

#### Phase 1: Package contents and smoke script
**Status:** COMPLETE
**Files:** `package.json`, `scripts/smoke.mjs`
**Implementation:** Set `files`, `bin`, and `engines`. The smoke script runs `npm pack`, makes a temp dir, copies the fixtures into a temp `HOME`, and runs the tarball with `npx`.
**Verification:** `npm run smoke` on Node 22.13 and 24 — AC-1, AC-2. `npm pack --dry-run` — AC-3. The smoke test installs the tarball, then runs `npx --no-install` on the same package and checks the CLI totals, `--html`, and `serve` routes match. The tarball must include `dist/scan-worker.js` and `dist/dashboard.html`. The full suite (86 tests), the root and web typechecks, and the build pass. Four CLI paths (cold workers, warm cache, inline main-thread, `--no-cache` workers) return identical `Report` JSON. Latest local snapshot: cold workers 2.853s, warm 0.545s, inline 5.794s, `--no-cache` workers 3.166s; `Report` JSON 32,529 bytes.

#### Phase 2: User README
**Status:** COMPLETE
**Files:** `README.md`
**Implementation:** Install, commands, privacy statement, cache path, how to delete the cache, and the opt-out network flag.
**Verification:** Compare with architecture.md "Entry points" — AC-4.
