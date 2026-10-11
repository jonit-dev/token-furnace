import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetService, type BudgetSourceDescriptor } from "../src/services/budget-service";
import type { BudgetMeter, BudgetPolicy } from "../src/core/budgets";

const now = new Date("2026-10-10T12:00:00.000Z");
const sources: BudgetSourceDescriptor[] = [
  { source: "claude", label: "Claude Code", installed: true },
  { source: "codex", label: "Codex", installed: false },
  { source: "opencode", label: "OpenCode", installed: true },
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "tf-budget-service-"));
  roots.push(root);
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
  return { env, service: new BudgetService(env, { now: () => now }) };
}

function manual(limit: number): BudgetPolicy {
  return {
    scope: { kind: "source", source: "claude" },
    mode: "manual",
    unit: "tokens-total",
    limit,
    deadline: "2026-10-11T12:00:00.000Z",
  };
}

describe("BudgetService", () => {
  it("defaults every supported source to Off and preserves a revisioned policy file", () => {
    const { service } = setup();
    expect(service.snapshot(sources).sources.map((source) => [source.source, source.policy?.mode ?? "off"])).toEqual([
      ["claude", "off"],
      ["codex", "off"],
      ["opencode", "off"],
    ]);
    const saved = service.savePolicies([manual(100)], 0);
    expect(saved.revision).toBe(1);
    expect(() => service.savePolicies([manual(100)], 0)).toThrow(/revision/i);
    service.close();
  });

  it("keeps reservations and measured usage across service restarts without free credit on edits", () => {
    const { env, service } = setup();
    service.savePolicies([manual(100)], 0);
    service.recordUsage({ scope: { kind: "source", source: "claude" }, amount: 70, eventId: "turn-1", at: now });
    const first = service.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 20, now });
    expect(first.allowed).toBe(true);
    const blocked = service.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 20, now });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/allowance|budget/i);
    service.savePolicies([{ ...manual(100), deadline: "2026-10-12T12:00:00.000Z" }], 1);
    service.close();
    const reopened = new BudgetService(env, { now: () => now });
    expect(reopened.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 20, now }).allowed).toBe(false);
    reopened.release(first.reservationId!);
    expect(reopened.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 40, now }).allowed).toBe(false);
    reopened.close();
  });

  it("persists an emergency latch until the exact scope is explicitly unlocked", () => {
    const { env, service } = setup();
    const preview = service.previewStop({ kind: "provider", provider: "Anthropic" }, []);
    const operation = service.commitStop(preview.id, preview.fingerprint, []);
    expect(operation.status).toBe("partial");
    expect(service.admit({ identity: { source: "claude", provider: "anthropic", model: "claude-opus" }, estimatedCost: 1, now }).allowed).toBe(false);
    service.close();
    const reopened = new BudgetService(env, { now: () => now });
    expect(reopened.admit({ identity: { source: "claude", provider: "anthropic", model: "claude-opus" }, estimatedCost: 1, now }).allowed).toBe(false);
    reopened.unlock({ kind: "provider", provider: "anthropic" });
    expect(reopened.admit({ identity: { source: "claude", provider: "anthropic", model: "claude-opus" }, estimatedCost: 1, now }).allowed).toBe(true);
    reopened.close();
  });

  it("uses the authoritative reset window for Auto and reserves overlapping admissions", () => {
    const { service } = setup();
    service.setMeters([{
      id: "anthropic:weekly", source: "claude", provider: "anthropic", account: null,
      usedPercentagePoints: 28, resetAt: new Date("2026-10-15T12:00:00.000Z"), observedAt: now, authoritative: true,
    } satisfies BudgetMeter]);
    service.savePolicies([{
      scope: { kind: "source", source: "claude" }, mode: "auto", unit: "percentage-per-hour", limit: null, deadline: null,
    }], 0);
    expect(service.admit({ identity: { source: "claude", provider: "anthropic", model: "claude-opus" }, estimatedCost: 0.59, costUnit: "percentage-per-hour", now }).allowed).toBe(true);
    expect(service.admit({ identity: { source: "claude", provider: "anthropic", model: "claude-opus" }, estimatedCost: 0.02, costUnit: "percentage-per-hour", now }).allowed).toBe(false);
  });

  it("blocks an expired cumulative policy instead of silently granting a new interval", () => {
    let clock = now;
    const root = mkdtempSync(join(tmpdir(), "tf-budget-expiry-"));
    roots.push(root);
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
    const service = new BudgetService(env, { now: () => clock });
    service.savePolicies([manual(100)], 0);
    clock = new Date("2026-10-12T12:00:01.000Z");
    expect(service.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 1, now: clock }).allowed).toBe(false);
    service.close();
  });
});
