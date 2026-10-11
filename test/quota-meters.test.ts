import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compose } from "../src/compose";
import type { BudgetMeter } from "../src/core/budgets";
import { refreshHookMeters } from "../src/services/budget-meters";
import { BudgetService } from "../src/services/budget-service";
import { codexRateLimits, parseCodexRateLimits } from "../src/services/codex-rate-limits";
import { parseGoUsage, planWindows } from "../src/services/usage-client";

const now = new Date("2026-10-11T12:00:00.000Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-quota-meters-"));
  roots.push(dir);
  return dir;
}

const epoch = (offsetMs: number) => Math.floor((now.getTime() + offsetMs) / 1000);

// The shape `codex app-server` returns for account/rateLimits/read (credit and reset-credit details trimmed).
const response = (primary: unknown, secondary: unknown) => ({
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: "codex", limitName: null, primary, secondary, planType: "plus" },
  rateLimitsByLimitId: { codex: { limitId: "codex", primary, secondary } },
  accountId: "acct-codex",
});

describe("Codex rate-limit parser", () => {
  it("makes one meter per window, labelled by its real length", () => {
    const parsed = parseCodexRateLimits(
      response({ usedPercent: 35, windowDurationMins: 10080, resetsAt: epoch(3 * 86_400_000) }, { usedPercent: 12, windowDurationMins: 300, resetsAt: epoch(2 * 3_600_000) }),
      now, now);
    expect(parsed.account).toBe("acct-codex");
    expect(parsed.windows.map(({ id, used, window, account, authoritative }) => ({ id, used, window, account, authoritative }))).toEqual([
      { id: "openai:primary", used: 35, window: "7d", account: "acct-codex", authoritative: true },
      { id: "openai:secondary", used: 12, window: "5h", account: "acct-codex", authoritative: true },
    ]);
    expect(parsed.windows[1].start.getTime()).toBe(parsed.windows[1].resets.getTime() - 5 * 3_600_000);
    expect(parsed.windows[0].observedAt).toEqual(now);
  });

  it("skips absent, expired and unmeasurable windows", () => {
    const parsed = parseCodexRateLimits(
      response({ usedPercent: 35, windowDurationMins: null, resetsAt: epoch(3_600_000) }, { usedPercent: 12, windowDurationMins: 300, resetsAt: epoch(-1000) }),
      now, now);
    expect(parsed.windows).toEqual([]);
    expect(parseCodexRateLimits(null, now, now)).toEqual({ account: null, windows: [] });
    expect(parseCodexRateLimits({ rateLimits: { primary: null, secondary: null } }, now, now).windows).toEqual([]);
  });

  it("serves the saved reading without starting Codex when the network is off", async () => {
    const dir = root();
    const home = join(dir, ".codex");
    mkdirSync(join(dir, "cache", "token-furnace"), { recursive: true });
    const env = { HOME: dir, CODEX_HOME: home, TOKEN_FURNACE_CACHE_HOME: join(dir, "cache"), TOKEN_FURNACE_CODEX_BIN: join(dir, "no-such-codex") };
    writeFileSync(join(dir, "cache", "token-furnace", "codex-rate-limits.json"), JSON.stringify({
      home, fetched: now.getTime() / 1000 - 30, tried: 0,
      raw: { accountId: "acct-codex", rateLimits: { primary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: epoch(3 * 86_400_000) }, secondary: null } },
    }));
    const reading = await codexRateLimits(env, now, false);
    expect(reading?.windows.map((window) => window.id)).toEqual(["openai:primary"]);
    expect(reading?.windows[0]?.observedAt?.getTime()).toBe(now.getTime() - 30_000);
    // With the network on but a missing binary, the attempt fails quietly, is throttled, and the saved reading stays.
    const stale = new Date(now.getTime() + 10 * 60_000);
    expect(await codexRateLimits({ ...env }, stale, true)).toMatchObject({ account: "acct-codex" });
  });
});

describe("Claude usage windows", () => {
  it("reads the 5-hour and 7-day windows from the saved reading", async () => {
    const dir = root();
    mkdirSync(join(dir, "cache", "token-furnace"), { recursive: true });
    const env = { HOME: dir, TOKEN_FURNACE_CACHE_HOME: join(dir, "cache") };
    writeFileSync(join(dir, "cache", "token-furnace", "usage.json"), JSON.stringify({
      fetched: now.getTime() / 1000 - 60, account: "acct-claude",
      seven_day: { utilization: 28, resets_at: new Date(now.getTime() + 120 * 3_600_000).toISOString() },
      five_hour: { utilization: 41, resets_at: new Date(now.getTime() + 2 * 3_600_000).toISOString() },
    }));
    const windows = await planWindows(env, now, false);
    expect(windows.map(({ id, used, window }) => ({ id, used, window }))).toEqual([
      { id: "anthropic:7d", used: 28, window: "7d" },
      { id: "anthropic:5h", used: 41, window: "5h" },
    ]);
  });
});

describe("OpenCode Go usage body", () => {
  // Recorded from https://opencode.ai/zen/go/v1/usage on 2026-10-11 (values as returned, no identity fields exist).
  const recorded = {
    usage: {
      rolling: { status: "ok", percent: 2, resetsAt: "2026-10-11T22:50:32.000Z" },
      weekly: { status: "ok", percent: 0, resetsAt: "2026-10-12T00:00:00.000Z" },
      monthly: { status: "ok", percent: 0, resetsAt: "2026-11-11T17:46:57.000Z" },
    },
  };

  it("keeps the weekly window and the rolling and monthly ones", () => {
    expect(parseGoUsage(recorded)).toEqual({
      weekly: { utilization: 0, resets_at: "2026-10-12T00:00:00.000Z" },
      extra: {
        rolling: { utilization: 2, resets_at: "2026-10-11T22:50:32.000Z" },
        monthly: { utilization: 0, resets_at: "2026-11-11T17:46:57.000Z" },
      },
    });
  });

  it("needs the weekly window and ignores malformed ones", () => {
    expect(parseGoUsage({ usage: { rolling: recorded.usage.rolling } })).toBeNull();
    expect(parseGoUsage({ usage: { weekly: { status: "ok", percent: "3", resetsAt: "x" } } })).toBeNull();
    expect(parseGoUsage(null)).toBeNull();
    expect(parseGoUsage({ usage: { weekly: recorded.usage.weekly, monthly: { percent: -1 } } })?.extra).toEqual({});
  });
});

describe("hook meter refresh", () => {
  const meter = (observedAt: Date): BudgetMeter => ({
    id: "anthropic:7d", source: "claude", provider: "anthropic", account: "acct-1", usedPercentagePoints: 10,
    resetAt: new Date(now.getTime() + 100 * 3_600_000), observedAt, authoritative: true, window: "7d",
  });
  const open = (clock: { current: Date }) => {
    const dir = root();
    const service = new BudgetService({ HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") }, { now: () => clock.current });
    return service;
  };

  it("claims a refresh only for a stale applicable quota meter, once a minute", () => {
    const clock = { current: new Date(now) };
    const service = open(clock);
    expect(service.claimMeterRefresh("claude")).toBe(false); // no quota policy
    service.savePolicies([{ scope: { kind: "source", source: "claude" }, mode: "auto", unit: "percentage-per-hour", limit: null, deadline: null }], 0);
    service.setMeters([meter(new Date(now.getTime() - 30_000))]);
    expect(service.claimMeterRefresh("claude")).toBe(false); // fresh
    expect(service.claimMeterRefresh("codex")).toBe(false); // the policy is for Claude
    service.setMeters([meter(new Date(now.getTime() - 4.5 * 60_000))]);
    expect(service.claimMeterRefresh("claude")).toBe(true);
    expect(service.claimMeterRefresh("claude")).toBe(false); // throttled across processes
    clock.current = new Date(now.getTime() + 61_000);
    expect(service.claimMeterRefresh("claude")).toBe(true);
    service.close();
  });

  it("asks for a refresh on admission events only, and never throws", async () => {
    const dir = root();
    const app = compose({ HOME: dir }, { noCache: true });
    const claim = vi.spyOn(app.budgets, "claimMeterRefresh").mockReturnValue(false);
    try {
      await refreshHookMeters(app, JSON.stringify({ hook_event_name: "PostToolUse" }), "claude");
      await refreshHookMeters(app, JSON.stringify({ hook_event_name: "Stop" }), "claude");
      await refreshHookMeters(app, "{", "claude");
      expect(claim).not.toHaveBeenCalled();
      await refreshHookMeters(app, JSON.stringify({ hook_event_name: "PreToolUse" }), "claude");
      expect(claim).toHaveBeenCalledOnce();
    } finally {
      app.close();
    }
  });
});
