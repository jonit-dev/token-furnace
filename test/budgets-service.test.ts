import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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

  it("does not let unresolved identities bypass provider or matching-model stops", () => {
    const { service } = setup();
    const providerPreview = service.previewStop({ kind: "provider", provider: "anthropic" }, []);
    expect(service.commitStop(providerPreview.id, providerPreview.fingerprint, []).status).toBe("partial");

    const unresolved = service.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 1, now });
    expect(unresolved.allowed).toBe(false);
    expect(unresolved.reason).toMatch(/resolved provider\/model identity/i);
    expect(service.admit({ identity: { source: "claude", provider: "openai", model: "gpt-6.1" }, estimatedCost: 1, now }).allowed).toBe(true);
    service.unlock({ kind: "provider", provider: "anthropic" });

    const modelPreview = service.previewStop({ kind: "model", provider: "anthropic", model: "claude-sonnet-4-5" }, []);
    expect(service.commitStop(modelPreview.id, modelPreview.fingerprint, []).status).toBe("partial");
    expect(service.admit({ identity: { source: "claude", provider: "anthropic", model: null }, estimatedCost: 1, now }).allowed).toBe(false);
    expect(service.admit({ identity: { source: "claude", provider: "openai", model: "gpt-6.1" }, estimatedCost: 1, now }).allowed).toBe(true);
    expect(service.admit({ identity: { source: "claude", provider: "anthropic", model: "claude-sonnet-4-5" }, estimatedCost: 1, now }).allowed).toBe(false);
    service.unlock({ kind: "model", provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(service.admit({ identity: { source: "claude", provider: "anthropic", model: "claude-sonnet-4-5" }, estimatedCost: 1, now }).allowed).toBe(true);
    expect(service.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 1, now }).allowed).toBe(true);
    service.close();
  });

  it("uses the authoritative reset window for Auto and reserves overlapping admissions", () => {
    const { service } = setup();
    service.setMeters([{
      id: "anthropic:weekly", source: "claude", provider: "anthropic", account: "account-1",
      usedPercentagePoints: 28, resetAt: new Date("2026-10-15T12:00:00.000Z"), observedAt: now, authoritative: true, window: "7d",
    } satisfies BudgetMeter]);
    service.savePolicies([{
      scope: { kind: "source", source: "claude" }, mode: "auto", unit: "percentage-per-hour", limit: null, deadline: null,
    }], 0);
    // 28 points moved while 2800 weighted tokens were recorded in the window: 0.01 points per token, so 0.6 points/hour is 60 tokens.
    service.seedRecentUsage([{ scope: { kind: "source", source: "claude" }, amount: 2800, eventId: "calibration", at: new Date(now.getTime() - 2 * 3_600_000) }]);
    const identity = { source: "claude", provider: "anthropic", account: "account-1", model: "claude-opus" } as const;
    expect(service.snapshot(sources).sources[0].calibration).toMatchObject({ estimated: true, meterId: "anthropic:weekly", percentagePointsPerMillionTokens: 10_000 });
    expect(service.admit({ identity, estimatedCost: 59, costUnit: "tokens-per-hour", now }).allowed).toBe(true);
    expect(service.admit({ identity, estimatedCost: 2, costUnit: "tokens-per-hour", now }).allowed).toBe(false);
    expect(service.admit({ identity, estimatedCost: 0.5, costUnit: "percentage-per-hour", now }).reason).toMatch(/unit/i);
    service.close();
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

  it("keeps native token completion out of percentage reservations and isolates session sources", () => {
    const { service } = setup();
    service.savePolicies([
      { ...manual(100), scope: { kind: "source", source: "claude" } },
      { ...manual(100), scope: { kind: "source", source: "codex" } },
    ], 0);
    const claude = service.admit({ identity: { source: "claude", provider: null, model: null }, sessionId: "shared-session", estimatedCost: 10, now });
    const claudeCall = service.admit({ identity: { source: "claude", provider: null, model: null }, sessionId: "shared-session", requestId: "native-call", estimatedCost: 10, now });
    const codex = service.admit({ identity: { source: "codex", provider: null, model: null }, sessionId: "shared-session", estimatedCost: 10, now });
    expect(claude.allowed && claudeCall.allowed && codex.allowed).toBe(true);
    service.reconcileSession("claude", "shared-session", 7, "claude-native-message", now, "tokens");
    const db = new DatabaseSync(service.dbPath);
    expect((db.prepare("SELECT status FROM reservations WHERE reservation_id = ?").get(claude.reservationId) as { status: string }).status).toBe("completed");
    expect((db.prepare("SELECT status FROM reservations WHERE reservation_id = ?").get(codex.reservationId) as { status: string }).status).toBe("reserved");
    expect((db.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE amount = 7").get() as { count: number }).count).toBe(1);
    service.releaseSession("claude", "shared-session");
    expect((db.prepare("SELECT status FROM reservations WHERE reservation_id = ?").get(claudeCall.reservationId) as { status: string }).status).toBe("reserved");
    service.releaseRequest("claude", "native-call");
    expect((db.prepare("SELECT status FROM reservations WHERE reservation_id = ?").get(claudeCall.reservationId) as { status: string }).status).toBe("released");
    db.close();
    service.close();

    const percentage = setup();
    percentage.service.setMeters([{
      id: "anthropic:weekly", source: "claude", provider: "anthropic", account: "account-1",
      usedPercentagePoints: 10, resetAt: new Date("2026-10-15T12:00:00.000Z"), observedAt: now, authoritative: true, window: "7d",
    }]);
    percentage.service.savePolicies([{
      scope: { kind: "source", source: "claude" }, mode: "manual", unit: "percentage-per-hour", limit: 10,
      deadline: "2099-10-11T12:00:00.000Z",
    }], 0);
    // Quota reservations are weighted tokens, so native token usage reconciles them and a percentage-point reading cannot.
    percentage.service.seedRecentUsage([{ scope: { kind: "source", source: "claude" }, amount: 1000, eventId: "calibration", at: new Date(now.getTime() - 2 * 3_600_000) }]);
    const reservation = percentage.service.admit({ identity: { source: "claude", provider: "anthropic", account: "account-1" }, estimatedCost: 100, costUnit: "tokens-per-hour", now });
    expect(reservation.allowed).toBe(true);
    percentage.service.reconcile(reservation.reservationId!, 1, "native-percentage-message", now, "percentage-per-hour", "claude");
    const percentageDb = new DatabaseSync(percentage.service.dbPath);
    expect((percentageDb.prepare("SELECT status FROM reservations WHERE reservation_id = ?").get(reservation.reservationId) as { status: string }).status).toBe("reserved");
    expect((percentageDb.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE event_id LIKE 'native-percentage-message:%'").get() as { count: number }).count).toBe(0);
    percentage.service.reconcile(reservation.reservationId!, 120, "native-token-message", now, "tokens", "claude");
    expect((percentageDb.prepare("SELECT status FROM reservations WHERE reservation_id = ?").get(reservation.reservationId) as { status: string }).status).toBe("completed");
    expect(percentageDb.prepare("SELECT unit FROM usage_events WHERE event_id LIKE 'native-token-message:%'").all()).toEqual([{ unit: "tokens-per-hour" }]);
    percentageDb.close();
    percentage.service.close();
  });

  it("never overwrites a malformed settings file on stop or unlock and keeps denying", () => {
    const { service } = setup();
    const scope = { kind: "provider", provider: "anthropic" } as const;
    const identity = { source: "claude", provider: "anthropic", model: "claude-opus" } as const;
    const preview = service.previewStop(scope, []);
    const malformed = "{ not json";
    writeFileSync(service.settingsPath, malformed);

    const operation = service.commitStop(preview.id, preview.fingerprint, []);
    expect(operation.settingsError).toMatch(/malformed|JSON/i);
    expect(readFileSync(service.settingsPath, "utf8")).toBe(malformed);
    expect(service.admit({ identity, estimatedCost: 1, now }).allowed).toBe(false);
    unlinkSync(service.settingsPath);
    expect(service.admit({ identity, estimatedCost: 1, now }).reason).toMatch(/Emergency stop/); // the SQLite row latched durably

    writeFileSync(service.settingsPath, malformed);
    expect(service.unlock(scope)).toMatch(/malformed|JSON/i);
    expect(readFileSync(service.settingsPath, "utf8")).toBe(malformed);
    expect(service.admit({ identity, estimatedCost: 1, now }).allowed).toBe(false);
    unlinkSync(service.settingsPath);
    expect(service.admit({ identity, estimatedCost: 1, now }).allowed).toBe(true);
    service.close();
  });

  it("reports blocked work only inside the current window and enforcing only when something is on", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-blocked-"));
    roots.push(root);
    let clock = now;
    const service = new BudgetService({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") }, { now: () => clock });
    const blocked = () => service.snapshot(sources).sources.find((source) => source.source === "claude")!.blockedWork;
    expect(service.enforcing()).toBe(false);
    service.savePolicies([{ scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-per-hour", limit: 10, deadline: "2026-10-20T12:00:00.000Z" }], 0);
    expect(service.enforcing()).toBe(true);
    expect(service.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 20, now: clock }).allowed).toBe(false);
    expect(blocked()).toBe(1);
    clock = new Date(now.getTime() + 2 * 3_600_000);
    expect(blocked()).toBe(0);
    service.close();
  });
});
