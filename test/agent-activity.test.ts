import { describe, expect, it } from "vitest";
import { agentActivity } from "../src/core/analyze/agent-activity";
import type { ActivityTurn } from "../src/core/model";

const now = new Date("2026-10-10T12:00:00Z");
const minute = 60_000;
const day = 24 * 60 * minute;
const turn = (age: number, session: string, source: ActivityTurn["source"] = "claude"): ActivityTurn =>
  ({ source, project: "demo", session, at: now.getTime() - age });
const stats = (turns: ActivityTurn[]) => agentActivity(turns.sort((a, b) => a.at - b.at), now, ["claude", "codex"]);

describe("active agent history", () => {
  it("deduplicates turns and counts concurrent sessions across providers", () => {
    const result = stats([turn(10 * minute, "same"), turn(9 * minute, "same"), turn(8 * minute, "same", "codex")]);
    expect(result.peak7d).toBe(2);
    expect(result.peakLifetime).toBe(2);
    expect(result.timeline.at(-1)).toEqual([now.toISOString(), 2]);
    expect(result.timeline).toHaveLength(49);
  });

  it("finds a brief peak between chart samples and preserves older lifetime peaks", () => {
    const result = stats([
      ...["a", "b", "c"].map(id => turn(8 * day, id)),
      turn(61 * minute, "x"), turn(32 * minute, "y", "codex"),
    ]);
    expect(result.peakLifetime).toBe(3);
    expect(result.peak7d).toBe(2);
    expect(Math.max(...result.timeline.map(point => point[1]))).toBe(1);
    expect(result.timeline.at(-1)?.[1]).toBe(0);
  });

  it("includes activity spanning the seven-day boundary and the exact expiry instant", () => {
    const result = stats([turn(7 * day + 10 * minute, "old"), turn(30 * minute, "current")]);
    expect(result.peak7d).toBe(1);
    expect(result.timeline.at(-1)?.[1]).toBe(1);
    expect(stats([turn(30 * minute + 1, "expired")]).timeline.at(-1)?.[1]).toBe(0);
  });

  it("handles idle gaps, excluded providers, future turns and empty history", () => {
    const result = stats([turn(day, "repeat"), turn(0, "repeat"), turn(0, "hidden", "opencode"), turn(-minute, "future")]);
    expect(result.peakLifetime).toBe(1);
    expect(result.timeline.at(-1)?.[1]).toBe(1);
    expect(stats([]).peakLifetime).toBe(0);
    expect(stats([]).timeline.every(point => point[1] === 0)).toBe(true);
  });
});
