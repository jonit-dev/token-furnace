/**
 * The retry circuit breaker as a Claude Code PostToolUse hook. Port of scripts/escalate-on-churn.py.
 *
 * Counts edits per file per session. When one file is edited past a threshold, the agent is grinding
 * at a capability level that is not solving the problem. The hook tells it to ESCALATE -- hand the
 * work to a more capable model or a deeper reasoning pass, carrying what has already been tried --
 * rather than attempting another variation at the same level.
 *
 * It never blocks the edit and never tells the agent to abandon the task. A breaker that stops work
 * converts a token problem into an unfinished-work problem. Malformed input is ignored, not raised:
 * a hook that fails the tool call breaks the work it is meant to protect.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import type { Env } from "../sources/agent-source";

/** Edits to one file before the first nudge, then one nudge every EVERY edits after. */
function thresholds(env: Env): { first: number; every: number } {
  const first = Number.parseInt(env.CHURN_FIRST ?? "4", 10);
  const every = Number.parseInt(env.CHURN_EVERY ?? "3", 10);
  return {
    first: Number.isInteger(first) && first > 0 ? first : 4,
    every: Number.isInteger(every) && every > 0 ? every : 3,
  };
}

const MESSAGE = (name: string, n: number): string =>
  `CIRCUIT BREAKER: ${name} has been edited ${n} times this session.\n` +
  "If the last two attempts failed for the same underlying reason, stop trying another variation " +
  "at this level and ESCALATE:\n" +
  "  1. State the assumption that must be wrong for these attempts to have failed.\n" +
  "  2. Hand the problem to a more capable model or a higher-effort reasoning pass, or to a fresh " +
  "deeper investigation pass.\n" +
  "  3. Carry forward what was already tried and why each attempt failed, so the escalated pass " +
  "does not repeat them.\n" +
  "Keep working the task -- escalate the capability applied to it, do not abandon it.";

interface HookEvent {
  tool_name?: string;
  tool_input?: { file_path?: string };
  session_id?: string;
}

/** The stdin payload: one JSON object, or several newline-separated for a piped batch. */
function eventsOf(stdin: string): HookEvent[] {
  try {
    const event: unknown = JSON.parse(stdin);
    return event && typeof event === "object" && !Array.isArray(event) ? [event as HookEvent] : [];
  } catch {
    // A batch is newline-delimited; one hook payload may itself span several lines.
  }
  const out: HookEvent[] = [];
  for (const line of stdin.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as HookEvent;
      if (event && typeof event === "object") out.push(event);
    } catch {
      // never break the tool call on malformed input
    }
  }
  return out;
}

/** One session, one file, one counter, in the same place the Python version kept it. */
function stateFile(env: Env, session: string): string {
  const key = (session || "none").slice(0, 40).replaceAll(sep, "_");
  return join(tmpdir(), `agent-churn-${key}.json`);
}

/** Counts the edit and prints the escalation prompt when the count lands on a threshold. */
export function churnOnce(
  event: HookEvent,
  env: Env,
  out: { write(text: string): unknown },
): void {
  if (event.tool_name !== "Edit" && event.tool_name !== "Write" && event.tool_name !== "NotebookEdit") {
    return;
  }
  const path = event.tool_input?.file_path;
  if (typeof path !== "string" || !path) return;

  const file = stateFile(env, String(event.session_id ?? "none"));
  let state: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      state = parsed as Record<string, unknown>;
    }
  } catch {
    state = {};
  }

  const previous = Number(state[path]);
  const count = (Number.isInteger(previous) ? previous : 0) + 1;
  state[path] = count;
  try {
    writeFileSync(file, JSON.stringify(state)); // a lost counter is cheaper than a failed edit
  } catch {
    /* see above */
  }

  const { first, every } = thresholds(env);
  if (count < first || (count - first) % every) return;
  out.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: MESSAGE(basename(path), count),
      },
    })}\n`,
  );
}

/** `token-furnace hook churn`. Always 0: a breaker never fails the tool call. */
export function runChurnHook(
  stdin: string,
  env: Env = process.env,
  out: { write(text: string): unknown } = process.stdout,
): number {
  for (const event of eventsOf(stdin)) churnOnce(event, env, out);
  return 0;
}

/** Reads stdin to the end. Sync on purpose: a hook is a short-lived process, not a server. */
export function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
