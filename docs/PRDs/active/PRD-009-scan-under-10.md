# PRD-009 — Full local scan under 10 seconds

**Status:** IN PROGRESS
**Priority:** P1 — the local dashboard still spends over a minute scanning; João requests under 10 seconds before publication.
**Complexity:** 3 (LOW); 1–5 implementation files + existing concurrency; risk override: none.
**Owner:** Codex
**Depends on:** PRD-004, PRD-008

## Contract

Minimize wall-clock time from the built CLI starting to a complete Report on João's full current local transcript corpus. An empty application cache is required for the primary metric; a partial report, reduced corpus, truncated sessions or changed semantics cannot satisfy it. Benchmark on this desktop, with a fixed clock, disabled plan network calls and unchanged inputs. Record competing load. The Debian laptop currently refuses work at 98 °C; recheck availability for jobs exceeding five minutes, but desktop latency remains the acceptance target.

Create one reusable benchmark command with immutable data manifest, evaluator and parity oracle before optimization. Keep detailed logs in an ignored task directory; summarize results here rather than creating a verification report. Initial experiment budget: four hypotheses, 240 seconds per run (every run uses the same cap; the earlier 120-second cap is historical), 30 minutes of experiments; replan if the target remains unmet. The evaluator refuses to overwrite an existing oracle and fails a run on any timeout, invalid report shape or oracle mismatch; `verify` adds the per-run under-10-second gate. Record baseline/candidate revisions and keep/discard decisions here.

Mutable surface: existing source parsers/line reader, worker pool and report-service scan path, plus focused tests. Preserve source detection, full Report output, SQLite invalidation/privacy, worker fallback, progress and Node 22.13 compatibility. Do not change core analysis to improve a benchmark score. Freeze the evaluator after the baseline.

## Acceptance criteria

- [ ] AC-1 [local]: Three full empty-application-cache runs on the unchanged real corpus each complete in under 10 seconds. proof: benchmark command and timings recorded below.
- [ ] AC-2 [local]: Warm-cache and changed-transcript startup also complete in under 10 seconds. proof: benchmark scenarios with explicit cache state.
- [ ] AC-3 [local]: Candidate full Report is byte-identical to the baseline on the same fixed inputs/clock. proof: benchmark oracle comparison plus targeted parser regressions.
- [ ] AC-4 [local]: Live server retains responsive progress, worker-backed initial parsing and safe fallback. proof: progress and parse-pool tests, then a real local browser load.
- [ ] AC-5 [local]: Build, affected tests and package smoke pass on Node 22.13 and 24. proof: existing commands after the accepted optimization.

## Phases

1. Establish baseline and identify the measured bottleneck.
2. Evaluate bounded hypotheses; retain only correct measured improvements.
3. Reproduce the target, integrate, restart the local dashboard, clean the task checkout and publish under João's authorization.

## Integration

Local browser → `serve` → `ReportService.refresh()` → parser workers/cache → complete Report. CLI `--json` exercises the same scan. Existing loading/progress routes remain reachable throughout.

## Results

Initial observation: the current server took over 65 seconds to parse 4.57 GB of a 6.97 GB changed-file set. This is a live observation, not the controlled baseline.

### Baseline (controlled, no source optimizations)

Per-run cap, unified: every `run` and `verify` invocation uses the same 240-second timeout. Commands: `node scripts/bench-scan.mjs snapshot`; then `run --mode cold --runs 1 --record-oracle --timeout 240`; then `run --mode warm --runs 1 --timeout 240`.
(Node 24.16.0; built CLI from `dist/cli.js`; evaluator `scripts/bench-scan.mjs`, sha `112248b93a14`; the harness records the full `dist` bundle hash, not a single-file hash.)

The snapshot `/home/joao/.cache/token-furnace-bench/snap-09Invw` and its oracle are the default and remain unchanged.

Historical numbers (recorded before the cap was unified; not controlled new runs):

- Corpus: 9,334 files, 27,535,814,891 bytes; frozen clock `2026-10-10T07:51:22.696Z`.
- Cold empty cache (fresh SQLite dir), 120 s cap: **timeout at 120.306 s**, no report.
- Cold full run with a lifted 1800 s cap: **154.382 s**, exit 0, valid complete report; oracle `sha256 ba7caba2c95b` recorded.
- Warm cache (prep then timed), 120 s cap: **6.936 s**, exit 0, report `sha256 ba7caba2c95b` (byte-identical to the cold oracle).

Historical baseline: full desktop cold scan is ~154 s, about 15x over the 10 s target. The warm path already meets 10 s. Phase 2 optimizes the cold path.

Attribution limits: host under external load (load1 15–30 on 24 logical CPUs; not our builds); the 120 s-capped cold run reports an actual timeout, the corpus was not reduced; the freeze reported an ~18 KB byte delta from transcripts appended during copy (count exact).

### Harness correction (not a new controlled run)

The baseline manifest was written from live-source stats and carried empty source identities, so a cold
run aborted at `frozen validation: entry 1373 not found` (one transcript grew ~18 KB between the source
walk and the frozen copy). The manifest was reinitialized once from the frozen destination metadata
(`reindex`), preserving the clock and all 9,334 files; the previous manifest is backed up at 0600.
Validation now keys source + relative path and compares frozen size and mtime, so two sources that
share a relative path are never confused and a live source never stands in for the frozen bytes. The
snapshot's oracle is untouched: `sha256 ba7caba2c95bacd27a8b61411c90308906433870f32571719b4287d95c4e4f8f`.

### Bounded experiments (full report parity preserved)

All completed candidates below exited 0 and matched the complete 52,002-byte oracle exactly. Cold means a fresh application cache; operating-system caches were not cleared. External host load varies, so single trials guide experiments and do not establish the final performance gate.

| Candidate | Workers | Seconds | Decision |
| --- | ---: | ---: | --- |
| Original, cache disabled | 8 | 42.802 | Isolates cache overhead |
| Original, CPU profile, cache disabled | 8 | 36.584 | Workers dominated by line splitting/decoding and reads |
| WAL/NORMAL cache | 8 | 31.222 | Keep |
| WAL plus byte line reader, 1 MiB reads | 8 | 19.603 | Keep |
| Same, 12 workers | 12 | 15.980 | Investigate default change |
| Same, 24 workers | 24 | 16.872 | Reject extra threads |
| Same, 8 MiB reads | 12 | 21.437 | Reject; reverted to 1 MiB |

The four initial hypotheses (cache, reader, worker count, read size) did not reach 10 seconds. Replan: two additional bounded trials within 10 minutes, targeting allocation for small files and scheduling large files earlier. Preserve all input data, source ordering in the final report, workers/fallback, and byte parity. No reduced corpus or partial-report completion.

Harness gates also reject nonzero process exits, missing oracle during final verification, failed warm priming, and any individual cold run >=10 seconds. Synthetic self-check passes including these failures. The 9,334-file, 27.54 GB snapshot is the full source tree; it also contains auxiliary/nested files the existing source discovery does not parse. Final measurements must distinguish snapshot size from the actual discovered transcript count/bytes.

### Final measured state of the retained candidate

Retained: WAL/NORMAL cache connections (with failed-open cleanup), byte-line reader with 1 MiB reads, and a default limit of 12 workers using available parallelism. Small-file buffer sizing and large-file dispatch were reverted after they failed to improve timings. Newest-first scheduling remains intact. The benchmark now clears shell worker overrides and measures the production default, rather than forcing the original 8-worker count.

Actual discovery within the unchanged frozen tree: Claude 719 files / 2,014,600,953 bytes; Codex 6,526 files / 11,414,174,391 bytes. Total **7,245 transcripts / 13,428,775,344 bytes**. Auxiliary files remain in the snapshot for complete source configuration and memory-index behavior.

- Three final application-cold runs: **15.954, 16.080, 20.707 seconds**. Each exited 0 and matched the full oracle; `verify --runs 3` correctly exited 1 because all three exceeded 10 seconds. AC-1 is **not met**.
- Three warm runs: **2.874, 2.850, 2.701 seconds**, all byte-identical to the oracle. Warm portion of AC-2 passes; changed-file performance is still pending.
- A separate CPU-profiled cold run: 13.717 seconds, full parity; 59.372 user CPU seconds + 25.203 system CPU seconds. This is diagnostic, not the final speed gate.
- Additional rejected trials: tiny-file allocation 25.734s (8 workers), 49.892s (12); allocation plus dispatch 28.634s (8), 20.958s (12); clamped allocation plus 8 MiB reads 27.465s (12). Host load varied; these did not justify retaining extra code.
- Own validation: 94 tests across 14 files passed; TypeScript passed; installed-tarball smoke on Node 24.16.0 passed. Node 22.13.0 and live-web validation are pending below.

Tuning stopped after unsuccessful trials under the supplied AGENTS rule. Doubtful assumption: a complete first scan of 13.43 GB can finish within 10 seconds on this hardware. Asked whether the user's target includes first-ever scans or ordinary cached launches; no answer yet. This PRD remains active because AC-1 is unmet. The separately authorized functional release was published as `token-furnace@0.1.0`; publication does not represent passing the cold performance gate.

### Local web and publication

- Node 22.13.0 installed-tarball smoke also passed, using its direct runtime and a matching PATH. The earlier `npm exec` invocation inherited `npm_node_execpath` from Node 24 and failed only the harness runtime-identity check; the direct invocation resolves that environment mismatch.
- Updated local server runs on `http://127.0.0.1:8780`. Browser validation reached the full dashboard with no scanning screen. Live changed-file scans observed at 2.937 and 3.268 seconds for one 28 MB transcript.
- Timed process start through a meaningful default `/api/report` (plan usage enabled): one earlier startup with the automation browser open took 16.377s to ready / 22.567s to report. Three subsequent quiet cached starts with that browser closed took **2.723, 2.922, 3.520 seconds** to full report, including changed transcripts. These demonstrate the quiet cached path, not an unconditional startup bound; the earlier slow run remains recorded without attributing its cause.
- Read-only diagnosis: existing live cache was already WAL/schema 1, so no migration was required; opening a copied connection took 0.2 ms. Materializing 346,349 cached turns took 2.26s. `planWeek` can wait up to 10 seconds on network and is awaited only for report/page builds, never status. Neither network timeout nor the initial 16.377s scan is claimed fixed by the quiet cached measurements.
- Published the independently authorized, functionally verified release without claiming AC-1 passes. Public registry `latest=0.1.0`; downloaded tarball is byte-identical to the tested 16-file artifact (SHA-256 `c6ac0a04ef0daefac1601e26fff56ff38d7bba16514b64388dbdd3f74eb12edb`). Fresh public `npx` installs with isolated HOME and npm caches passed on Node 24.16.0 and 22.13.0; both returned the expected one session, two turns, and positive usage from synthetic transcripts.
- The 166 MB worktree `.worktrees/scan-under-10` remains active for the unresolved first-scan target; it is not an abandoned completed lane.

### Cache-reader verification (single-line change)

- Retained one-line change in `src/repo/sqlite-repo.ts`: cached turn rows stream via `stmtAllTurns.iterate()` instead of materializing `stmtAllTurns.all()`. A cache-reader microbench median measured **3409 ms (materialized) vs 2109 ms (streamed), 38.1% faster**; serialized `SessionInput[]` hashes are equal before and after.
- Read-only worker scaling on the full frozen corpus: 1/2/4 workers gave **84.710 / 38.525 / 25.385 seconds**, all oracle match. Fewer workers were rejected; the 12-worker default is retained.
- New full application-cold default run: **41.687 s**, exact oracle parity `sha256 ba7caba2c95b…`, `load1=21.29`. This is **not directly comparable** to the earlier 15.954/16.080/20.707 s runs because external host load differed; the under-10-second full target remains **UNMET**.
- `turns_at` index (`schema.md:123`): unused by current queries but specified in the schema; no index changes were made.
- Final verification on Node 24.16.0: `npm run typecheck` passed. `node_modules/.bin/vitest run` passed **94 tests across 14 files** (existing SQLite suite: 6 cases). Build passed earlier; the Node 22.13.0 synthetic `iterate` run was verified.
- Warm benchmark on the unchanged frozen snapshot `snap-09Invw` (7,245 discovered transcripts, 13,428,775,344 bytes; `dist` `5675392fa8288c0e…`, `load1=19.2`): three runs **3.074 / 2.859 / 3.257 seconds**, valid 3/3, median 3.074, each an oracle match. The warm path stays under 10 seconds; cold AC-1 remains not met. Candidate is retained in the active worktree and has not been published.

### Persistence and parser shortcut diagnosis

- A worker replayed all 7,245 cached sessions into fresh temporary databases using the actual repository saves. Baseline writes including close took **2.77 / 2.91 s**; disabling WAL autocheckpoints took **2.64 / 2.93 s**; batches of 100 sessions took **2.62 / 2.37 s**. Every reopened database matched the seed's serialized sessions. Neither variant reached the predeclared 25% improvement threshold; no persistence changes were made. Writes alone do not explain the full scan time.
- A separate read-only worker traced Codex record routing and rejected a substring shortcut for ignored tool outputs: all nonblank lines currently undergo JSON validity checks, and invalid records contribute to `badLines` (`codex.ts:68-71`, pinned by source tests). Skipping parsing without equivalent validation would change accounting. No validation or source coverage was removed; the full cold target remains unmet.
