# PRD-017 — Public npm release

**Status:** IN PROGRESS
**Priority:** P1 — publish the pending dashboard and loading improvements
**Complexity:** 3 → LOW; risk override: none
**Owner:** Codex
**Depends on:** None

## Scope
User authorized committing all pending changes and publishing publicly. Reuse the current checkout to preserve that work. Update README badges, quick start, contribution guidance and stale release claims; add npm discovery metadata and a build-before-pack hook. Correct the existing TOML type mismatch without changing runtime behavior. Release the next patch after checking npm availability.

Integration: unchanged — npx → dist/cli.js → report / HTML / loopback dashboard. Existing package smoke exercises installed consumers and isolated transcript data.

## Acceptance criteria
- [x] AC-1 [local]: README quick start, badges and package metadata describe the actual public project. Proof: document/diff review.
- [x] AC-2 [local]: Typechecks and full tests pass; packaged npx, HTML and server work on supported Node. Proof: npm run typecheck, npm test, npm run smoke.
- [ ] AC-3 [shared, Codex]: All pending work committed and pushed; npm latest points at the new version and fresh-cache registry npx works. Proof: git remote SHA, npm view, isolated npm exec.

## Phases
1. Documentation, metadata and type correction.
2. Build, tests and installed package smoke.
3. Commit, push, publish and verify registry consumer.

## Results
`npm run typecheck` passed on Node 24.21.0. `npm test -- --maxWorkers=2` passed all 158 tests in 19 files; the initial unrestricted run exceeded the progress endpoint timing threshold (232 ms versus 200 ms) under contention. Package smoke passed on Node 22.13.0 and 24.21.0, including installed npx JSON, HTML export and live dashboard routes. `npm audit --omit=dev` found zero vulnerabilities. Prepack rebuild logs go to stderr so npm pack JSON remains parseable. Publication and remote verification pending.
