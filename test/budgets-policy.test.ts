import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  autoPace,
  policyKey,
  validateBudgetPolicy,
  type BudgetMeter,
  type BudgetPolicy,
} from "../src/core/budgets";
import { BudgetService } from "../src/services/budget-service";

const now = new Date("2026-10-10T12:00:00.000Z");
const policySources = [{ source: "claude" as const, label: "Claude Code", installed: true }];
const roots: string[] = [];
const services: BudgetService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
    window: "7d",
    ...overrides,
  };
}

function openService(clock: { current: Date }): BudgetService {
  const root = mkdtempSync(join(tmpdir(), "tf-budget-policy-service-"));
  roots.push(root);
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  const service = new BudgetService(env, { now: () => clock.current });
  services.push(service);
  return service;
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

  it("consumes Auto pace through the service and requires a fresh confirmed reset", () => {
    const clock = { current: new Date(now) };
    const service = openService(clock);
    const identity = { source: "claude" as const, provider: "anthropic", account: "account-1", model: "claude-opus" };
    const initialReset = new Date(clock.current.getTime() + 120 * 3_600_000);
    service.setMeters([meter({ resetAt: initialReset, window: "7d" })]);
    service.savePolicies([{ scope: { kind: "source", source: "claude" }, mode: "auto", unit: "percentage-per-hour", limit: null, deadline: null }], 0);

    const initial = service.snapshot(policySources).sources[0];
    expect(initial.pace).toBeCloseTo(0.6, 8);
    expect(initial.allowance).toBeCloseTo(0.6, 8);

    const consumed = service.admit({ identity, estimatedCost: 0.25, costUnit: "percentage-per-hour", requestId: "auto-consumed", now: clock.current });
    expect(consumed.allowed).toBe(true);
    service.reconcile(consumed.reservationId!, 0.25, "auto-consumed-usage", clock.current);
    const outstanding = service.admit({ identity, estimatedCost: 0.2, costUnit: "percentage-per-hour", requestId: "auto-outstanding", now: clock.current });
    expect(outstanding.allowed).toBe(true);

    clock.current = new Date(initialReset.getTime() + 60_000);
    const expired = service.snapshot(policySources).sources[0];
    expect(expired.pace).toBeNull();
    expect(expired.allowance).toBeNull();
    const withoutFreshReading = service.admit({ identity, estimatedCost: 0.1, costUnit: "percentage-per-hour", requestId: "auto-no-reset-reading", now: clock.current });
    expect(withoutFreshReading.allowed).toBe(false);
    expect(withoutFreshReading.reason).toMatch(/authoritative|stale|unavailable/i);

    service.setMeters([meter({
      usedPercentagePoints: 94,
      resetAt: new Date(clock.current.getTime() + 20 * 3_600_000),
      observedAt: clock.current,
      window: "7d",
    })]);
    const refreshed = service.snapshot(policySources).sources[0];
    expect(refreshed.pace).toBeCloseTo(0.3, 8);
    expect(refreshed.allowance).toBeCloseTo(0.3, 8);

    const chargedByOutstanding = service.admit({ identity, estimatedCost: 0.2, costUnit: "percentage-per-hour", requestId: "auto-post-reset-blocked", now: clock.current });
    expect(chargedByOutstanding.allowed).toBe(false);
    service.release(outstanding.reservationId!);
    const afterRelease = service.admit({ identity, estimatedCost: 0.2, costUnit: "percentage-per-hour", requestId: "auto-post-reset-allowed", now: clock.current });
    expect(afterRelease.allowed).toBe(true);
    service.reconcile(afterRelease.reservationId!, 0.2, "auto-post-reset-usage", clock.current);
    expect(service.admit({ identity, estimatedCost: 0.11, costUnit: "percentage-per-hour", requestId: "auto-post-reset-excess", now: clock.current }).allowed).toBe(false);
  });

  it("keeps Manual hourly usage and live reservations across edits and rolling expiry", () => {
    const clock = { current: new Date(now) };
    const service = openService(clock);
    const scope = { kind: "source" as const, source: "claude" as const };
    const identity = { source: "claude" as const, provider: null, model: null };
    const manualHourly = { scope, mode: "manual" as const, unit: "tokens-per-hour" as const, limit: 10, deadline: null };
    service.savePolicies([manualHourly], 0);
    service.recordUsage({ scope, amount: 6, unit: "tokens-per-hour", eventId: "manual-hourly-usage", at: clock.current });

    const reservation = service.admit({ identity, estimatedCost: 3, costUnit: "tokens-per-hour", requestId: "manual-hourly-reservation", now: clock.current });
    expect(reservation.allowed).toBe(true);
    expect(service.admit({ identity, estimatedCost: 2, costUnit: "tokens-per-hour", requestId: "manual-hourly-excess", now: clock.current }).allowed).toBe(false);

    service.savePolicies([{ ...manualHourly, limit: 10 }], 1);
    service.savePolicies([{ ...manualHourly, mode: "off", limit: null }], 2);
    service.savePolicies([manualHourly], 3);
    expect(service.admit({ identity, estimatedCost: 2, costUnit: "tokens-per-hour", requestId: "manual-hourly-after-edit", now: clock.current }).allowed).toBe(false);

    clock.current = new Date(clock.current.getTime() + 3_600_001);
    expect(service.admit({ identity, estimatedCost: 8, costUnit: "tokens-per-hour", requestId: "manual-hourly-reservation-still-charged", now: clock.current }).allowed).toBe(false);
    service.release(reservation.reservationId!);
    expect(service.admit({ identity, estimatedCost: 8, costUnit: "tokens-per-hour", requestId: "manual-hourly-after-expiry", now: clock.current }).allowed).toBe(true);
  });

  it("keeps unavailable quota explicit while allowing a custom model token allowance", () => {
    const clock = { current: new Date(now) };
    const service = openService(clock);
    const quotaIdentity = { source: "claude" as const, provider: "anthropic", account: "account-1", model: "claude-opus" };
    service.savePolicies([{ scope: { kind: "source", source: "claude" }, mode: "auto", unit: "percentage-per-hour", limit: null, deadline: null }], 0);
    const unavailable = service.snapshot(policySources).sources[0];
    expect(unavailable.status).toBe("Usage unavailable");
    expect(unavailable.pace).toBeNull();
    expect(unavailable.allowance).toBeNull();
    expect(service.admit({ identity: quotaIdentity, estimatedCost: 0.1, costUnit: "percentage-per-hour", now: clock.current }).allowed).toBe(false);

    service.savePolicies([{ scope: { kind: "provider", provider: "custom" }, mode: "manual", unit: "percentage-per-hour", limit: 5, deadline: null }], 1);
    expect(service.admit({ identity: { source: "opencode", provider: "custom", account: "custom-account", model: "custom-model" }, estimatedCost: 1, costUnit: "percentage-per-hour", now: clock.current }).allowed).toBe(false);

    service.savePolicies([{ scope: { kind: "model", provider: "custom", model: "custom-model" }, mode: "manual", unit: "tokens-per-hour", limit: 5, deadline: null }], 2);
    expect(service.admit({ identity: { source: "opencode", provider: "custom", account: "custom-account", model: "custom-model" }, estimatedCost: 4, costUnit: "tokens-per-hour", now: clock.current }).allowed).toBe(true);
  });
});
