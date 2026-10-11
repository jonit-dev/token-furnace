import { describe, expect, it } from "vitest";
import { isSessionSpike } from "../src/core/analyze/burn";

describe("active session spikes", () => {
  it("uses the responsible session's own burn against twice the provider goal", () => {
    expect(isSessionSpike({ rate: 201 }, { goal: 100 })).toBe(true);
    expect(isSessionSpike({ rate: 200 }, { goal: 100 })).toBe(false);
    expect(isSessionSpike({ rate: 1 }, { goal: 0, limit: 1000 })).toBe(true);
    expect(isSessionSpike({ rate: 0 }, { goal: 0, limit: 1000 })).toBe(false);
    expect(isSessionSpike({ rate: 201 }, undefined)).toBe(false);
    expect(isSessionSpike({ rate: 201 }, { goal: 0 })).toBe(false);
    expect(isSessionSpike({ rate: NaN }, { goal: 100 })).toBe(false);
  });
});
