import { describe, expect, it } from "vitest";
import {
  autoPace,
  policyKey,
  validateBudgetPolicy,
  type BudgetMeter,
  type BudgetPolicy,
} from "../src/core/budgets";

const now = new Date("2026-10-10T12:00:00.000Z");

function meter(overrides: Partial<BudgetMeter> = {}): BudgetMeter {
  return {
    id: "anthropic:weekly",
    source: "claude",
    provider: "anthropic",
    account: "account-1",
    usedPercentagePoints: 28,
    resetAt: new Date("2026-10-15T12:00:00.000Z"),
    observedAt: now,
    authoritative: true,
    ...overrides,
  };
}

describe("budget policy arithmetic", () => {
  it("derives 0.6 percentage points per hour from 72 points over 120 hours", () => {
    expect(autoPace(meter({ usedPercentagePoints: 28 }), now)).toBeCloseTo(0.6, 8);
  });

  it("returns no auto pace for stale, unavailable, or expired meters", () => {
    expect(autoPace(meter({ observedAt: new Date(now.getTime() - 6 * 60_000) }), now)).toBeNull();
    expect(autoPace(meter({ authoritative: false }), now)).toBeNull();
    expect(autoPace(meter({ resetAt: new Date(now.getTime() - 1) }), now)).toBeNull();
  });

  it("validates positive manual limits and future deadlines", () => {
    const valid: BudgetPolicy = {
      scope: { kind: "source", source: "claude" },
      mode: "manual",
      unit: "tokens-total",
      limit: 10_000,
      deadline: "2026-10-11T12:00:00.000Z",
    };
    expect(validateBudgetPolicy(valid, now)).toEqual({ policy: valid });
    expect(validateBudgetPolicy({ ...valid, limit: 0 }, now).error).toMatch(/positive/i);
    expect(validateBudgetPolicy({ ...valid, deadline: now.toISOString() }, now).error).toMatch(/future/i);
    expect(validateBudgetPolicy({ ...valid, scope: null as never }, now).error).toMatch(/scope/i);
  });

  it("uses canonical keys for provider and model scopes", () => {
    expect(policyKey({ kind: "provider", provider: "Anthropic" })).toBe("provider:anthropic");
    expect(policyKey({ kind: "model", provider: "Anthropic", model: "Claude-Opus" })).toBe("model:anthropic/claude-opus");
  });
});
