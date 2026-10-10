import { CONTEXT_TARGET } from "../context";
export { CONTEXT_TARGET } from "../context";
import type { Source } from "../model";
import { fixed } from "./format";
import type { WakeCounts } from "../model";
import { int0 } from "./format";

// Windows for the weekly-limit gain: percentage points spent in the last N hours.
export const GAIN_HOURS = [1, 6, 24];
// Window for the checks and the leaks: what the user fixed recently must show up.
export const CHECK_HOURS = 24;
export const LEVELS: Record<number, "critical" | "warn" | "info"> = {
  1: "critical",
  2: "warn",
  3: "info",
};

/** Thresholds for the per-session leak flags. Each one maps to a measured failure. */
export const CALLER_READS = 100; // reads the caller ran itself instead of delegating
export const WAKEUPS = 50; // teammate/task/peer messages, each a full-context turn
export const TURNS_PER_PROMPT = 200; // an unbounded autonomous loop
export const LONG_LIVED_HOURS = 12; // one session carrying many unrelated tasks
export const MEMORY_INDEX_LINES = 200; // Claude Code loads only this many lines of MEMORY.md
export const SUBAGENT_CAP = 3; // most concurrent subagents worth running (each one is a full loop)
export const SUBAGENT_DEPTH = 1; // nesting depth: 1 blocks subagents spawning subagents
export const TOOL_CONCURRENCY = 4; // parallel tool calls in the main agent
export const SUBAGENT_ENV = "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS";
export const CODEX_SUBAGENT_KEY = "max_concurrent_threads_per_session";

/** A session whose last turn is this recent counts as active right now. */
export const ACTIVE_MINUTES = 30;

/** The leak flags for one session, each naming its own fix. burn.py:316 */
export function sessionFlags(
  turns: number,
  peak: number,
  hours: number,
  reads: number,
  wakes: WakeCounts,
  source: Source,
): string[] {
  const flags: string[] = [];
  if (peak > CONTEXT_TARGET[source]) {
    flags.push(
      `late compaction: peak ${int0(peak / 1000)}k. Use a ${CONTEXT_TARGET[source]} ${source} compaction window.`,
    );
  }
  if (reads >= CALLER_READS) {
    flags.push(
      `caller reads: ${reads} file/log reads. Send them to a cheap read-only agent.`,
    );
  }
  const pings = wakes.teammate + wakes.task + wakes.peer;
  if (pings >= WAKEUPS) {
    flags.push(
      `wakeups: ${pings} (teammate ${wakes.teammate}, task ${wakes.task}, peer ${wakes.peer}). Ask for one report at the end.`,
    );
  }
  if (turns / Math.max(wakes.human, 1) >= TURNS_PER_PROMPT) {
    flags.push(
      `loop: ${turns} turns for ${wakes.human} human prompts. Give the loop a stop condition and a budget.`,
    );
  }
  if (hours >= LONG_LIVED_HOURS) {
    flags.push(`long-lived: ${fixed(hours)}h. Start one fresh session per task.`);
  }
  return flags;
}