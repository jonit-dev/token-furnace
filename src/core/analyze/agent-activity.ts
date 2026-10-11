import type { ActivityTurn, AgentActivity, SessionInput, Source } from "../model";
import { ACTIVE_MINUTES } from "./flags";

/** Memory repository and pure-report fallback; SQLite streams these columns directly. */
export function activityTurns(sessions: SessionInput[]): ActivityTurn[] {
  return sessions.flatMap(file => file.turns
    .filter(turn => turn.baseIn + turn.cacheRead + turn.cacheWrite > 0)
    .map(turn => ({ source: file.source, project: turn.project, session: turn.session, at: turn.when.getTime() })))
    .sort((a, b) => a.at - b.at);
}

/** Input is chronological. Merge each session's active intervals before sweeping boundaries. */
export function agentActivity(turns: Iterable<ActivityTurn>, now: Date, sources: readonly Source[]): AgentActivity {
  const end = now.getTime();
  const window = ACTIVE_MINUTES * 60_000;
  const day = 86_400_000;
  const live = new Set(sources);
  const events: { at: number; delta: number }[] = [];
  const endings = new Map<string, { at: number; delta: number }>();
  for (const turn of turns) {
    if (!live.has(turn.source) || !Number.isFinite(turn.at) || turn.at > end) continue;
    const key = JSON.stringify([turn.source, turn.project, turn.session]);
    const previous = endings.get(key);
    // Expire one millisecond after the inclusive 30-minute boundary, matching active sessions.
    const expiry = turn.at + window + 1;
    if (previous && turn.at <= previous.at) previous.at = expiry;
    else {
      const ending = { at: expiry, delta: -1 };
      events.push({ at: turn.at, delta: 1 }, ending);
      endings.set(key, ending);
    }
  }
  events.sort((a, b) => a.at - b.at);
  let count = 0;
  let peak7d = 0;
  let peakLifetime = 0;
  const weekStart = end - 7 * day;
  for (let i = 0; i < events.length && events[i].at <= end;) {
    const at = events[i].at;
    do { count += events[i++].delta; } while (i < events.length && events[i].at === at);
    peakLifetime = Math.max(peakLifetime, count);
    // Before the boundary retain the count carried into the week, then track its maximum.
    peak7d = at <= weekStart ? count : Math.max(peak7d, count);
  }
  const timeline: AgentActivity["timeline"] = [];
  count = 0;
  let i = 0;
  for (let at = end - day; at <= end; at += window) {
    while (i < events.length && events[i].at <= at) count += events[i++].delta;
    timeline.push([new Date(at).toISOString(), count]);
  }
  return { timeline, peak7d, peakLifetime };
}
