# Evidence behind token-furnace

Read this when deciding whether to deviate from the policy in `SKILL.md`, or when someone
proposes a new "token optimizer". Every number below comes from a named, dated source; the
main text of the skill states the rules without the arithmetic.

## The cost model

    cost per successful task ≈ fresh input + cache writes + cache reads
                               + reasoning/output + extra turns + subagent work

Input tokens are not economically equivalent. Anthropic prices ordinary prompt-cache reads
at roughly **0.1×** base input, while a five-minute cache write costs **1.25×**. An
optimizer can therefore delete visible tokens and still raise the bill, by mutating the
prefix often enough to convert cheap cache reads into fresh input and cache writes.

The optimization target is **dollars per correctly completed task**, not the number a
compressor prints.

## Priority order, highest leverage first

1. Prevent bad trajectories — planning and localization for uncertain tasks, explicit
   acceptance criteria, retry limits, focused verification, fresh context at phase
   boundaries.
2. Control model work — cheaper reasoning for routine execution, stronger reasoning
   selectively, constrained subagent fan-out.
3. Keep expensive context precise — repo maps, semantic symbol lookup, targeted reads,
   progressive skills, deferred MCP schemas, bounded tool output.
4. Preserve prompt-cache stability — do not churn system instructions, tools or MCP
   definitions merely to shorten the visible prompt.
5. Reduce generated work — anti-overengineering discipline, concise user-facing output.
6. Compress tool output, last and only after the above.

## Where the evidence is strong

**Agents over-retrieve.** ContextBench (1,136 issues, 66 repositories, 8 languages) found
sophisticated scaffolding produced only marginal retrieval gains, and that models prefer
recall to precision — they explore far more context than they end up using.

**Precision correlates with success.** SWE-Explore (848 issues, 203 repositories) used
successful repair trajectories as line-level ground truth under a fixed context budget.
File-level localization is mature; the differences that matter are line-level coverage,
ranking and context efficiency, and those track repair performance.

**Budgeted retrieval is the right frame.** Agent Retrieval Bench (427 cases, 25
repositories, ~392K files, ~7.9M chunks) found no retrieval family dominates, but a RepoMap
method gave the best useful-context yield **under an 8K budget**. Logged real-agent
trajectories missed all gold files in roughly 27–35% of cases; retrieval-seeded
trajectories improved file F1 and reduced later exploration.

**Compact reuse helps; transcript reuse hurts.** SWE-ContextBench found prior work helps
when selected and compactly summarized, and can hurt when retrieved indiscriminately. This
is the argument for a PRD over carrying an exploration transcript forward.

**Realistic conditions are harder.** CORE-Bench shows retrieval systems degrade materially
moving from conventional code search to realistic repository-state retrieval with
distractors. Doing well on "find this function" does not demonstrate efficient guidance of
an autonomous repair trajectory.

## Semantic MCP servers (Serena): why this skill dropped it

**Status: removed, 2026-09-11.** This skill used to install Serena. It no longer does. The
mechanism is sound — symbol outlines, lookup, references, declarations, implementations,
semantic replacement, instead of reading a 1,500-line file to understand one class. What
was never established is that adding it to an already-capable harness lowers cost. The
measurements below, plus a local observation, decided it.

| Test | Result |
| --- | --- |
| Byron Wall, 2026-08-15, 8 fresh runs, frozen task, blind scoring | Serena arm: **+10.1% uncached input, +59.3% tool calls**, fewer blind quality points. Failure mode: Codex used Serena, then repeated the same investigation with ordinary tools. |
| Atlas Scout comparative campaign, 45 runs, 3 hosts, 3 reps/cell | Host-dependent. On Claude Code, Serena cut total input vs shell-only (67K vs 149K) but had slightly more uncached input and worse exact-range correctness. Under Codex, lower uncached input than shell but **+59% total input** and ~3× median wall time. |
| ManoMano internal Java payment refactor | Vanilla Claude and Claude+LSP failed in the allotted run; Claude+Serena completed in 45 minutes with 1,017 tests passing. Small internal case study. |
| Serena's own evaluation (~20 tasks, agent self-scored) | Agents rate reference lookup, cross-file refactoring and symbol operations highly. Product evaluation, not a controlled cost result. |

Both negative results share one cause, and it is not a broken semantic server: Serena
returned non-empty results on every attempted call. The trajectory around it duplicated the
work. Hence the substitution rule, which survives the removal and is the actual product of
this research.

**Local observation, 2026-09-11.** On this machine, one day of Claude Code sessions:
41 MCP server starts, 23 tool calls total, **0** in the repository being worked on, and a
never-populated `.serena/cache`. The nudge hook could not correct it: for the `claude-code`
client, `is_grep_call`/`is_read_call` in `serena/hooks.py` match only the literal `Grep` and
`Read` tools, while the Codex and Grok branches also inspect shell commands — so a harness
that reads with `cat` and searches with `grep` through Bash never increments the counter and
never trips the 3-call threshold. Standing cost was ~10 idle processes and 22 deferred tool
schemas; measured benefit was zero.

The workload split that motivated it still holds — it just no longer needs a server:

| Workload | Call |
| --- | --- |
| Symbol body, name already known | `rg -n` for the line, then a ranged read |
| All callers / references | `rg -n '<symbol>'` across the tree |
| Rename or refactor across files | `rg -l` then a scripted edit, checked by the type checker |
| Fuzzy discovery ("where does auth happen?") | Repo map or `rg` |
| Tiny edit in a known file | Native Read/Edit |
| Non-code config and docs | Native tools |
| A fact already established | **Nothing. Stop.** |

Confidence: academic support for precise budgeted retrieval — high. A semantic MCP server
as an automatic cost reducer — **low**, and now measured locally at zero adoption.

Reinstating it needs a measurement, not a preference: register it, work a week, and count
tool calls in the target repository. Below a few dozen real calls it is paying rent for
nothing.

## Compressors: the negative results

A tool can compress its own payload by 80–90% and have no chance of reducing the bill by
80–90%.

**RTK.** JetBrains replayed 83 baseline transcripts: only ~⅓ of Bash calls were eligible,
and reachable outputs were under 20% of tool-result characters — an estimated **~3% ceiling**
on total input savings even with dramatic compression. Measured against SkillsBench
(Claude Code 2.1.201 / Sonnet 5, paired): at low effort the median task was **7.6% more
expensive** (p=0.004), with 13.8% more turns and 14.3% more cache reads; at high effort the
effect went to roughly zero. Dasein independently measured **+16% input, +13% cost**, 54
solves vs 57 baseline.

**Headroom.** Sophisticated, content-aware, and its current CacheAligner is explicitly
designed to avoid busting the KV-cache prefix. But Dasein's 100-task run measured **+6%
total input and +44% total cost**, with the lowest cache read/write ratio in the field —
consistent with cache churn outweighing visible compression. The product has evolved since;
treat it as A/B-only, not permanently rejected.

**Parsec.** The strongest positive end-to-end number: on 100 SWE-bench Verified tasks with
a fixed Claude Code scaffold and official grader, **−54% input, −39% total cost, 62 solves
vs 57 baseline**, peak working context 79.8K → 41.4K, wall time −25%. Caveat: Dasein
operates the benchmark and Parsec is its own entrant. Promising, not independently
established.

## Output shaping

**Ponytail** changes the trajectory rather than the prose: less implementation → fewer edits
→ less generated code. JetBrains, 80 paired SkillsBench tasks, pinned versions: **~15.4%
less code written, median 10.3% lower cost (p=0.004), ~11% lower wall time**, no detectable
quality difference at that sample size.

The activation caveat is the important part. Merely *installed*, the skill self-activated
**zero times across ten sessions**. The measured effect came from force-injecting the rules.
Install statistics are meaningless unless you instrument whether the rules reached the
model — which is why token-furnace's one-liner goes in `CLAUDE.md`/`AGENTS.md` rather than
relying on skill discovery.

**i-have-adhd** and native Concise style shape human-facing output: roughly 7,873 output
tokens at baseline, 5,066 with i-have-adhd, 4,633 with Concise in one independent
comparison. Do not translate that into "36–41% cheaper coding" — most of an autonomous
session's spend is repeated input, tool results, reasoning and child-agent work, not final
prose. **Caveman** measured only −8.5% output tokens at JetBrains against an advertised
65%; Dasein saw −19% cost in one run, which JetBrains notes was fragile.

These are UX wins. They are not the retrieval trajectory.

## Validating on your own repository

Public rankings are weak evidence for your monorepo. Coding-agent trajectories are highly
stochastic and sensitive to model version, effort, language, harness and task mix.

Ten tasks at k=1 is a wiring smoke test, not a result — JetBrains' RTK work showed how
misleading that is. A credible program: 10 tasks to validate instrumentation, the same 10 at
k=3 to estimate within-task variance, then **60–100 paired tasks** for the comparison.

Stratify rather than sample randomly: ~15% tiny known-file changes (detects over-tooling
overhead), 25% normal feature/bug work, 15% unfamiliar-repo localization, 20% cross-file
semantic refactor (semantic navigation's best case), 15% difficult debugging, 10% large
logs and test failures.

Record per trial: success, fresh input, cache writes, cache reads, output, reasoning
tokens, **total provider cost**, turns, tool calls, duplicate file/symbol reads, subagent
count and depth, peak working context, wall time, and **whether the intervention actually
activated**. For retrieval experiments add: symbols queried, raw read bytes, semantic→grep
duplicate lookups, time to first gold file, and the share of retrieved files actually used.

The first experiment worth running is not "semantic server vs vanilla". It is
**substitution policy vs no policy, tooling held constant** — the hypothesis being that
restricting duplicate retrieval is worth more than adding a retrieval tool. That is also
the cheaper experiment, since the policy is a line of instruction and the server is an
install. Accept a change at a credible ≥10–15% reduction
in cost per solved task with no more than a 2–3 point drop in success. Below ~5%, prefer
the simpler toolchain.

A compression layer wins only if **cost per successful task** falls. "Compressed X million
tokens" is not a success metric.

## Sources

- Anthropic — Prompt caching, Model configuration, Environment variables, Create custom subagents, Output styles (code.claude.com/docs, docs.anthropic.com)
- OpenAI — Codex Configuration Reference, Subagents (developers.openai.com/codex)
- ContextBench, arXiv:2602.05892 · SWE-Explore, arXiv:2606.07297 · Agent Retrieval Bench, arXiv:2607.24882 · CORE-Bench, arXiv:2606.11864 · SWE-ContextBench, arXiv:2602.08316
- Dasein Code-Compression Bench — github.com/daseinlabs/code-compression-bench
- JetBrains AI blog — RTK skill trial (2026-07), Ponytail skill tested (2026-07), JetBrains Context / Caveman evaluation
- Byron Wall — "Serena vs Bare Codex: A Code Navigation Evaluation" (2026-08-15), byroni.us
- Atlas Scout comparative benchmark — github.com/ZaguanLabs/atlas-scout-code-navigation-benchmark
- Serena — github.com/oraios/serena · Ponytail — github.com/dietrichgebert/ponytail · i-have-adhd — github.com/ayghri/i-have-adhd
- Aider repo map — aider.chat · Headroom — github.com/headroomlabs-ai/headroom

Vendor-operated benchmarks are marked as such above. Where a vendor evaluates its own
entrant, treat the result as promising rather than established.
