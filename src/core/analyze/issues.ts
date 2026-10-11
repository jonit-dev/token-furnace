import { fixed, int0 } from "./format";
import {
  CHECK_HOURS,
  CONTEXT_TARGET,
  CODEX_SUBAGENT_KEY,
  LEVELS,
  MEMORY_INDEX_LINES,
  SUBAGENT_CAP,
  SUBAGENT_DEPTH,
  SUBAGENT_ENV,
  TOOL_CONCURRENCY,
} from "./flags";
import type { ActiveSession, Priority, RawIssue, RawReport, SessionRow, Source } from "../model";
import { PROVIDERS } from "../providers";

/** Per leak flag prefix: short fix, title, why it costs tokens, and the prompt for an agent. burn.py:1201 */
export const ISSUES: Record<string, [fix: string, title: string, why: string, action: string]> = {
  "late compaction": [
    `Set autoCompactWindow to ${CONTEXT_TARGET.claude}, then /compact or restart old sessions.`,
    "Sessions compact too late",
    "Every tool call re-reads the whole context. A turn at 500k costs about 5 times a turn at 100k, and auto-compact on a 1M model waits until about 1M.",
    `Set "autoCompactWindow": ${CONTEXT_TARGET.claude} in ~/.claude/settings.json and check that CLAUDE_CODE_AUTO_COMPACT_WINDOW is unset or not higher. Then ask me to /compact or restart each listed session that is still open.`,
  ],
  "caller reads": [
    "Send multi-range reads, greps and log parsing to a cheap read-only subagent.",
    "The caller reads files and logs itself",
    "Each read in the main session is paid at its full context size. A cheap read-only subagent pays it at a small context and returns a short answer.",
    "Read the listed transcripts and find the most repeated file/log read commands. Then add a rule to my global agent instructions: after the brief, any read that is more than one bounded range goes to a cheap read-only subagent. Propose a helper script for any read pattern that repeats more than 20 times.",
  ],
  wakeups: [
    "Ask subagents and teammates for one report at the end; wait with one blocking command.",
    "Too many wakeups",
    "Each teammate message, task notification or cross-session message starts a turn that re-reads the full context.",
    "Read the listed transcripts and find which subagents, teammates or background jobs sent the messages. Change their briefs so they report once at the end, and replace polling or progress pings with one blocking background command per wait.",
  ],
  loop: [
    "Give each /goal or autonomous loop a stop condition and a turn or time budget.",
    "Autonomous loops run without a budget",
    "Hundreds of turns per human prompt means a /goal or autonomous loop kept going with no stop condition.",
    "Read the listed transcripts and name what kept each loop running. Then add a stop condition and a turn or time budget to my goal prompts, skills or global agent instructions.",
  ],
  "long-lived": [
    "Commit, end the session, and start one fresh session per task.",
    "Sessions stay open too long",
    "A session open for many hours carries summaries of many unrelated tasks, so every turn pays for old work.",
    "List which of these sessions are still open. For each, commit its work, end it, and write a one-paragraph handoff so a fresh session can continue from the PRD or task.",
  ],
};

/** Extra context appended to a fix prompt, drawn from Token Furnace's community research. burn.py:1246 */
export const ISSUE_EXTRA: Record<string, string[]> = {
  "late compaction": [
    `Claude: set autoCompactWindow to ${CONTEXT_TARGET.claude}.`,
    "To drop 1M context entirely: `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`.",
    `Codex: model_auto_compact_token_limit = ${CONTEXT_TARGET.codex}.`,
    "Do not compact blindly: compact or hand off between meaningful phases, not every N tokens.",
  ],
  "subagent fan-out cap": [
    "Claude Code defaults to 20 concurrent subagents and nesting depth 3, with no total cap.",
    "Also set the depth cap: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` (Codex: `agents.max_depth`; note Multi-Agent V2 ignores it).",
    "Pin the worker model so it is not inherited silently: `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` (add `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` to hard-enforce).",
    'Codex: prefer `fork_turns="none"` for independent workers so they do not inherit the parent conversation history.',
  ],
  "subagent nesting depth": [
    "Nesting is the worst fan-out: a worker that spawns workers multiplies the whole loop.",
    "Claude: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`. Codex: `agents.max_depth` (Multi-Agent V2 ignores it, so verify the effective depth from real traces).",
  ],
  "subagent model": [
    "`CLAUDE_CODE_SUBAGENT_MODEL=sonnet` is a default, not a guarantee; add `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` to hard-enforce (it overrides intentional per-agent specialization).",
    "Codex: set `agents.default_subagent_model` explicitly; V2 can silently run a costlier worker than requested.",
    "Verify the effective model from real usage, not from the instruction.",
  ],
  "subagent reasoning effort": [
    "Children mostly scan and summarize; keep them at low/medium and let the parent keep its own effort.",
  ],
  "auto-compact token limit": [
    `Codex: model_auto_compact_token_limit = ${CONTEXT_TARGET.codex}.`,
    "Compact or hand off between meaningful phases, not blindly every N tokens.",
  ],
  "tool-call concurrency": [
    "`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=4` bounds parallel tool calls in the main agent.",
    "Limit shell output at the byte level; a line-count cap fails when one line is huge.",
  ],
  "caller reads": [
    "Give a worker a self-contained brief (exact paths, objective, acceptance) instead of forking the whole parent history.",
    "Trim the always-resident preamble once, then leave it stable: reads bill at 0.1x but rewrites at 1.25x.",
  ],
  wakeups: ["Ask teammates and background jobs for one report at the end, then wait once."],
  loop: [
    "Give each worker agent a `maxTurns` ceiling (a 15-30 turn start for bounded tasks).",
    "On two identical failures, stop and re-plan instead of retrying.",
  ],
  "long-lived": [
    "Keep a concise task-state handoff (done / pending / current verification) so a fresh session does not repeat completed work after compaction.",
  ],
  "memory index too long": [
    "Move detail into topic files that load on demand; keep the index under the load limit.",
  ],
};

/** Which agent a config-check line belongs to, for the Checks source column. burn.py:1311 */
export function configSource(line: string): Source | "all" {
  if (
    line.includes(CODEX_SUBAGENT_KEY) ||
    line.includes("max_depth") ||
    line.includes("reasoning_effort") ||
    line.includes("auto_compact_token_limit") ||
    line.startsWith("agents.")
  ) {
    return "codex";
  }
  if (line.includes("CLAUDE") || line.includes("autoCompactWindow") || line.includes("MEMORY.md")) return "claude";
  return "all";
}

/** Group session flags and failed config checks into issues, largest spend share first. burn.py:1321 */
export function topIssues(report: RawReport): RawIssue[] {
  const groups = new Map<string, [SessionRow, string][]>();
  for (const s of report.recent_sessions) {
    for (const flag of s.flags) {
      const kind = flag.split(":")[0];
      const key = `${s.source}:${kind}`;
      const hits = groups.get(key);
      if (hits) hits.push([s, flag]);
      else groups.set(key, [[s, flag]]);
    }
  }
  const issues: RawIssue[] = [];
  for (const hits of groups.values()) {
    const kind = hits[0][1].split(":")[0];
    let [fix, title, why, action] = ISSUES[kind];
    const source = hits[0][0].source;
    if (kind === "late compaction") {
      fix = source === "opencode" ? PROVIDERS[source].compaction : `Set ${PROVIDERS[source].compaction}, then /compact or restart old sessions.`;
      action = source === "opencode" ? PROVIDERS[source].compaction : `Set ${PROVIDERS[source].compaction}. Then ask me to /compact or restart each listed session that is still open.`;
    }
    issues.push({
      title,
      why,
      action,
      fix,
      kind,
      source,
      share: hits.reduce((sum, [s]) => sum + s.share, 0),
      hits,
      priority: 3,
    });
  }
  issues.sort((a, b) => -(a.share ?? 0) - -(b.share ?? 0));

  for (const issue of issues) {
    const fixedLines = report.config.filter((line) =>
      (line.includes("autoCompactWindow") || line.includes("auto_compact_token_limit")) &&
      line.endsWith("ok.") && configSource(line) === issue.source);
    if (issue.kind === "late compaction" && fixedLines.length) {
      issue.fix = "Setting already ok. Restart or /compact the old sessions.";
      issue.action = `The setting is already fixed (${fixedLines[0]}). Restart or /compact the listed sessions that are still open; new sessions are covered.`;
    }
  }
  for (const line of report.config) {
    if (line.endsWith("ok.") || line === "none") continue;
    let title: string;
    let fix: string;
    if (line.includes("autoCompactWindow")) {
      title = "autoCompactWindow";
      fix = line;
    } else if (line.includes("MEMORY.md")) {
      title = "memory index too long";
      fix = `Shorten MEMORY.md under ${MEMORY_INDEX_LINES} lines; move detail into topic files.`;
    } else if (line.includes("SUBAGENT_SPAWN_DEPTH") || line.includes("max_depth")) {
      title = "subagent nesting depth";
      fix = `Cap subagent nesting depth at ${SUBAGENT_DEPTH}: recursive delegation multiplies the loop.`;
    } else if (line.includes("SUBAGENT_MODEL")) {
      title = "subagent model";
      fix = "Pin a cheap worker model so subagents do not inherit a premium one.";
    } else if (line.includes(SUBAGENT_ENV) || line.includes(CODEX_SUBAGENT_KEY)) {
      title = "subagent fan-out cap";
      fix = `Cap concurrent subagents at ${SUBAGENT_CAP}: each one runs its own model and tool loop.`;
    } else if (line.includes("reasoning_effort")) {
      title = "subagent reasoning effort";
      fix = "Set the subagent reasoning effort to low or medium.";
    } else if (line.includes("auto_compact_token_limit")) {
      title = "auto-compact token limit";
      fix = `Set model_auto_compact_token_limit to ${CONTEXT_TARGET.codex}.`;
    } else if (line.includes("TOOL_USE_CONCURRENCY")) {
      title = "tool-call concurrency";
      fix = `Cap parallel tool calls at ${TOOL_CONCURRENCY}.`;
    } else {
      title = line.slice(0, 40);
      fix = line;
    }
    issues.push({
      title: `Config: ${title}`,
      why: line,
      fix,
      action: `Fix this config problem: ${line}`,
      share: null,
      kind: title,
      source: configSource(line),
      hits: [],
      priority: 3,
    });
  }
  for (const issue of issues) issue.priority = issuePriority(issue);
  issues.sort((a, b) => a.priority - b.priority || -(a.share ?? 0) - -(b.share ?? 0));
  return issues;
}

/** 1 fix now, 2 fix this week, 3 when convenient. A one-line config fix behind a big leak is 1. */
export function issuePriority(issue: RawIssue): Priority {
  if (issue.share === null) return issue.title.includes("autoCompactWindow") ? 1 : 2;
  return issue.share >= 20 ? 1 : issue.share >= 5 ? 2 : 3;
}

/** The copy-to-Claude prompt for one issue. burn.py:1390 */
export function issuePrompt(issue: RawIssue): string {
  const agent = issue.source && issue.source !== "all" ? PROVIDERS[issue.source].label : "the affected agents";
  const lines = [`Token leak to fix: ${issue.title}.`, `Applies to: ${agent}.`];
  if (issue.share !== null) {
    lines.push(
      `It affects ${issue.hits.length} of my top sessions, ${fixed(issue.share)}% of total spend in the last ${CHECK_HOURS} h (base-input-equivalent tokens).`,
    );
  }
  lines.push("", `Why it costs tokens: ${issue.why}`);
  if (issue.hits.length) {
    lines.push("", "Evidence:");
    for (const [s, flag] of issue.hits) {
      lines.push(
        `- ${s.title || "untitled"} (session ${s.id}, ${fixed(s.share, 1)}% of spend, ${s.turns} turns, peak ${int0(s.peak / 1000)}k, ${fixed(s.hours)}h): ${flag}`,
      );
      if (s.path) lines.push(`  transcript: ${s.path}`);
    }
  }
  const extra = issue.kind === "late compaction" && issue.source && issue.source !== "all"
    ? [`${PROVIDERS[issue.source].label}: ${PROVIDERS[issue.source].compaction}.`, "Compact or hand off between meaningful phases, not every N tokens."]
    : ISSUE_EXTRA[issue.kind];
  if (extra) lines.push("", "Additional info:", ...extra.map((e) => `- ${e}`));
  lines.push("", `What to do: ${issue.action}`, "", "Report what you changed and how to check that it worked.");
  return lines.join("\n");
}

/**
 * A copy-to-agent prompt for one flag on one live session. It carries what another agent needs to
 * find the session, and says to fix it there or in the rules file when the cause will repeat.
 */
export function sessionFixPrompt(s: ActiveSession, flag: string): string {
  const kind = flag.split(":")[0];
  const [fix, title, why] = ISSUES[kind] ?? [flag, kind, "", flag];
  const provider = PROVIDERS[s.source];
  const id = s.fullId || s.id;
  const lines = [
    `Token leak to fix in one ${provider.label} session: ${title}.`,
    "",
    "Find the session:",
    `- Agent: ${provider.label}`,
    `- Session ID: ${id}`,
    `- Project: ${s.project}`,
    `- Title: ${s.title || "(untitled)"}`,
    s.path
      ? `- Transcript: ${s.path}`
      : `- Transcript: not recorded. Search the ${provider.label} data folder for a file whose name or content has the session ID.`,
    `- State: ${s.model || "unknown model"}, ${s.turns} turns, ${fixed(s.hours, 1)} h old, idle ${(s.idle || 0) < 1 ? "now" : int0(s.idle) + " min"}, context ${int0(s.context / 1000)}k, peak ${int0(s.peak / 1000)}k`,
    "",
    `Measured: ${flag}`,
  ];
  if (why) lines.push(`Why it costs tokens: ${why}`);
  lines.push(
    "",
    "What to do:",
    "1. Read the transcript and find the turns behind the measurement above, such as the most repeated tool calls or the point where the context grew past the target.",
    `2. If the cause is specific to this task, fix it in this session: ${fix}`,
    `3. If the same mistake would repeat in other sessions, add a short rule to ${provider.rules} instead: the project's ${provider.rules} for this project, or the global one for every project. Write the rule as an instruction to the agent, not as a note.`,
  );
  const extra = kind === "late compaction"
    ? [`${provider.label}: ${provider.compaction}.`, "Compact or hand off between meaningful phases, not every N tokens."]
    : ISSUE_EXTRA[kind];
  if (extra) lines.push("", "Additional info:", ...extra.map((e) => `- ${e}`));
  lines.push("", "Report what you changed, where, and how to check that it worked.");
  return lines.join("\n");
}

export { LEVELS };
