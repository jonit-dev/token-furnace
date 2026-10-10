# PRD-001 — Scaffold the package and port the transcript sources

**Status:** DONE
**Priority:** P1 — every later PRD builds on the package and the `Turn` stream.
**Complexity:** 4 (MEDIUM)
**Owner:** João
**Depends on:** None

## Context

- `scripts/burn.py` reads Claude transcripts (`claude_files`, `claude_turns`, `claude_title`, `claude_user_wake`, lines 122–211) and Codex transcripts (`codex_files`, `codex_turns`, lines 212–282). Both yield `turn()` dicts (`burn.py:81`).
- `classify_prompt()` (`burn.py:105`) and `is_read()` (`burn.py:101`, with `READ_COMMAND` and `READ_TOOLS`) decide `wakes` and `reads`.
- The repository has no `package.json`, no `.gitignore`, and a tracked `scripts/__pycache__/`.
- This machine runs Node 20.19.6. `node:sqlite` and the `engines` field need Node 22.13 or later.

## Solution

- A single-package TypeScript project, as in architecture.md "Target layout": `package.json`, `tsconfig.json` (`strict`), Vitest, tsup.
- `src/core/model.ts` with `Turn`, `Wake`, and `Source` from schema.md.
- `src/sources/agent-source.ts` with the `AgentSource` interface:

```ts
interface AgentSource {
  name: Source;
  root(): string;                                   // directory that proves the agent is installed
  files(): { path: string; mtimeMs: number; size: number }[];
  parse(path: string): { turns: Turn[]; title: string | null; badLines: number };
}
```

- `ClaudeSource` and `CodexSource` port the Python parsers line for line. They take `env` in the constructor, so tests point them at fixture directories.

## Acceptance Criteria

- [x] AC-0 [local]: `node -v` prints 22.13 or later. proof: `node -v` — Evidence: v24.16.0 on PATH from `$HOME/.nvm/versions/node/v24.16.0/bin` (default 20.19.6 is too old).
- [x] AC-1 [local]: `npm run build` and `npx tsc --noEmit` pass on the new package. proof: `npm run build && npx tsc --noEmit` — Evidence: tsup v8.5.1 wrote 4 ESM files + 4 `.d.ts` in 24 ms/2.1 s, `tsc --noEmit` exit 0.
- [x] AC-2 [local]: `ClaudeSource.parse()` on the Claude fixture gives the same turns as `claude_turns()` (same count, tokens, tools, reads, wakes, and title). proof: `npx vitest run test/sources.test.ts` — Evidence: 8/8 pass; literals recorded from `burn.claude_turns()`/`burn.claude_title()` give 2 turns, tools `["Bash","Read"]`/`["Edit"]`, reads 2/0, wakes `[human,teammate,task,peer]`/`[]`, title `"Leak hunt"`.
- [x] AC-3 [local]: `CodexSource.parse()` on the Codex fixture gives the same turns as `codex_turns()`. proof: `npx vitest run test/sources.test.ts` — Evidence: same run; literals from `burn.codex_turns()` give 2 turns, session `0a1b2c3d`, project `api`, base_in 600/400, reads 1/0, title `null`.
- [x] AC-4 [local]: A fixture with one malformed line yields every other turn and `badLines: 1`. proof: `npx vitest run test/sources.test.ts` — Evidence: one truncated line in each fixture; both parses report `badLines: 1` and still return every valid turn.
- [x] AC-5 [local]: `src/core/` imports nothing outside `src/core/`. proof: `grep -rn "from '\.\./\.\." src/core` returns no lines — Evidence: no output, exit 1 (`src/core/model.ts` has no imports at all).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Claude transcripts | `ClaudeSource` → `ReportService` (PRD-003) | `claude_*` in `burn.py`, deleted in PRD-003 | AC-2 |
| Codex transcripts | `CodexSource` → `ReportService` (PRD-003) | `codex_*` in `burn.py`, deleted in PRD-003 | AC-3 |

Until PRD-003, the only consumer is the test suite. This is accepted: PRD-002 and PRD-003 wire the sources in.

## Execution Phases

#### Phase 0: Node upgrade
**Status:** DONE
**Files:** none
**Implementation:** João installs Node 22.13 or later (or 24 LTS) with the system package manager or a version manager.
**Verification:** `node -v` — AC-0.

#### Phase 1: Package scaffold
**Status:** DONE
**Files:** `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`, `src/core/model.ts`
**Implementation:** `name: token-furnace`, `type: module`, `engines.node: ">=22.13"`, `bin: { "token-furnace": "dist/cli.js" }`. Scripts: `build`, `test`, `typecheck`. `.gitignore` holds `node_modules/`, `dist/`, `__pycache__/`. Run `git rm -r --cached scripts/__pycache__`. Do not add Express or React yet.
**Verification:** `npm run build && npx tsc --noEmit` — AC-1.

#### Phase 2: Fixtures and Claude source
**Status:** DONE
**Files:** `src/sources/agent-source.ts`, `src/sources/claude.ts`, `test/fixtures/claude/`, `test/sources.test.ts`
**Implementation:** Read `burn.py:96–211` fully first. Build the fixture with the same record helpers as `scripts/test_burn.py` (`record`, `assistant`, `user`): human, teammate, task, and peer wakes, a `Bash` read, a `Read` call, a title, and one malformed line. Record the expected values by running the Python parser once on the fixture, and write them into the test as literals.
**Verification:** `npx vitest run test/sources.test.ts` — AC-2, AC-4.

#### Phase 3: Codex source
**Status:** DONE
**Files:** `src/sources/codex.ts`, `test/fixtures/codex/`, `test/sources.test.ts`
**Implementation:** Read `burn.py:212–282` fully first. Same method as Phase 2. Keep `CODEX_HOME` support.
**Verification:** `npx vitest run test/sources.test.ts` — AC-3, AC-5.
