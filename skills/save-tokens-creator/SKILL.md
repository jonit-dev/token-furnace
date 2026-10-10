---
name: save-tokens-creator
description: Use when choosing which model to run a task on, when setting up or reviewing the coding-agent subscriptions, plans and models on a machine, or when asked "which model should I use for X". Maps the providers, plans and models the machine can actually reach, reads the live artificialanalysis.ai leaderboard, and assigns the best reachable model to each use case. Re-run after any new provider, plan or model.
---

# save-tokens-creator

Build a use-case-to-model map from what this machine can actually reach. The map is the
input to delegation, so a wrong entry sends work to a model the user cannot run.

> **Keep this skill current.** When you add a provider, plan or model, ask Claude or Codex
> to update this skill. A stale map sends work to a model that is gone, or ignores a cheaper
> one that arrived. Any change to a login, a subscription, or `opencode models` is a trigger
> to re-run the steps below.

## Step 1 - Read what exists on this machine

Run these read-only checks and record the result. Do not assume: a provider with no login is
not available.

```sh
token-furnace --list-sources          # agents installed, with transcripts
which claude codex opencode gcodex codexbar
opencode models                        # the Zen free tier and the Go models
codexbar usage --provider claude --json
codexbar usage --provider opencodego --json
```

Then read each plan from its own file:

- Claude: `~/.claude/settings.json` and the login in `~/.claude/.credentials.json`.
- Codex: `~/.codex/config.toml`.
- OpenCode: `auth.json` in the OpenCode data dir (`$XDG_DATA_HOME/opencode` or
  `~/.local/share/opencode`), keyed by `opencode-go`, and the `opencode models` list.
- gcodex, if installed, bills the Google AI Pro subscription through its own profile.

A missing file, or an empty key, means that provider is out. The result is the **allowed
set**. Every later step may only use models from this set.

## Step 2 - Read the live ranking

Fetch the leaderboard and use its current numbers, not memory:

<https://artificialanalysis.ai/leaderboards/models>

For each candidate in the allowed set, note quality, price and speed. The board moves, so a
model that led last month may not lead today.

## Step 3 - Assign a model to each use case

Rank only models from Step 1. Match the model to the job, not to the biggest number.

| Use case | Pick |
| --- | --- |
| Routine edits, boilerplate, tests, bounded reads | The cheapest reachable model that passes the task; the free Zen tier first |
| Multi-file implementation with a clear spec | A mid-tier reachable model |
| Architecture, security, hard debugging | The strongest reachable model |
| Long unattended runs | A reachable model with a stable plan and a known rate limit |

A free or plan-backed model that is reachable beats a stronger model that bills per token.
Escalate to the strong model only after the cheap one fails twice on the same cause.

## Step 4 - Write the map

Produce one table: use case, model id, the leaderboard fact that justifies it, and the plan
that covers it. Keep it to the allowed set. State the date of the reading, because the
ranking moves.

## Step 5 - Use the map

Hand the map to `save-tokens` or `arm.sh` when you route work. Set `ARM_MODELS` from the map
when this machine's access differs from the default chain. Do not paste a model the map does
not list.

## Re-check

Re-run Steps 1 to 4 when any of these changes: a new login, a new subscription or plan, a new
model in `opencode models`, or a leaderboard shift that changes the cheap pick. The map is
only as good as its last reading.
