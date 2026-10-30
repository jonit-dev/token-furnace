import { fixed } from "./format";
import { kindOf } from "../providers";
import type { Burn, ProviderId, RawReport } from "../model";

/** Match critical burn severity using the session's contribution, not the provider total. */
export function isSessionSpike(session: { rate: number }, burn?: Pick<Burn, "goal"> & Partial<Pick<Burn, "limit">>): boolean {
  return !!burn && burn.goal !== null && Number.isFinite(session.rate) && Number.isFinite(burn.goal)
    && (burn.goal > 0 || (burn.goal === 0 && (burn.limit ?? 0) > 0))
    && session.rate > 2 * burn.goal;
}

/**
 * Cumulative (time, % of the weekly limit used, % if context were capped) per hour, from the
 * week start to now. The last point is the calibrated total, so it equals the plan's reading.
 * burn.py:843
 */
export function weekPoints(
  buckets: Map<number, [number, number]>,
  start: Date,
  now: Date,
  limit: number,
): [Date, number, number][] {
  const points: [Date, number, number][] = [[start, 0, 0]];
  let used = 0;
  let capped = 0;
  for (const [hour, slot] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    used += slot[0];
    capped += slot[1];
    const end = new Date(hour + 3_600_000);
    points.push([end < now ? end : now, (used * 100) / limit, (capped * 100) / limit]);
  }
  const last = points[points.length - 1];
  if (last[0].getTime() < now.getTime()) points.push([now, last[1], last[2]]);
  return points;
}

/**
 * The hourly burn goal for one source: the plan's remaining week over the hours to its
 * reset, else (Claude only) a weekly budget over 168 h, else the window's own average.
 * burn.py:912
 */
export function burnGoal(report: RawReport, source: ProviderId): [number, string] {
  const burn = report.burns[source];
  if (!burn) return [0, "no burn for this source"];
  const week = burn.week;
  if (week && week.ideal !== null) {
    return [
      week.ideal,
      `ideal pace to the weekly reset ${localStamp(week.resets)} (${fixed(week.hours_left)} h left)`,
    ];
  }
  if (report.budget && kindOf(source) === "claude") {
    return [report.budget / 168, `weekly budget ${fixed(report.budget / 1e6)}M / 168 h`];
  }
  if (week) {
    // Only the plan's meter is known: the gauge reads %/h from it; tokens use the window's average.
    return [
      burn.total / (report.days * 24),
      `ideal pace from the plan's meter to the weekly reset ${localStamp(week.resets)} (${fixed(week.hours_left)} h left); ` +
        `token goal is your ${report.days}-day average until the plan size is known`,
    ];
  }
  return [
    burn.total / (report.days * 24),
    `your ${report.days}-day average; ` +
      (burn.pending
        ? "the weekly quota is new and has no spend to calibrate against yet"
        : "the subscription usage was unavailable"),
  ];
}

/** Python's strftime("%a %H:%M") in the local zone. */
function localStamp(when: Date): string {
  const local = new Date(when.getTime() - when.getTimezoneOffset() * 60_000);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][local.getUTCDay()];
  const hours = String(local.getUTCHours()).padStart(2, "0");
  const minutes = String(local.getUTCMinutes()).padStart(2, "0");
  return `${day} ${hours}:${minutes}`;
}
