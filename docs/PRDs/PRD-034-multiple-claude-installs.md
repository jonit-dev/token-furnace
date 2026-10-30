# PRD-034 — Multiple Claude Code installs on one machine

**Status:** IMPLEMENTED — review corrections verified locally; approval pending.
**Priority:** P1 — Every Claude Code install on the machine is found automatically and reported as its own provider, with its own plan reading, limits and cache rows.
**Complexity:** 6 (MEDIUM); breadth 16+ files (3), credential selection across accounts (2), external keychain/OAuth integration (1). Each phase is independently verifiable and reversible; the cache is regenerable.
**Owner:** Unassigned
**Depends on:** None

## Context

- **Problem:** token-furnace reads exactly one Claude Code config dir per run, so a second install on the same machine (a separate account with its own weekly limit) is invisible, or gets mixed with the first one.
- **Goal:** one plain `token-furnace` run (no flags, no env) lists every Claude Code install on the machine as a separate provider, each with its own sessions, burn, plan reading and calibrated limit. Alternating or concurrent runs never evict or mix another install's data.
- **Non-goals:** budgets/enforcement (PRD-030); installs on other machines or in containers; more than one Codex or OpenCode home; reverse-engineering account identity from the OAuth token.

How a second install happens: Claude Code honours `CLAUDE_CONFIG_DIR`, usually set from a shell alias or wrapper. The dir name is arbitrary (`~/.claude-work`, `~/.cc2`, `/Volumes/x/claude`), so detection must recognize a Claude Code config dir by its contents and by where `CLAUDE_CONFIG_DIR` is set, never by one naming pattern.

Facts Claude Code itself establishes (verified on macOS 2026-10-30):
- The default install uses `~/.claude` plus `~/.claude.json`. A custom install keeps both inside the dir: `<dir>/projects/*/*.jsonl`, `<dir>/.claude.json`, `<dir>/settings.json`.
- The default install's Keychain item is `Claude Code-credentials`. A custom install's is `Claude Code-credentials-<h>`, where `<h>` is the first 8 hex chars of `sha256(<dir>)` with no trailing slash (`/Users/x/.claude-personal` → `accd0a65`, matching the live Keychain item).
- Neither install wrote `.credentials.json`; on macOS the Keychain is the only token store.

**Files analyzed:** `src/sources/claude.ts`, `src/sources/index.ts`, `src/compose.ts`, `src/core/model.ts`, `src/core/providers.ts`, `src/core/analyze/{report,view,issues,config-checks}.ts`, `src/services/{usage-client,report-service,processes,session-agents}.ts`, `src/repo/sqlite-repo.ts`, `src/setup/agents.ts`, `src/server.ts`, `src/cli.ts`, `web/src/{App.tsx,store.ts}`, `web/src/components/{panels,charts,ui,tips,fix-config}.tsx`, `test/harness.ts`, `test/fixtures/build.ts`, `SKILL.md`, `README.md`.

**Current behavior (verified against code):**
- `ClaudeSource.base()` (`src/sources/claude.ts:25-27`) returns `CLAUDE_CONFIG_DIR || ~/.claude`. `compose.ts:27-30` builds one `ClaudeSource`. `Source` (`src/core/model.ts:3`) is the closed union `claude | codex | opencode`, used as the key of `burns`, `limits.json`, cache rows and API filters.
- `sqlite-repo.ts changed()` (170-197) deletes every cached path the current scan did not list, across all sources. A run against another install evicts this install's rows; two concurrent `serve` processes delete each other's rows, and `all()` (216-218) can return the other install's sessions.
- `usage-client.ts accessToken()` (66-87) reads `<dir>/.credentials.json`, else the fixed Keychain item `Claude Code-credentials`. Every install therefore gets the default account's plan reading. The saved reading `usage.json` (17-20) and `limits.json` (`report-service.ts:194-224`) each hold one global Claude slot.
- `processes.ts:29-43` counts every `claude -p` process as `claude`. `issues.ts:22`, `providers.ts:10` and `web/src/components/tips.tsx:13` print `~/.claude/...` paths whichever install was scanned. `setup/agents.ts:161` tracks `~/.claude.json` even when `claudeDir` is a custom dir.

## Solution

- **Discovery** (`src/sources/claude-installs.ts`, new): collect candidate dirs from four signals, keep those that look like Claude Code, dedupe by `realpath`:
  1. `~/.claude` (the default install), present or not as today.
  2. `CLAUDE_CONFIG_DIR` from the process env.
  3. Every first-level dir under `$HOME` and `${XDG_CONFIG_HOME:-~/.config}` that contains a `projects/` dir holding `*/*.jsonl`, plus at least one of `.claude.json`, `settings.json`, `history.jsonl`. Name-agnostic, stat-only, no recursion past depth 1.
  4. Literal `CLAUDE_CONFIG_DIR=<path>` assignments in shell startup files (`~/.zshrc`, `~/.zprofile`, `~/.zshenv`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, `~/.config/fish/config.fish`), with `~`, `$HOME` and `${HOME}` expanded and quotes stripped. Any other variable makes the value unresolvable, and it is skipped. Nothing is executed. This finds installs outside `$HOME`'s first level.
- **Identity:** the default install keeps id `claude` (so caches, `limits.json` and URLs stay valid). Every other install gets id `claude:<slug>`, where the slug is the dir basename with the leading dot and a leading `claude`/separator removed (`.claude-work` → `work`, `.cc2` → `cc2`), with `-2`, `-3` appended on collision. The label is `Claude Code (<slug>)`.
- **Kind vs instance:** `Source` stays the provider kind union. A new `ProviderId = string` keys instances everywhere that currently keys on `Source` at runtime (`burns`, cache `files.source`, `limits.json`, API `?source=`, web state). `kindOf(id)` takes the part before `:` and is the only way to reach `PROVIDERS[...]` (parser version, colors, config checks).
- **Per-install plan reading:** `accessToken(install)` tries `<dir>/.credentials.json`, then the Keychain service `Claude Code-credentials` for the default install or `Claude Code-credentials-<sha256(dir)[0:8]>` otherwise. Saved readings are keyed by install id. The OpenCode in-memory map and throttle pattern (`usage-client.ts:122-137`) is reused per id.
- **Display:** every install is its own provider: its own option in the per-card provider dropdowns, its own line in the weekly chart, its own burn and active counts. Styling (badge, color family) comes from the kind; a secondary install takes the kind's color with a dashed line in charts.

**Integration points**
- Entry: every CLI/server run → `compose()` → `discoverClaudeInstalls(env)` → one `ClaudeSource` per install → `sources` record keyed by id.
- Report: `report-service.ts` scans the union of all installs' files → `report.ts`/`view.ts` emit `burns[id]` plus additive `providers: {id, kind, label, dir}[]` → `GET /api/report` → `web/src/App.tsx` derives `sources` from `providers`.
- Flow: the user starts `claude` and a second install via any alias → runs `token-furnace` or opens the dashboard → both installs appear as providers, each with its own week meter fed by its own Keychain login.

**Key decisions**
- Content-based detection plus shell rc parsing instead of a configured list: zero setup, and any naming scheme works. An explicit override (`TOKEN_FURNACE_CLAUDE_DIRS`) is deferred to Open Questions.
- The default install keeps id `claude`, so no cache wipe or `limits.json` migration is needed: `files.source` already stores a string. A custom env install never takes the default identity.
- Numeric collision suffixes are reserved atomically with symlinks under the existing cache’s `claude-installs/` directory. Reservations survive discovery changes and remain in use with `--no-cache`; an unreadable reservation fails rather than reassigning another install’s limits.
- No new dependencies: `node:crypto` for the hash, `node:fs` for discovery, the existing `security` call for the Keychain.

**Data changes**
- `files.source` stores the instance id (`claude`, `claude:work`, ...). `SCHEMA_VERSION` is unchanged; parser version lookup goes through `kindOf`.
- Custom saved usage readings include their source directory; a mismatched directory is unavailable.
- `limits.json`: additive keys per instance id. `usage.json` remains the default install's file; other installs use `usage-<slug>.json` in the same dir. This keeps the status-line contract in `SKILL.md` backwards compatible.

**Contracts**
```ts
// src/sources/claude-installs.ts
export interface ClaudeInstall {
  id: string;            // "claude" | `claude:${slug}`
  label: string;         // "Claude Code" | `Claude Code (${slug})`
  dir: string;           // realpath of the config dir
  isDefault: boolean;    // realpath(dir) === realpath(~/.claude)
  found: Array<"default" | "env" | "scan" | "shell-rc">;
}
export function discoverClaudeInstalls(env: Env): ClaudeInstall[]; // default first, then by label
// report payload, additive
providers: { id: string; kind: Source; label: string; dir?: string }[];
```

**Risks**
- *False positives:* a backup copy of `~/.claude` would show up as an install. Mitigation: dedupe by realpath and require the marker files. A copy is a legitimate dir of transcripts anyway; label it by its path.
- *Keychain hash format* is Claude Code's internal behavior and could change. Mitigation: try `.credentials.json` first; a missing item yields "plan reading unavailable" for that install, never another account's reading.
- *Scan cost:* one `readdir` of `$HOME` plus a few `stat`s per entry. Must stay within the PRD-009 scan budget; covered by `scripts/bench-scan.mjs`.
- *Privacy:* shell rc files are read only for the `CLAUDE_CONFIG_DIR=` pattern; no other content is kept or logged.

## Execution Constraints

- **Regression safety:** Phase 1 adds characterization tests of today's single-install behavior before any code moves. With only `~/.claude` present, the report, cache, `limits.json`, `usage.json` and API output must be byte-for-byte unchanged apart from the additive `providers` field.
- **Generality:** no install name, alias or path from any one machine appears in code or tests. Fixtures use arbitrary names (`.cc-work`, `.agentx`, an install outside `$HOME` referenced only from a fixture `.zshrc`).
- **Credential safety:** tokens are never cached, logged or sent anywhere except `api.anthropic.com`, as today. An install whose token cannot be resolved shows "plan reading unavailable"; it never falls back to another install's Keychain item.
- **Environment safety:** tests use `harnessEnv` temp roots with `HOME` pointed into the temp dir. No test touches the real Keychain; `security` is injected or stubbed.
- **Branch/PR plan:** one branch `feat/prd-034-multiple-claude-installs`, one draft PR opened before Phase 1, each phase pushed to it, PRD boxes ticked in the same push as the code.

## Dependencies and Parallelization

- **Blocked by:** None.
- **Blocks:** PRD-030 should use `ProviderId`/`ClaudeInstall` as its Claude account identity instead of inventing one.
- **Parallelization:** Phase 1 → Phase 2 are sequential (Phase 2 changes the types everything else uses). After Phase 2, Phases 3, 4 and 5 touch disjoint files and can run in parallel worktrees. Phase 6 depends on Phase 2 only.

## Execution Phases

#### Phase 1: Baseline characterization
**Status:** DONE
**Dependencies:** None

**Files:**
- `test/claude-installs.test.ts` — new; baseline block
- `test/fixtures/build.ts` — helper to build a Claude config dir at an arbitrary path

**Implementation:**
- [x] Add `buildClaudeInstall(root, relDir, opts)` writing `projects/*/*.jsonl`, `.claude.json`, `settings.json`.
- [x] Snapshot the current report `burns`, cache rows, `limits.json` and `/api/report` for a single default install.

**Tests required:**
- `test/claude-installs.test.ts` — single-install snapshot; a run with `CLAUDE_CONFIG_DIR` set still reads that dir.

**Verification:**
- Command: `npx vitest run test/claude-installs.test.ts`
- Expected: all tests pass on unmodified `src/`.

#### Phase 2: Discovery and instance identity — `--list-sources` shows every install
**Status:** DONE
**Dependencies:** Phase 1

**Files:**
- `src/sources/claude-installs.ts` — new; `discoverClaudeInstalls`
- `src/sources/claude.ts` — constructor takes a `ClaudeInstall`; `base()`/`home()` return `install.dir`; turns carry `source: install.id`
- `src/core/model.ts`, `src/core/providers.ts` — `ProviderId`, `kindOf()`
- `src/sources/index.ts`, `src/compose.ts` — build one source per install; `sources` keyed by id
- `src/cli.ts` — `--source` accepts ids; `--list-sources` prints id, label, dir and transcript count

**Implementation:**
- [x] Implement the four discovery signals, the marker check, realpath dedupe, slug/label rules and ordering.
- [x] Replace runtime `Source` keys with `ProviderId` where they key instances; route `PROVIDERS[...]` lookups through `kindOf`. Fix the literal triples (`report-service.ts:203,218,264`, `notifications.ts:445`) to iterate `sources`.
- [x] `session-agents.ts:36` and `server.ts:110` resolve sources by id.

**Tests required:**
- `test/claude-installs.test.ts` — finds default + `.cc-work` (scan) + an outside-`$HOME` dir (shell rc, with `$HOME` and `~` forms); ignores a dir without markers, an unresolvable `$OTHER/x` value and a symlink to `~/.claude`; `CLAUDE_CONFIG_DIR == ~/.claude` yields one install; slug collisions get suffixes.
- `test/provider-detection.test.ts` — no longer hard-codes the provider list.

**Verification:**
- Command: `npx vitest run test/claude-installs.test.ts test/provider-detection.test.ts && npm run typecheck`
- Expected: pass; baseline snapshot unchanged.

**Manual verification:** `npm run build && env -u CLAUDE_CONFIG_DIR node dist/cli.js --list-sources` on a machine with two installs lists both.

#### Phase 3: Cache scoped per install — runs never evict each other
**Status:** DONE
**Dependencies:** Phase 2

**Files:**
- `src/repo/sqlite-repo.ts` — `changed()` deletes only rows whose `source` is in the scanned id set; parser version via `kindOf`
- `src/services/report-service.ts` — pass the scanned id set

**Implementation:**
- [x] Scope eviction to the scanned ids; `save()` stops silently dropping unknown ids (log once via the existing error path).

**Tests required:**
- `test/claude-installs.test.ts` — run with install A only, then A+B, then A only again: B's rows survive and are not re-parsed (mtime unchanged); two app instances sharing one cache file each return only their own sessions.

**Verification:**
- Command: `npx vitest run test/claude-installs.test.ts test/sqlite-repo.test.ts`
- Expected: pass.

#### Phase 4: Per-install plan reading and limits
**Status:** DONE
**Dependencies:** Phase 2

**Files:**
- `src/services/usage-client.ts` — `accessToken(install)` with the Keychain service by hash; readings, throttle and saved file keyed by id
- `src/core/analyze/report.ts` — `planWeek` per Claude install instead of one literal binding
- `src/services/report-service.ts` — `limits.json` keyed by id
- `SKILL.md`, `README.md` — `usage-<slug>.json` for non-default installs; multi-install detection described

**Implementation:**
- [x] Inject the `security` runner so tests can assert which service name was queried.
- [x] A missing token or Keychain item gives `plan: unavailable` for that install only.

**Tests required:**
- `test/usage-client.test.ts` — the default install queries `Claude Code-credentials`; `/tmp/x/.cc-work` queries `Claude Code-credentials-<first 8 of sha256>`; `.credentials.json` wins when present; no cross-install fallback; a fresh reading for A is not served to B.
- `test/report-service.test.ts` — `limits.json` floors each install independently; the legacy `{"claude": n}` file is still honored.

**Verification:**
- Command: `npx vitest run test/usage-client.test.ts test/report-service.test.ts`
- Expected: pass.

#### Phase 5: API and dashboard show each install as a provider
**Status:** DONE
**Dependencies:** Phase 2

**Files:**
- `src/core/analyze/view.ts`, `src/server.ts` — additive `providers` list; `?source=` accepts any discovered id, and an unknown id returns 400 instead of the default
- `web/src/App.tsx`, `web/src/store.ts` — sources from `providers`; pins persist by id
- `web/src/components/ui.tsx`, `charts.tsx`, `panels.tsx` — badge/color by `kind`, label from `providers`, dashed line for secondary installs
- `web/src/components/fix-config.tsx` — agent list from the report, not `["claude","codex"]`

**Implementation:**
- [x] Empty state: an install with no sessions in range still appears in dropdowns with "No sessions in range".
- [x] Error state: an install with an unavailable plan reading shows the existing "usage unavailable" treatment, not 0%.

**Tests required:**
- `web/src/app.test.tsx` — two Claude providers render in the dropdowns and the weekly chart with distinct labels; pin survives reload.
- `test/server.test.ts` — `?source=claude:work` filters; unknown id → 400.

**Verification:**
- Command: `npx vitest run web/src/app.test.tsx test/server.test.ts && npm run typecheck`
- Expected: pass.

#### Phase 6: Setup, fix-config and advice per install
**Status:** DONE
**Dependencies:** Phase 2

**Files:**
- `src/setup/agents.ts` — setup/fix-config/rollback iterate installs; track `<dir>/.claude.json` for custom installs (`~/.claude.json` for default); backups namespaced by install id
- `src/core/analyze/issues.ts`, `src/core/providers.ts`, `src/core/analyze/config-checks.ts` — paths in advice use the install's dir
- `web/src/components/tips.tsx` — skill install path from the selected install
- `src/services/processes.ts` — unchanged attribution (see Open Questions); headless counts stay on the default install

**Implementation:**
- [x] `setup` prints each install it will change and applies to all of them; `--rollback` restores per install.

**Tests required:**
- `test/setup.test.ts` — two installs both receive hooks/skill; rollback restores both, including each `.claude.json`.
- `web/src/app.test.tsx:408` — assertion updated to the install-specific path.

**Verification:**
- Command: `npm run check && npm run smoke`
- Expected: typecheck and all tests pass; smoke passes.

## Acceptance Criteria
- [x] AC-1 [local]: a plain run with no env discovers every Claude Code install via the four signals, independent of dir name — proof: `npx vitest run test/claude-installs.test.ts`.
- [x] AC-2 [local]: with only `~/.claude`, report, cache, `limits.json`, `usage.json` and API output match the Phase 1 baseline apart from the additive `providers` field — proof: Phase 1 snapshot test.
- [x] AC-3 [local]: alternating and concurrent runs never evict or show another install's sessions — proof: Phase 3 tests.
- [x] AC-4 [local]: each install's plan reading uses its own credentials, and an unresolvable install shows "unavailable" rather than another account's data — proof: `npx vitest run test/usage-client.test.ts`.
- [x] AC-5 [local]: the dashboard shows each install as its own provider, with loading, empty and unavailable states — proof: `npx vitest run web/src/app.test.tsx`.
- [x] AC-6 [local]: setup, fix-config, rollback and advice text target the right install's files — proof: `npx vitest run test/setup.test.ts`.
- [x] AC-7 [local]: scan time with two installs stays within the PRD-009 under-10-second budget — proof: `node scripts/bench-scan.mjs run --mode warm --runs 1 --timeout 240` (PRD-009 snapshot flow).
- [x] AC-8 [local]: `npm run check` and `npm run smoke` pass; README and SKILL.md describe multi-install detection and `usage-<slug>.json`.

## Open Questions
- **Explicit override for undiscoverable installs** (e.g. a dir set only inside a wrapper script outside the shell rc files). Options: a `TOKEN_FURNACE_CLAUDE_DIRS` env list, or nothing. Default if unanswered: nothing until someone hits it.
- **Headless `claude -p` attribution.** Reading each process's `CLAUDE_CONFIG_DIR` needs `ps -E` / `/proc/<pid>/environ`, which exposes every env var, tokens included. Default: keep counting them under the default install and say so in the tooltip.
- **Keychain items with no matching dir** (a login whose config dir was not found). Listing them needs `security dump-keychain`. Default: not detected.
- **Linux/Windows token store** for custom installs: assumed to be `<dir>/.credentials.json` (already read first). Unverified on those platforms.

## Local verification — 2026-10-30

- The single-install characterization snapshot was recorded before production changes and remains unchanged. The final suite verifies it.
- `npm run build`: passed. With `CLAUDE_CONFIG_DIR` unset, `--list-sources` found both real Claude installs (290 and 168 transcripts) and Codex (1,198 transcripts).
- `npm run check`: type checking passed; 32 test files passed, 367 tests passed, one existing test skipped. Coverage includes concurrent suffix reservation, A/A+B/A cache reuse, exact HOME expansion and quoted aliases, injected Keychain service selection, independent limits, 100% readings, dashboard loading/empty/unavailable states, and setup/fix/rollback after discovery changes.
- `npm run smoke`: all package, installed CLI, HTML, and server checks passed.
- PRD-009 snapshot flow: froze 1,656 actual transcripts totaling 6,090,509,442 bytes from two Claude installs and Codex. The manifest contains 1,658 files including two empty config markers. Credentials and secret configuration were excluded.
- `node scripts/bench-scan.mjs run --base <private snapshot directory> --mode warm --runs 1 --timeout 240`: 0.821 seconds, exit 0, valid report, matching frozen report oracle. This verifies the warm scan budget on this machine; it does not measure cold scans or other hardware.
- Symlink regression: discovery directories equal `realpathSync`; the single-install helper canonicalizes both config and default directories before selecting the Keychain service. Temporary HOME roots are canonical; characterization snapshot bytes remain unchanged.
- No live Keychain access or usage API request was needed for verification. Credential tests use temporary homes and an injected runner. Windows and Linux custom token stores remain unverified.

### Review corrections

Nine regression cases first reproduced the reported failures, then passed with the fixes:

- Newer saved usage readings update a running process after a failed login attempt, including weekly resets; another install’s readings remain isolated.
- Rollback runs before discovery. Backups without a file manifest restore only the original five tracked files, preserving secondary installs even when identity reservations are blocked.
- Idle legacy providers keep their previous `burns` and top-level `burn` behavior. Secondary providers remain selectable when empty. A settings-only default directory is not treated as a transcript source.
- Auto Fixes offers Claude repairs for a custom-only install by matching the provider kind.
- Setup, verify, and fix-config leave an absent default directory absent when a custom install exists. Fresh-machine setup still creates the default install.

The original performance oracle is preserved. It included the idle default burn corrected above, so its report comparison fails as expected.
A separate snapshot contains identical frozen file bytes and the same clock. After snapshot-path normalization, the only report changes are removal of the idle default burn and the resulting top-level fallback.
The new warm benchmark matches its own oracle in 0.821 seconds. Type checking, all 32 test files, and package smoke pass after these corrections.
