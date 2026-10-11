import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetService } from "../src/services/budget-service";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "tf-budget-concurrency-"));
  roots.push(root);
  const now = new Date("2026-10-10T12:00:00.000Z");
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  return { env, now };
}

describe("durable budget concurrency", () => {
  it("serializes two real SQLite service writers so only one reservation uses the same allowance", () => {
    const { env, now } = setup();
    const first = new BudgetService(env, { now: () => now });
    first.savePolicies([{
      scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-total", limit: 100, deadline: "2026-10-11T12:00:00.000Z",
    }], 0);
    const second = new BudgetService(env, { now: () => now });
    const decisions = [first, second].map((service) => service.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 80, now }));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1);
    first.close();
    second.close();
  });

  it("denies every admission when an enabled settings file is malformed", () => {
    const { env, now } = setup();
    const service = new BudgetService(env, { now: () => now });
    service.savePolicies([{
      scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-total", limit: 100, deadline: "2026-10-11T12:00:00.000Z",
    }], 0);
    writeFileSync(service.settingsPath, "{not-json", { mode: 0o600 });
    expect(service.snapshot().error).toMatch(/malformed|JSON/i);
    expect(service.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 1, now }).allowed).toBe(false);
    service.close();
  });
});
