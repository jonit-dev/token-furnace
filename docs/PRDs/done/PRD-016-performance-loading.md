# PRD-016 — Performance loading language

**Status:** DONE
**Complexity:** 1 → LOW; risk override: none

## Scope

Replace security-sensitive loading wording with “Measuring performance”. Show truthful task status below the explanation, derived from existing progress rather than a rotating timer. Keep the status API and CLI compatible.

## Acceptance

- [x] [local] Loading page uses performance language and explains local usage analysis.
- [x] [local] Status changes for preparation, token measurement, dashboard preparation and ready; progress and automatic reload still work.

## Execution

1. Update `src/render/loading.ts`; caller remains the server's loading route.
2. Exercise its inline script against status responses and run the existing progress integration test.

## Verification

Node 24: `vitest run test/loading.test.ts test/progress.test.ts` passes all 3 tests, including the server loading route and the inline polling script. `git diff --check` passes. `npm run typecheck` is blocked by an unrelated existing TS2322 at `src/setup/agents.ts:772` (`Record<string, unknown>` versus `TomlValue`); that file is untouched. No browser visual check. Existing unrelated workspace edits remain untouched.
