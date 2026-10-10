# PRD-007 — Package smoke test and release

**Status:** NOT STARTED
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

- [ ] AC-1 [local]: `npm run smoke` on Node 22.13 runs `npx ./token-furnace-*.tgz --json` against fixtures and gets a valid `Report`. proof: `npm run smoke` — Evidence: pending.
- [ ] AC-2 [local]: The same smoke run passes on Node 24. proof: `npx -p node@24 npm run smoke` — Evidence: pending.
- [ ] AC-3 [local]: The tarball contains no `.py`, `.sh`, test, or fixture files. proof: `npm pack --dry-run` — Evidence: pending.
- [ ] AC-4 [local]: The root `README.md` documents every command in architecture.md "Entry points", plus the cache path and `--no-plan-usage`. proof: review against architecture.md — Evidence: pending.

## Blocked on

- Publishing to npm — unblocked by João, who confirms that the package name `token-furnace` is free and runs `npm publish`.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| npx install | `npx token-furnace` → `package.json` `bin` → `dist/cli.js` | `scripts/doctor` (removed in PRD-003) | AC-1, AC-2 |

## Execution Phases

#### Phase 1: Package contents and smoke script
**Status:** NOT STARTED
**Files:** `package.json`, `scripts/smoke.mjs`
**Implementation:** Set `files`, `bin`, and `engines`. The smoke script runs `npm pack`, makes a temp dir, copies the fixtures into a temp `HOME`, and runs the tarball with `npx`.
**Verification:** `npm run smoke` on Node 22.13 and 24 — AC-1, AC-2. `npm pack --dry-run` — AC-3.

#### Phase 2: User README
**Status:** NOT STARTED
**Files:** `README.md`
**Implementation:** Install, commands, privacy statement, cache path, how to delete the cache, and the opt-out network flag.
**Verification:** Compare with architecture.md "Entry points" — AC-4.
