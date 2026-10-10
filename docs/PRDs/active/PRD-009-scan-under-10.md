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
- [x] AC-2 [local]: Warm-cache and changed-transcript startup also complete in under 10 seconds. proof: frozen warm runs 3.074/2.859/3.257 s; fresh local process with a changed 50.9 MB transcript returned its default full report in 3.824 s.
- [x] AC-3 [local]: Candidate full Report is byte-identical to the baseline on the same fixed inputs/clock. proof: full frozen cold runs and warm runs match the unchanged oracle; latest patch trial also matches.
- [x] AC-4 [local]: Live server retains responsive progress, worker-backed initial parsing and safe fallback. proof: progress/parse-pool tests, prior real browser rendering, and the integrated local server's ready/full-report checks; UI and worker scheduling are unchanged by the one-line cache-reader patch.
- [x] AC-5 [local]: Build, affected tests and package smoke pass on Node 22.13 and 24. proof: Node 24 build/typecheck/94 tests; Node 22 affected suites 19 tests; both runtimes pass 14 installed-package smoke checks and fresh public npx installs.

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

### Raw input reading and resource diagnosis

- A worker read every byte of all 7,245 frozen transcript paths with 12 workers, reusable 1 MiB buffers, newest-first dispatch, and no decoding, line splitting, parsing or cache writes. Exact byte count **13,428,775,344**; no errors. Process-start-to-worker-exit wall times were **20.109 / 8.746 s**; CPU times **10.875 / 11.049 s**. Host load was approximately 47. OS page-cache state was uncontrolled, so these are raw-read timings under contention, not physical disk limits or full-scan passes.
- Subsequent resource inspection showed 12 CPUs available to this process, load1 **32.24**, CPU pressure `some avg10=39.03`, and memory pressure `some avg10=3.97`. Readable ancestor cgroups had no CPU quota or memory high/max cap. This establishes contention, not that a sub-10-second implementation is impossible.
- Reusing just-parsed objects instead of `repo.all()` was not adopted: unchanged sessions still require the cache, and `save()` currently swallows write failures, so retained objects could disagree with the next report/restart. The next experiment must preserve full input coverage, validity accounting, repository behavior and byte-identical report output.

### Validated ignored-record experiments

- A scratch canonical `function_call_output` validator passed 12,840 synthetic/mutated cases without false positives, but accepted **zero** of 42 sampled large Codex records (134,534,827 bytes). Median complete byte-decode/parse baseline **221.1 ms**, candidate **235.4 ms**; rejected. The sample's large ignored records use `custom_tool_call_output` with object outputs and additional metadata, so the tested canonical shape does not cover them. This is sample evidence, not a whole-corpus performance claim.
- A second scratch experiment attempted to validate and elide giant JSON string tokens before parsing the remaining structure. It exceeded its five-minute budget during adversarial regex safety work and was interrupted by the coordinator. Its correctness and performance gates are unproven; no production code was adopted and no fallback arm was started. The router reported the interruption as unavailable, which is not evidence of provider unavailability or quota exhaustion. Scratch code remains private under `/tmp/tf-string-elide.PypwCI` for diagnosis.

### Local integration and patch release state

- Integrated the tested one-line cached-row streaming improvement into the primary checkout and bumped the package to **0.1.1**. Fresh builds pass; the same exact tarball passes all 14 installed-package smoke checks on **Node 22.13.0 and 24.16.0**. Artifact `/tmp/tf-release-ew8Cp3/token-furnace-0.1.1.tgz`: **293,761 bytes**, 16 files, SHA-256 `61b906ac88c25fca57c5dd2775d5363159ea4891af04fa9af697d477b4568d13`.
- The authorized fixed-registry publish returned **HTTP 202 / npm exit 0**. Public publication is **not verified**: twelve checks over 180 seconds still showed `latest=0.1.0`, no 0.1.1 metadata, and a separate public 0.1.1 tarball request returned 404. Authenticated metadata also lacked the version. Do not treat acceptance as proof of availability or repeat the upload without inspecting the current state. Temporary authentication files were removed; no token was logged.
- Restarted only the owned local server on `http://127.0.0.1:8780`. Its fresh process was ready in **0.774 s** and returned the default full report in **3.824 s**, including a changed **50,885,563-byte** transcript. The rebuilt local CLI, worker, shared chunk and dashboard bytes match the tested tarball. This is a changed-cache startup result, not a full empty-cache scan pass; AC-1 remains unmet.

### Public patch verification and CPU-allocation trial

- Publication is now verified: public `latest=0.1.1`; a downloaded public tarball matches the exact tested 293,761-byte artifact above. Fresh ordinary public `npx token-furnace@0.1.1` installs with private, empty per-runtime caches passed on Node 22.13.0 and 24.16.0, each reporting the synthetic fixture's expected one session, two turns and positive usage. Logs remain private at `/tmp/tf-public-npx-KwzQiJ`. This resolves the earlier HTTP 202/public-availability gap; no second upload was needed.
- The affected SQLite, worker-pool and line-reader suites additionally passed **19/19 tests on Node 22.13.0**.
- The inherited process affinity exposes 12 logical CPUs on **6 physical cores**, although the cgroup permits all 24 logical CPUs on **12 physical cores**. A separate benchmark process and its children alone temporarily used the full allowed CPU set. The unchanged full frozen application-cold scan took **23.740 s**, oracle match, with host load1 **23.69**. This did not pass AC-1; global affinity and other processes were untouched. It is a distinct resource-allocation experiment, not a directly controlled comparison with earlier timings.

### Rejected JSON-validation replacements

- A boundary-anchored sticky string tokenizer avoided the earlier unanchored regex's slow search after malformed strings. **83,400** seeded cases had no observed validity/routing mismatches; seven isolated 8 MiB adversarial cases had no timeouts (maximum 163 ms). On the same private 42-record/128.3 MB sample, it skipped 125.3 MB but took median **526.1 ms vs 260.2 ms** for UTF-8 decoding plus `JSON.parse`. Rejected; no reader hook or production parser change. Scratch: `/tmp/tf-sticky.QdGe44`.
- A native SQLite strict `json_valid` + `json_remove('$.payload.output')` + reduced-structure parse also had no observed false positives in **76,044** seeded cases on Node 22.13 and 24.16. Ten isolated adversarial cases passed, maximum 46.7 ms. Including the native calls inside the timer, the same sample took median **148.7 ms vs 128.1 ms**, despite skipping 126.8 MB. Rejected; an initially faster off-timer projection was invalid evidence and was corrected before acceptance. Scratch: `/tmp/tf-native-json.ql6w4W`. Neither sample establishes whole-corpus performance or a general correctness proof.
- Next bounded resource experiment: compare 12 vs 24 workers with both runs permitted the full 12 physical cores, fresh application caches, unchanged frozen inputs/clock and exact oracle checks. Earlier 24-worker trials used the inherited six-core affinity, so they do not answer this comparison. Do not alter production worker defaults unless the paired measurements justify it; AC-1 still requires three full default-config runs below 10 seconds.

### Full-core worker calibration and cold gate

- A scratch worker compared full frozen scans with fresh application caches, both restricted only to the same full 24-logical/12-physical CPU allocation: W12 **13.65 s**, W24 **10.78 s**, W24 **9.34 s**, W12 **9.08 s**. All four reports matched the unchanged oracle and frozen file size/mtime checks. Twenty-four workers were not consistently faster; peak RSS was approximately **4.1–4.4 GB** vs **2.7–2.8 GB** for twelve. No default change. Scratch wrapper: `/tmp/tfbench.qnlBPV/wrap.mjs`; its generated caches were removed.
- The required unmodified-default three-run gate was then executed on the same full CPU allocation, with OS caches warm from complete reads and fresh application caches: **10.389 / 11.825 / 11.598 s**, every report an oracle match. `verify` correctly exited **1**. The earlier isolated 9.08 s run does not satisfy AC-1; the gate remains failed.
- A fresh-cache-only `WITHOUT ROWID` storage experiment retained all columns, constraints, indexes and PRAGMAs. After warmups and four interleaved rounds, mean write/read totals were **2743 ms baseline vs 2855 ms variant**; the variant wrote 13% slower, read 6.8% faster, and grew 2.8%. All 7,245 sessions/345,953 turns matched through reopen; current Node 24 constructor/save/changed/delete checks passed. Node 22 compatibility was not executed for this rejected scratch variant (the binary exists at the previously verified `_npx` path). No schema or production changes. Scratch: `/tmp/tf-rowid-kQ0GUn`, replay script `/tmp/opencode/tf-rowid-bench.mjs`.
- Next bounded calibration is sixteen workers on the same full CPU allocation, bracketed by twelve-worker controls. Adoption requires the actual under-10-second full-corpus gate; sample or isolated fast timings are insufficient. Existing twelve-worker production cap remains in place.

### Sixteen-worker calibration

- With identical full CPU allocation, fresh application caches and the unchanged frozen clock/input, bracketing twelve-worker controls took **18.02 / 15.31 s**; the sixteen-worker trials took **16.60 / 14.45 / 15.54 s**. All five reports matched the oracle and frozen size/mtime checks. Host load1 rose from **48.88 to 65.49**, and candidate peak RSS was **3.1–3.4 GB** vs controls **2.7–2.8 GB**. The predeclared three-under-10 criterion failed; no worker-default change. These contended timings do not establish which configuration would win during a quiet window.
- The worker removed its generated 778 MB run caches and kept `/tmp/tfbench16.3Ujvmw/wrap.mjs`. Source, build and existing caches are unchanged. Further whole-corpus worker calibration is deferred pending a quieter measurement window; it is not replaced with cached-only success.
- Next read-only investigation: whether an existing portable, allocation-free JSON validation/projection implementation can skip only validated ignored outputs while preserving malformed accounting and duplicate-key routing. Any candidate must retain Node 22.13/24 support and ordinary npx installation without Python, jq or native build prerequisites. Do not introduce a runtime dependency or production parser before reviewing its API, installation behavior and measured benefit; the original full-corpus acceptance gate remains unchanged.

### Bounded reader and portable-parser probes

- A scratch per-file turn query avoided the global Map and source clone, but paired medians were **1.4162 s baseline vs 1.3942 s candidate** (1.55%, overlapping distributions); RSS fell from 415.5 to 373.5 MB. All six runs matched the 7,245-session/345,953-turn SessionInput hash `f0074cd4f1e038d5`. Rejected as insufficient improvement; no repository implementation change. Scripts: `/tmp/tf-probe/{trial,drive}.mjs`, read-only frozen seed, Node 24.
- Reviewed portable parser options did not provide a ready allocation-free validation/projection API. `@pjson/wasm` returns full JavaScript objects; its document-size bound applies per record, not to the total corpus. Native addons requiring end-user compilation do not meet ordinary npx installation. A bounded scratch serde_json/WASM validator probe is pending; malformed or unsupported inputs must fall back to the existing parser, and no production parser has changed.
- Independently, the live server's quota fetch can await a 10-second timeout before report construction. A bounded server-only fix is in progress to return a local quota snapshot and refresh in the background, including retaining fresh results in memory for `--no-cache`. CLI awaiting behavior and the full first-scan gate remain unchanged.

### WASM sample and first whole-corpus gate

- A scratch serde_json `IgnoredAny` validator compiled to portable WASM accepted 27/42 sample records (125.3/128.3 MB), with median **26.6 ms vs 121.0 ms** including byte copy and fallback; 10,016 seeded cases had no observed false positives. Its 82 KB artifact was integrated as an embedded module, lazy per worker, with normal parsing on malformed, unsupported, oversized or trapped inputs. No runtime dependency or end-user compilation. Rust source/lockfile and packaged dependency notices accompany the artifact.
- Node 24 targeted source/reader/validator tests passed **23/23**, typecheck/build passed. Review found the initial production fuzz loop used short documents below the activation threshold; it was corrected to exercise large documents before acceptance. The module research's claim that Node 22 was absent was incorrect; the verified `_npx` binary remains available.
- Full CPU allocation, unchanged frozen sources/clock, fresh application caches: **13.254 / 10.620 / 10.534 s**, every report exactly matching the oracle. `verify` exited **1**; AC-1 remains failed. This is not a controlled baseline comparison and the fast sample is not whole-corpus success.
- Next bounded candidate retains the same whole-document validator and expands only to three additional `response_item` payload types the existing parser already ignores: `function_call_output`, `message`, `reasoning`. Meaningful `function_call`, `user_message`, `token_count` and top-level context records must remain on the original path. No arbitrary record dropping or reduced validation.

- Expanded four-type WASM candidate: **15.267 / 17.655 / 16.497 s**, all oracle matches, full gate failed. Rejected; the sample's speedup did not establish that validating additional output types helps the whole corpus. Stop expanding the parser based on that assumption. The preceding unchanged published-code diagnostic took 14.289 s, oracle match; timings across separate runs are not controlled speedup evidence.
- Re-plan: determine whether report construction actually requires all historical cached turns, or whether the existing timestamp index can select the exact report window after the complete source scan/cache write. Preserve all counters, comparison periods, sessions and issue calculations; no query optimization until their required window is established.
- The quota background-refresh regression suite also passed **14/14 on Node 22.13**. That live-path fix is independent of the failed full-corpus parser gates.

### Indexed report window and bounded stop

- Reading code directly corrected the earlier research finding: `buildReport` skips `item.when < cutoff` before all weekly/recent/stat calculations. The exact existing report therefore needs only `now - days`, including its existing one-day/week quirk. The default frozen seven-day window contains **68,041 of 345,953** cached turns. `all(cutoff?: Date)` now filters the SQLite query through the existing timestamp index (and Memory repository equivalently), preserves all file metadata, sequence order, boundary/future turns, and defaults to the original unfiltered API. No schema change or source skipping. All WASM candidate sources and artifacts were removed from the active checkout and retained privately at `/tmp/tf-rejected-wasm-720365om`; no runtime dependency remains.
- Repository and report-equivalence suites passed **13/13 on Node 22.13 and 24.16**; typecheck and build passed. The service-level test compares filtered/unfiltered reports for 7/1/30-day windows and both sources, including quota-week behavior.
- Full frozen three-run gate: **17.952 / 14.569 / 14.435 s**, all oracle matches, `verify` exit **1**. Cached runs: **0.907 / 0.830 / 0.843 s**, all oracle matches. The cached result satisfies the normal reload target and does not satisfy AC-1.
- After three unsuccessful full-corpus candidates, production tuning stopped. The doubtful assumption is that one local code change alone can achieve the full-input target under current resource conditions. A native resource diagnostic took **12.096 s**, oracle match, **58.049 user + 25.333 system CPU-seconds**, peak RSS **2863.5 MiB**, 3,206,224 input and 1,649,688 output blocks (512-byte units); host load1 rose **6.42→8.84**. These observations do not establish a hardware lower bound or prove impossibility. Further work requires a new measured cause, not another blind parser change. The original full-scan acceptance remains open.

- The bounded quiet-window check waited **180.1 s** for three consecutive one-second samples with at most two busy logical-CPU equivalents. That condition did not occur; no additional gate was run. This is an observed resource condition, not a proof that a code improvement is impossible.
- Release candidate **0.1.2** passed the full Node 24 suite (**100 tests, 14 files**), affected Node 22 suites (**27 tests, 4 files**), typecheck/build and **14 package smoke checks on each runtime**. The exact tarball additionally installed and produced the expected 40-turn synthetic report on both runtimes. `smoke.mjs` repacks rather than accepting an artifact argument, so its 14 checks used an equivalent fresh package from the unchanged build; the exact upload file's separate install checks are distinct.
- Exact prepared artifact: `/tmp/tf-release-012-pS6Bb8/token-furnace-0.1.2.tgz`, **294,712 bytes / 16 entries**, SHA1 `2146086dc602f440d604252ad41fb5ccec8224fe`, SHA256 `b796f74300d6afe0424eac33698ccdd398545cfe55d216d049449babd78e6057`. Manifest contains only the existing distribution/docs; rejected WASM/native code and notices are absent. Publication and live root integration pending; full first-scan AC-1 remains open.

### Public 0.1.2 and live delivery

- Registry acceptance was followed by public verification: `latest=0.1.2`, published SHA1 matches, and the downloaded public tarball's SHA256 exactly matches the tested artifact. Fresh unversioned public npx installs with empty per-runtime caches passed on Node 22.13 and 24.16, each installing 0.1.2 and reporting the expected synthetic **one session, 40 turns, 2,206,400 total, six issues**. Private logs: `/tmp/tf-public-0rwpnW/out/`. No upload retry or artifact fallback.
- Commit `2b9b4c8` was fast-forwarded into the primary checkout. Its rebuilt distribution's **11 files** match the tested tarball byte-for-byte. The exact owned prior server was identified and replaced; `http://127.0.0.1:8780` now runs Node 24 / 0.1.2, PID **2919218**, log `/tmp/tf-web-8780-k2xwb8vk.log`. Cached startup reached ready in **0.441 s**, with a complete default report in **1.054 s**. The earlier missing temporary restart helper was replaced with an explicit identity-checked restart, without touching other ports.
- Current bounded component is delivered; owner released `.worktrees/scan-under-10`. Cleanup audit found no active cwd owners, no tracked/untracked changes, and only task-created `node_modules` (11,615 ignored entries) and `dist` (11 entries), totaling **173,318,144 allocated bytes / 165.3 MiB**. Ordinary removal follows final documentation integration. Future read-only full-scan diagnosis can use the primary checkout; original AC-1 remains unchecked and this PRD stays active.
