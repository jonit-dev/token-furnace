---
name: token-furnace
description: Token Furnace - run `npx token-furnace` to detect common token leaks in local Claude Code and Codex transcripts (late compaction, caller-side reads, wakeups, unbounded loops, long-lived sessions, bad config) and get ranked fixes plus an HTML report with copy-to-Claude prompts. Also cuts coding-agent token cost by preventing wasted work rather than compressing text — a retrieval policy, a verification ladder, a retry circuit breaker, and a delegation rule, plus the scripts that measure and enforce them. Installs and configures itself for Claude Code and Codex, with config backup and one-command rollback. Use when setting up a new machine or agent, when asked to reduce token or context cost, when asked where the token budget or plan usage went, when a session is burning turns re-reading the same code, or when deciding whether to delegate to subagents.
---

# Token Furnace

## Start here: the doctor

```bash
npx token-furnace           # last 7 days, every agent found
npx token-furnace 2 --source claude
```

For the live report, run `npx token-furnace serve --port 8765` in its own terminal
(`--port` moves it). Give the user `http://127.0.0.1:<port>`; do not open the HTML file. The page
rebuilds on each load and reloads every minute: active sessions, the last hour's burn rate
against the ideal pace to the plan's weekly reset, and the leaks.
The Dashboard tab opens with the KPI tiles and trends, then what to act on now; Leaks, Baseline
and Details follow.

The weekly reading comes from the subscription usage endpoint, which rate-limits. When a Claude
login exists on the machine, a run refreshes the reading from it at most once a minute (the
token goes to api.anthropic.com only); `--no-plan-usage` turns the call off. A status line can
feed it instead, and its saved reading is used by every run: write `{"fetched": <epoch>, "seven_day": {"utilization": <used %>,
"resets_at": <epoch>}}` from its `rate_limits.seven_day` input to
`${XDG_CACHE_HOME:-~/.cache}/token-furnace/usage.json`. A reading under 5 minutes old wins.

It prints a verdict, each leak ranked by share of spend with its fix and the worst sessions,
and the baseline levers that miss their target. It exits 1 when it finds a leak.
`--html report.html` also writes a self-contained page: a spend-over-time chart, the
baseline table, the leak table, and a "Copy for Claude" button per leak that copies a
prompt with the evidence and transcript paths. The detail behind each check is in
"Measure before you tune" below.

Most coding-agent spend is not verbose text. It is work that should never have happened:
duplicated retrieval, whole-file reads, full test suites run after every edit, retry loops
on the same failure, and subagents that each start their own model and tool loop.

**Compressing output after the work has happened cannot recover that.** Two independent
benchmarks measured shell-output compressors making sessions *more* expensive, because the
compression either missed most billed context or churned the prompt cache. See
[references/evidence.md](references/evidence.md).

So this skill has one rule, three ladders, and one setup script.

## The rule

> **A retrieval step replaces the one below it. It is never added on top of it.**

The measured failure mode is an agent that gets a correct answer from one tool, then
confirms the same fact with `rg` and a whole-file read. The semantic-server arm that did
this used **+10.1% uncached input and +59.3% tool calls** against bare Codex — the server
worked fine; the trajectory around it did not. That result is why this skill no longer
installs a semantic MCP server: see [references/evidence.md](references/evidence.md).

Any retrieval tool only pays if it *removes* the reads it replaces.

## Retrieval ladder

Climb only as far as the question requires, then stop.

1. **Symbol or path already known?** Read the range, not the file — `rg -n '<symbol>'`
   for the definition line, then `sed -n 'A,Bp'` or `Read` with an offset and limit.
2. **Owner unknown** ("where does auth happen?") — `rg` and `glob` for discovery. Name the
   symbol first; a search you cannot name is exploration, not retrieval.
3. **Retrieve the smallest unit that answers the question** — a function body, not its
   file; `rg -l` to locate before `rg -n` to read; callers by name, not a repo-wide dump.
4. **After a step establishes a fact, do not re-establish it.** No confirming `rg` after
   a read that already answered, no second pass over the same file. This is the rule
   above, and it is the single highest-value line in this skill.
5. **Fall back to a whole-file read only for a named unresolved question.** Write the
   question down first; if you cannot name it, you do not need the read.
6. **Stop retrieving** once there is enough evidence to implement or verify safely.

Exceptions, both real: tiny edits in a file you already have open, and small files where
one read is cheaper than three searches — do not ladder for the sake of laddering.

## Verification ladder

    smallest falsifier → component test → full suite at milestone

Run the narrowest test that can disprove the current hypothesis. A 15-minute suite after
every edit buys one bit of information for thousands of tokens of log. Full verification
runs once, before claiming completion.

Cap what comes back: `| tail -50`, `--reporter=dot`, `-q`, `--fail-fast`. Truncating the
diagnostic clue costs a whole extra turn, so cap output, do not blindfold yourself.

## Retry circuit breaker

> **Two failures with the same underlying cause: escalate, do not retry.**

Do not attempt a third fix at the same capability level. State the assumption that must be
wrong, then hand the problem to a more capable model or a higher-effort reasoning pass,
carrying what was already tried and why each attempt failed. The expensive pattern is
edit → test → shallow diagnosis → edit → same test → shallower diagnosis, and it is how a
cheap model outspends an expensive one.

The breaker escalates the capability applied to the task. It never abandons the task —
a breaker that stops work converts a token problem into an unfinished-work problem.

`token-furnace hook churn` enforces this as a hook, because the rule is easy to write
down and easy to ignore mid-loop. It counts edits per file per session and injects the
escalation prompt at the 4th, 7th, 10th edit of the same file. It never blocks an edit and
never fails a tool call on bad input.

`token-furnace setup --apply` wires it into Claude Code's `settings.json` as a `PostToolUse`
hook matching `Edit|Write|NotebookEdit`, and `--verify` checks it is still wired and still
executable. The step is idempotent — re-running never appends a second copy — and
`--rollback` removes it with the rest of the config.

This one is Claude Code only: Codex has no equivalent per-tool-call hook, so there the rule
stays prose in `AGENTS.md`. Thresholds move with `CHURN_FIRST` and `CHURN_EVERY`. Pick them
from your own measured edit churn rather than the defaults — see below.

## Delegation rule

Subagents cost more than a single agent doing the same work — each child runs its own model
and tool loop, and OpenAI's own docs say so plainly. Delegate only when one is true:

1. The child can use a **materially cheaper model** for the same job, or
2. moving a **large read/search workload into an isolated context** saves the parent more
   repeated tokens than the child costs.

"Parallelize it" is a latency strategy, not a cost strategy. A reader agent that returns
paths, symbols and unresolved questions pays for itself. Five frontier-model agents
exploring the same repository do not.

## Planning, proportionally

Planning has a price. A one-line null check does not need a research agent and a PRD.

| Task | Route |
| --- | --- |
| Known file, obvious change | Execute directly |
| Well-specified, multi-file | Acceptance criteria, then execute |
| Uncertain, cross-cutting, unfamiliar repo, hard bug | Localize first → compact PRD → **fresh** executor context |

The gain in the third row is not that a PRD uses fewer words than a chat. It is that the
executor never rediscovers the architecture and never drags twenty exploratory tool results
through every subsequent turn. Use `prd-creator` to write it; keep it to objective,
non-goals, established facts (exact paths and symbols), invariants, change, acceptance,
verify commands. Delete anything that narrates the research.

## Cache stability

Cached input can cost ~0.1× base input; a cache write costs ~1.25×. An "optimizer" that
rewrites your system prompt to make it shorter can therefore **raise** the bill.

So: do not churn stable prefixes. `CLAUDE.md`, `AGENTS.md`, tool definitions and MCP
schemas should change between sessions, not within them. A stable 1,000-token instruction
block that is always cached is cheaper than 300 tokens rewritten every turn. Optimize
economic tokens, not visible prompt length.

## Setup

`npx -y token-furnace setup` performs the whole installation, idempotently, for Claude Code
and Codex together.

```bash
npx -y token-furnace setup              # dry run — prints every change, writes nothing
npx -y token-furnace setup --apply      # back up, apply, then verify
npx -y token-furnace setup --verify     # check an existing install; exits 1 on any failure
npx -y token-furnace setup --rollback   # restore the most recent backup
```

`--apply` ends by verifying its own work rather than trusting that each step
reported success: both config files must parse, every expected key must be present,
each skill link must resolve to a readable `SKILL.md` (a dangling symlink looks
installed to `ls` and is invisible to the agent), the always-on line must be present
in both files, and a restorable backup must exist. `--verify` runs the same checks
alone and exits non-zero on failure, so it can gate a provisioning script.

**It backs up before the first change.** An apply that changes configuration copies
`settings.json`, `.claude.json`, `config.toml`, `CLAUDE.md` and `AGENTS.md` into
`~/.agents/token-furnace-backups/<timestamp>/` and writes a `restore.sh` beside them. Nothing
is edited until that backup exists. A no-op apply preserves the previous backup. `--rollback` restores the newest one; any older
snapshot restores by running its own `restore.sh`.

What it does:

1. **Skills** — links `token-furnace`, `prd-creator` and `prd-manager` into
   `~/.claude/skills/` and `~/.codex/skills/` from one shared checkout, so both agents read
   the same file and an update lands in both.
2. **The always-on line** — appends one line to `~/.claude/CLAUDE.md` and
   `~/.codex/AGENTS.md`, between markers so re-runs replace rather than duplicate it:

   > Token discipline, every session: slice uncertain or cross-file work into a compact
   > PRD with the `prd-creator` skill first and execute from that, rather than exploring
   > and implementing in one context (`prd-manager` reports where PRDs stand); retrieve
   > the smallest range that answers the question and **never re-establish a fact you
   > already have** — no confirming grep after a read that answered it; run the smallest
   > test that can falsify the current hypothesis; after two failures with the same cause,
   > stop editing and re-plan. Full policy: `~/.agents/skills/token-furnace/SKILL.md`.

   It names `prd-creator` and carries its rules inline on purpose. A skill that is merely *installed*
   self-activated **zero times in ten sessions** in JetBrains' evaluation of Ponytail —
   measured savings only appeared when the rules were force-injected into the prompt. An
   instruction that depends on being discovered is an instruction that does not run.

3. **Config defaults** — the settings in the table below, and deliberately not the others.

## Config: what gets set, and what gets refused

Applied by default — none of these reduce reasoning quality:

| Agent | Setting | Value | Why |
| --- | --- | --- | --- |
| Claude | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | `3` | Default is 20. Caps simultaneous fan-out; does not cap total work. |
| Claude | `ENABLE_TOOL_SEARCH` | `true` | Defers MCP tool schemas instead of loading every definition up front. Pure win with several MCP servers. |
| Claude | `MAX_MCP_OUTPUT_TOKENS` | `12000` | Default 25K. Bounds a pathological MCP dump. |
| Claude | `autoCompactWindow` | `200000` | Manual for now: `token-furnace setup` does not set it. On a 1M model the default compacts near 1M, so every turn carries up to 1M of context. |
| Codex | `model_verbosity` | `low` | Shortens visible prose only. Reasoning is a separate setting and is untouched. |
| Codex | `tool_output_token_limit` | `10000` | Bounds giant build and test logs. |
| Codex | `agents.max_concurrent_threads_per_session` | `3` | Same reasoning as the Claude cap. |
| Codex | `agents.default_subagent_reasoning_effort` | `medium` | Children mostly scan and summarize; the parent keeps its own effort. |

**Refused by default.** Each of these is in the source research; each one degrades output
or is unsafe to set blind. `--aggressive` applies the spawn-depth one anyway, after printing
the risk. The rest the script will not set at all.

| Setting | Research value | Why it is refused |
| --- | --- | --- |
| `CLAUDE_CODE_EFFORT_LEVEL` | `medium` | **This is the "nerf your own output" setting.** A global, permanent downgrade of reasoning on every task including the hard ones. The correct shape is cheap *children*, not a cheap brain. Your baseline is a personal call; lower it per-session with `/effort` when the work is routine. |
| Codex `model_reasoning_effort` | `medium` | Same objection, same answer. The script does not read, write, or recommend a value for it. |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | `1` | There are version-specific reports of this behaving one level off, where `1` blocks subagent spawning entirely. `--aggressive` sets it; verify once after any Claude Code upgrade that delegation still works. |
| Codex `skills.max_context_tokens` | `3000–5000` | Actively harmful on a large skill collection: it truncates the catalog, so skills stop being discoverable — including this one. The fix for a bloated catalog is pruning unused skills, not capping the budget that makes them findable. |
| Codex `agents.max_depth` | `1` | Not in the current official config reference. Do not encode a setting you cannot verify is enforced; put "do not delegate" in the worker's instructions instead. |
| Claude output style `Concise` | — | Reasonable on its own, but it stacks badly with Ponytail and i-have-adhd, which already shape output. Three concision layers compete and the result is terse work reports, not cheaper sessions. Pick one. |
| RTK, Headroom, other output compressors | — | Measured *more* expensive end to end in two independent benchmarks. If you want one, A/B it on your own repository and count cache reads, cache writes and dollars — never "tokens compressed". |

Full reasoning and sources: [references/evidence.md](references/evidence.md).

## Measure before you tune

Do not guess which rule on this page is costing you. `npx token-furnace` reads the local
session transcripts and reports where the budget actually went — read-only, no
network. Pass `--json` for the machine-readable report.

It is agent-agnostic: Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`)
are both auto-detected and reported together, so the comparison between them is the useful
part. Adding a third agent is one entry in `src/compose.ts`.

```bash
npx token-furnace                    # last 7 days, every agent found
npx token-furnace 30                 # last 30 days
npx token-furnace --source codex     # one agent only
npx token-furnace --list-sources     # what is installed on this machine
npx token-furnace --full             # the full text report: tiles, context bars, leak table
npx token-furnace 2 --html burn.html # also write an HTML report: tiles, context bars, leak table
npx token-furnace serve              # live report on http://127.0.0.1:8765
```

Read the output in this order:

1. **Spend by context size.** Cost per turn scales with the context carried into it, so a
   few very long turns can dominate a week. A large share above 300k means sessions are
   never compacting: use a smaller context window, or start fresh sessions between
   unrelated tasks. Compression cannot fix this.
2. **Always-resident preamble.** Instructions, memory, skill catalog and tool schemas are
   re-read on every single turn. Prune once and then leave it alone — reads bill at ~0.1x
   base input, but rewriting the prefix costs ~1.25x across every session that follows.
3. **Top sessions.** A session with a four-figure turn count and a peak near the window
   limit is the one to split, not to compress.
4. **Tool calls.** If duplicate reads or repeated identical commands are rare, output
   compression has nothing to eat and is not your lever.
5. **Leak checks.** Each top session gets one line per leak it shows, with the fix:
   - *late compaction*: peak context above 300k. Set `autoCompactWindow` to about 200000.
   - *caller reads*: 100+ file or log reads (`Read`, `sed -n`, `grep`, `rg`, `cat`, `python3 -`)
     run in the caller's own context. Send them to a cheap read-only agent.
   - *wakeups*: 50+ teammate, task-notification or cross-session messages. Each one is a
     full-context turn. Ask for one report at the end.
   - *loop*: 200+ turns per human prompt. Give the autonomous loop a stop condition and a budget.
   - *long-lived*: open 12+ hours. Start one fresh session per task.
6. **Config checks.** `autoCompactWindow` unset or above 300k (the env var
   `CLAUDE_CODE_AUTO_COMPACT_WINDOW` overrides the setting), and any `MEMORY.md` index over
   200 lines (Claude Code does not load the rest).

Measured case, 2026-10-09: a 20x plan drained in 2 days. Four Opus coordinator sessions,
18 to 40 hours old, used 77% of spend. Auto-compact was on, but with a 1M window it fired
only near 960k, so the median turn carried about 500k. Each session also showed caller
reads, wakeups and loop flags. `test/analysis.test.ts` checks every flag.

The numbers are base-input-equivalent, not raw tokens, because raw counts overstate cheap
cached reads and understate output, and they are scaled by a rough per-model price ratio.
A model with no known ratio is counted at 1.0 and listed under UNPRICED MODELS rather than
silently billed as cheap — if that section is a large share of your spend, add the ratio to
`MODEL_RATE` before trusting the percentages.

## Verify it worked

```bash
npx -y token-furnace setup              # re-run dry: every step should report "ok"
```

Then, in a fresh session of either agent, confirm the always-on line is in context. If a
session reads a file and then greps for the same symbol, the rule is not reaching the model
— check that the line survived in `CLAUDE.md` / `AGENTS.md` rather than adding more
instructions elsewhere.
