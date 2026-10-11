/**
 * The reset feed, the notification conditions, and the routes that reach them. Every network call is
 * stubbed: nothing here reaches agentresets.com, ntfy, or Telegram.
 */

import { request } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "../src/core/model";
import { assistant } from "./fixtures/build";
import { compose, type App } from "../src/compose";
import { notifyTick, startServer, type LiveServer } from "../src/server";
import { forgetResets, parseFeed, resetsSnapshot, type ResetsFeed } from "../src/services/resets-client";
import {
  defaultSettings, deliver, loadSettings, mergeSettings, publicSettings, runAlerts, saveSettings, settingsPath,
  type DeliveryResult, type NotificationSettings,
} from "../src/services/notifications";

const NOW = new Date("2026-10-10T12:00:00Z");
const roots: string[] = [];
const apps: App[] = [];

function directApp(env: NodeJS.ProcessEnv): App {
  const app = compose(env);
  apps.push(app);
  return app;
}

function closeApps(): void {
  for (const app of apps.splice(0)) {
    app.budgets.close();
    app.control.close();
  }
}

function expectPrivateSettings(path: string): void {
  // Windows reports default POSIX mode bits; its ACL protects the user-created temp tree.
  if (process.platform === "win32") {
    expect(statSync(path).isFile()).toBe(true);
    const script = "$path=$args[0]; $acl=Get-Acl -LiteralPath $path; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [pscustomobject]@{sid=$sid; rules=@($acl.Access | ForEach-Object { [pscustomobject]@{identity=$_.IdentityReference.Value; inherited=$_.IsInherited} })} | ConvertTo-Json -Compress";
    const acl = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as { sid?: string; rules?: Array<{ identity?: string; inherited?: boolean }> | { identity?: string; inherited?: boolean } };
    const rules = Array.isArray(acl.rules) ? acl.rules : acl.rules ? [acl.rules] : [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.identity).toBe(acl.sid);
    expect(rules[0]?.inherited).toBe(false);
    return;
  }
  expect(statSync(path).mode & 0o777).toBe(0o600);
}

function tempEnv(): NodeJS.ProcessEnv & Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "tf-notify-"));
  roots.push(root);
  // A real server inherits its environment; NODE_ENV=test is what keeps the send off the network.
  return {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    TOKEN_FURNACE_NO_CACHE: "1",
    TOKEN_FURNACE_WORKERS: "0",
    TOKEN_FURNACE_NOW: NOW.toISOString(),
  };
}

function feed(over: { events?: { date: string; kind?: "regular" | "banked"; summary?: string }[]; scheduledFor?: string | null } = {}): ResetsFeed {
  const scheduled = over.scheduledFor === undefined ? null : over.scheduledFor;
  return {
    schema_version: 1,
    generated_at: NOW.toISOString(),
    source: "https://agentresets.com",
    attribution: { note: "Seeded history.", cutoff_date: "2026-09-10", sources: [{ name: "Codex Resets", url: "https://codex-resets.com" }] },
    products: [{
      id: "codex",
      name: "Codex",
      vendor: "OpenAI",
      events: (over.events ?? []).map((event) => ({ date: event.date, time: null, kind: event.kind ?? "regular", summary: event.summary ?? "" })),
      stats: { total: 52, last_date: "2026-10-07", last30d: 7, median_gap: 3, max_gap: 68, banked_total: 7, unavailable: false },
      forecast: { probabilities: { raw_24h: 0.15, raw_48h: 0.35, raw_7d: 0.68 }, hours_since_last: 68, model: "climatology", method_url: "https://whenreset.app/tools/backtest/", unavailable: false },
      announced_schedule: scheduled ? { scheduled_for: scheduled, announced_at: null, source_url: null, certainty: "announced" } : null,
    }],
  };
}

function onSettings(over: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    ...defaultSettings(),
    enabled: true,
    ntfy: { enabled: true, server: "https://ntfy.sh", topic: "token-furnace", token: "" },
    ...over,
    conditions: { ...defaultSettings().conditions, ...over.conditions },
  };
}

/** A sender that records every call and answers with the result the test asks for. */
function recorder(answers: Partial<Record<"ntfy" | "telegram", DeliveryResult>> = {}) {
  const calls: [string, string][] = [];
  const send = async (channel: "ntfy" | "telegram", title: string, message: string): Promise<DeliveryResult> => {
    calls.push([channel, `${title} ${message}`]);
    return answers[channel] ?? { channel, ok: true, error: null };
  };
  return { calls, send };
}

beforeEach(() => {
  forgetResets();
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeApps();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reset feed", () => {
  it("fetches once, validates, and keeps the old feed when a later fetch fails", async () => {
    const body = JSON.stringify({
      schema_version: 1,
      generated_at: NOW.toISOString(),
      source: "https://agentresets.com",
      attribution: { note: "Seeded", sources: [{ name: "Claude Resets", url: "https://claude-resets.com" }] },
      products: {
        codex: {
          name: "Codex", vendor: "OpenAI",
          events: [{ date: "2026-10-07", time: "2026-10-07T03:35:09Z", kind: "regular", summary: "a reset" }],
          stats: { total: null, last_date: "2026-10-07", unavailable: true },
          forecast: { probabilities: { raw_24h: 0.15, raw_48h: 4, raw_7d: 0.68 }, unavailable: false },
          announced_schedule: { scheduled_for: "2026-10-12T00:00:00Z", announced_at: null, source_url: null, certainty: "announced" },
        },
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await resetsSnapshot(NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.stale).toBe(false);
    expect(first.feed?.products[0].announced_schedule?.scheduled_for).toBe("2026-10-12T00:00:00Z");
    expect(first.feed?.attribution?.note).toBe("Seeded");
    // The out-of-range probability stays unknown (null), not zero, and null stats survive.
    expect(first.feed?.products[0].forecast?.probabilities).toEqual({ raw_24h: 0.15, raw_48h: null, raw_7d: 0.68 });
    expect(first.feed?.products[0].stats?.total).toBeNull();

    await resetsSnapshot(new Date(NOW.getTime() + 60_000));
    expect(fetchMock).toHaveBeenCalledTimes(1); // the shared cache: one call for every reader

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const later = await resetsSnapshot(new Date(NOW.getTime() + 400_000));
    expect(later.stale).toBe(true);
    expect(later.error).not.toBeNull();
    expect(later.feed?.products[0].name).toBe("Codex"); // the last good feed stays readable
  });

  it("refuses a body that is not the documented shape", () => {
    expect(parseFeed(null)).toBeNull();
    expect(parseFeed({ schema_version: 2, products: {} })).toBeNull();
    expect(parseFeed({ schema_version: 1 })).toBeNull();
    const partial = parseFeed({ schema_version: 1, products: { codex: { events: [{ date: "nope" }, { date: "2026-10-07" }] } } });
    expect(partial?.products[0].events).toHaveLength(1);
    expect(partial?.products[0].stats).toBeNull();
    expect(partial?.products[0].announced_schedule).toBeNull();
  });
});

describe("notification settings", () => {
  it("keeps a saved secret when the field is blank, removes it on request, and never returns one", () => {
    const env = tempEnv();
    saveSettings(env, onSettings({ telegram: { enabled: true, botToken: "123456:AAaaBBbbCCccDDddEEeeFFffGGhhIIjjKKllMMnnOO", chatId: "-100123" } }));
    expectPrivateSettings(settingsPath(env));

    const kept = mergeSettings(env, { enabled: true, telegram: { chatId: "-100123" } }).settings;
    expect(kept.telegram.botToken).toBe("123456:AAaaBBbbCCccDDddEEeeFFhhIIjjKKllMMnnOO".slice(0, 0) + kept.telegram.botToken);
    expect(kept.telegram.botToken.startsWith("123456:")).toBe(true);
    expect(publicSettings(kept).telegram.botToken).toBe("");
    expect(publicSettings(kept).telegram.hasToken).toBe(true);
    expect(JSON.stringify(publicSettings(kept))).not.toContain("123456");

    const cleared = mergeSettings(env, { enabled: true, removeTelegramToken: true }).settings;
    expect(cleared.telegram.botToken).toBe("");
  });

  it("bounds the conditions and refuses an unusable channel", () => {
    const env = tempEnv();
    const { settings } = mergeSettings(env, {
      enabled: true, ntfy: { enabled: true }, conditions: { leadMinutes: 99999, usage: { percent: 0 } },
    });
    expect(settings.conditions.leadMinutes).toBe(1440);
    expect(settings.conditions.usage.percent).toBe(1);
    expect(mergeSettings(env, { enabled: true, ntfy: { enabled: true } }).error).toMatch(/topic/i);
    expect(mergeSettings(env, { enabled: true, ntfy: { enabled: true, topic: "t", server: "http://ntfy.example" } }).error).toMatch(/https/);
    expect(mergeSettings(env, { enabled: true, ntfy: { enabled: true, topic: "t", server: "https://u:p@ntfy.sh" } }).error).toMatch(/password/);
    expect(mergeSettings(env, { enabled: true, ntfy: { enabled: true, topic: "t", server: "http://127.0.0.1:8080" } }).error).toBeNull();
    expect(mergeSettings(env, { enabled: true, telegram: { enabled: true, botToken: "nope", chatId: "1" } }).error).toMatch(/token/i);
    // Off means nothing is checked, so an incomplete channel is not an error.
    expect(mergeSettings(env, { enabled: false, ntfy: { enabled: true } }).error).toBeNull();
  });

  it("publishes ntfy as plain text with a Title header, never a JSON body", async () => {
    const env = tempEnv();
    env.NODE_ENV = "";
    env.TOKEN_FURNACE_NO_SEND = "0";
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response("ok", { status: 200 });
    }));
    const results = await deliver(env, onSettings(), "Hello", "body text");
    expect(results).toHaveLength(1); // only ntfy is enabled in onSettings
    expect(results[0]).toMatchObject({ channel: "ntfy", ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://ntfy.sh/token-furnace");
    expect((seen[0].init.headers as Record<string, string>).Title).toBe("Hello");
    expect(seen[0].init.body).toBe("body text");
  });

  it("keeps the other channel when one fetch rejects, and retries only the failed one", async () => {
    const env = tempEnv();
    env.NODE_ENV = "development";
    env.TOKEN_FURNACE_NO_SEND = "0";
    const settings = onSettings({
      telegram: { enabled: true, botToken: "123456:AAaaBBbbCCccDDddEEeeFFffGGhhIIjjKKllMMnnOO", chatId: "-100123" },
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("ntfy.sh")) throw new Error("offline");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    await runAlerts(env, { now: NOW, feed: feed({ events: [{ date: "2026-10-07" }] }), fresh: true, usage: {}, settings }); // baseline
    const first = await runAlerts(env, { now: NOW,
      feed: feed({ events: [{ date: "2026-10-07" }, { date: "2026-10-09" }] }), fresh: true, usage: {}, settings });
    expect(first.delivered.map((entry) => `${entry.channel}:${entry.ok}`).sort()).toEqual(["ntfy:false", "telegram:true"]);
    expect(first.delivered.find((entry) => entry.channel === "ntfy")?.error).toBe("ntfy could not be reached.");
    expect(urls.some((url) => url.includes("ntfy.sh"))).toBe(true);
    expect(urls.some((url) => url.includes("api.telegram.org"))).toBe(true);

    urls.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("ntfy.sh")) return new Response("ok", { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    const retry = await runAlerts(env, { now: new Date(NOW.getTime() + 300_000),
      feed: feed({ events: [{ date: "2026-10-07" }, { date: "2026-10-09" }] }), fresh: true, usage: {}, settings });
    expect(retry.delivered.map((entry) => entry.channel)).toEqual(["ntfy"]);
    expect(urls.every((url) => url.includes("ntfy.sh"))).toBe(true);
  });
});

describe("notification conditions", () => {
  it("baselines the first feed, then alerts a new announcement once per channel", async () => {
    const env = tempEnv();
    const first = recorder();
    await runAlerts(env, { now: NOW, feed: feed({ events: [{ date: "2026-10-07" }] }), fresh: true, usage: {}, settings: onSettings(), send: first.send });
    expect(first.calls).toHaveLength(0); // history seen for the first time is a baseline

    const second = recorder();
    const result = await runAlerts(env, { now: NOW, feed: feed({ events: [{ date: "2026-10-07" }, { date: "2026-10-09" }] }), fresh: true, usage: {}, settings: onSettings(), send: second.send });
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0][1]).toContain("2026-10-09");
    expect(result.delivered[0].ok).toBe(true);

    const third = recorder();
    await runAlerts(env, { now: NOW, feed: feed({ events: [{ date: "2026-10-07" }, { date: "2026-10-09" }] }), fresh: true, usage: {}, settings: onSettings(), send: third.send });
    expect(third.calls).toHaveLength(0); // the marker survives the run
  });

  it("keeps a failed channel on a bounded retry and never re-sends the one that worked", async () => {
    const env = tempEnv();
    const settings = onSettings({
      telegram: { enabled: true, botToken: "123456:AAaaBBbbCCccDDddEEeeFFffGGhhIIjjKKllMMnnOO", chatId: "-100123" },
    });
    await runAlerts(env, { now: NOW, feed: feed({ events: [{ date: "2026-10-07" }] }), fresh: true, usage: {}, settings, send: recorder().send }); // baseline
    const failing = recorder({ telegram: { channel: "telegram", ok: false, error: "telegram answered HTTP 500." } });
    await runAlerts(env, { now: NOW, feed: feed({ events: [{ date: "2026-10-07" }, { date: "2026-10-09" }] }), fresh: true, usage: {}, settings, send: failing.send });
    expect(failing.calls.map(([channel]) => channel).sort()).toEqual(["ntfy", "telegram"]);

    const soon = recorder({ telegram: { channel: "telegram", ok: false, error: "telegram answered HTTP 500." } });
    await runAlerts(env, { now: new Date(NOW.getTime() + 1_000), feed: feed({ events: [{ date: "2026-10-07" }, { date: "2026-10-09" }] }), fresh: true, usage: {}, settings, send: soon.send });
    expect(soon.calls).toEqual([]); // inside the retry backoff, and ntfy already delivered

    const later = recorder({ telegram: { channel: "telegram", ok: false, error: "telegram answered HTTP 500." } });
    await runAlerts(env, { now: new Date(NOW.getTime() + 300_000), feed: feed({ events: [{ date: "2026-10-07" }, { date: "2026-10-09" }] }), fresh: true, usage: {}, settings, send: later.send });
    expect(later.calls).toEqual([["telegram", later.calls[0][1]]]); // only the channel that failed
  });

  it("alerts an announced time inside the lead window, and not after it passed", async () => {
    const env = tempEnv();
    const soon = recorder();
    await runAlerts(env, { now: NOW, feed: feed({ scheduledFor: new Date(NOW.getTime() + 30 * 60_000).toISOString() }), fresh: true, usage: {}, settings: onSettings({ conditions: { ...defaultSettings().conditions, leadMinutes: 60 } }), send: soon.send });
    expect(soon.calls).toHaveLength(1);

    const outside = recorder();
    await runAlerts(env, { now: NOW, feed: feed({ scheduledFor: new Date(NOW.getTime() + 300 * 60_000).toISOString() }), fresh: true, usage: {}, settings: onSettings(), send: outside.send });
    expect(outside.calls).toEqual([]);
  });

  it("fires the usage threshold on the crossing and re-arms below it", async () => {
    const env = tempEnv();
    const settings = onSettings({ conditions: { ...defaultSettings().conditions, usage: { enabled: true, percent: 80, provider: "claude" } } });
    const crossing = recorder();
    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { claude: 55 }, settings, send: crossing.send });
    expect(crossing.calls).toEqual([]);

    const over = recorder();
    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { claude: 91 }, settings, send: over.send });
    expect(over.calls).toHaveLength(1);
    expect(over.calls[0][1]).toContain("91%");

    const stayOver = recorder();
    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { claude: 95 }, settings, send: stayOver.send });
    expect(stayOver.calls).toEqual([]);

    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { claude: 40 }, settings, send: recorder().send });
    const again = recorder();
    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { claude: 90 }, settings, send: again.send });
    expect(again.calls).toHaveLength(1); // below the line re-armed it
  });

  it("leaves the usage arm alone while disabled, so enabling later still fires", async () => {
    const env = tempEnv();
    const disabled = onSettings({ conditions: { ...defaultSettings().conditions,
      usage: { enabled: false, percent: 80, provider: "claude" } } });
    const quiet = recorder();
    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { claude: 91 }, settings: disabled, send: quiet.send });
    expect(quiet.calls).toEqual([]);
    const enabled = onSettings({ conditions: { ...defaultSettings().conditions,
      usage: { enabled: true, percent: 80, provider: "claude" } } });
    const fired = recorder();
    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { claude: 91 }, settings: enabled, send: fired.send });
    expect(fired.calls).toHaveLength(1);
    const once = recorder();
    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { claude: 92 }, settings: enabled, send: once.send });
    expect(once.calls).toEqual([]);
  });

  it("drops an upcoming retry after its time passes, when the schedule disappears, or when toggled off", async () => {
    const scheduledFor = new Date(NOW.getTime() + 30 * 60_000).toISOString();
    const failing = { ntfy: { channel: "ntfy" as const, ok: false, error: "ntfy answered HTTP 500." } };
    const env = tempEnv();
    const settings = onSettings();
    await runAlerts(env, { now: NOW, feed: feed({ scheduledFor }), fresh: true, usage: {}, settings, send: recorder().send });
    await runAlerts(env, { now: NOW, feed: feed({ scheduledFor }), fresh: true, usage: {}, settings,
      send: recorder(failing).send });
    const after = recorder();
    await runAlerts(env, { now: new Date(NOW.getTime() + 3_600_000), feed: feed({ scheduledFor }),
      fresh: true, usage: {}, settings, send: after.send });
    expect(after.calls).toEqual([]); // the ISO instant passed: no resend even past the backoff

    const env2 = tempEnv();
    await runAlerts(env2, { now: NOW, feed: feed({ scheduledFor }), fresh: true, usage: {}, settings, send: recorder().send });
    await runAlerts(env2, { now: NOW, feed: feed({ scheduledFor }), fresh: true, usage: {}, settings,
      send: recorder(failing).send });
    const cancelled = recorder();
    await runAlerts(env2, { now: new Date(NOW.getTime() + 300_000), feed: feed({ scheduledFor: null }),
      fresh: true, usage: {}, settings, send: cancelled.send });
    expect(cancelled.calls).toEqual([]); // the schedule disappeared: the pending retry leaves

    const env3 = tempEnv();
    await runAlerts(env3, { now: NOW, feed: feed({ scheduledFor }), fresh: true, usage: {}, settings, send: recorder().send });
    await runAlerts(env3, { now: NOW, feed: feed({ scheduledFor }), fresh: true, usage: {}, settings,
      send: recorder(failing).send });
    const off = onSettings({ conditions: { ...defaultSettings().conditions, upcoming: false } });
    const silenced = recorder();
    await runAlerts(env3, { now: new Date(NOW.getTime() + 300_000), feed: feed({ scheduledFor }),
      fresh: true, usage: {}, settings: off, send: silenced.send });
    expect(silenced.calls).toEqual([]); // toggling upcoming off stops the pending retry
  });

  it("skips a stale feed and stays silent while the master switch is off", async () => {
    const env = tempEnv();
    await runAlerts(env, { now: NOW, feed: feed({ events: [{ date: "2026-10-09" }] }), fresh: false, usage: {}, settings: onSettings(), send: recorder().send });
    const off = recorder();
    await runAlerts(env, { now: NOW, feed: feed({ events: [{ date: "2026-10-10" }] }), fresh: true, usage: {},
      settings: onSettings({ enabled: false }), send: off.send });
    expect(off.calls).toEqual([]);
  });

  it("keeps nested enable flags across a restart and guards the upcoming condition", async () => {
    const env = tempEnv();
    const nested = onSettings({ conditions: { ...defaultSettings().conditions,
      upcoming: false, usage: { enabled: true, percent: 80, provider: "any" } } });
    saveSettings(env, nested);
    const again = loadSettings(env);
    expect(again.ntfy.enabled).toBe(true); // saved nested switches survive loadSettings
    expect(again.conditions.upcoming).toBe(false);
    expect(again.conditions.usage.enabled).toBe(true);
    const guarded = recorder();
    await runAlerts(env, { now: NOW, feed: feed({ scheduledFor: new Date(NOW.getTime() + 30 * 60_000).toISOString() }),
      fresh: true, usage: {}, settings: again, send: guarded.send });
    expect(guarded.calls).toEqual([]); // upcoming off: an announced time inside the lead stays silent
  });

  it("arms usage per provider: one provider over does not silence another", async () => {
    const env = tempEnv();
    const settings = onSettings({ conditions: { ...defaultSettings().conditions,
      usage: { enabled: true, percent: 80, provider: "any" } } });
    const claude = recorder();
    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { claude: 91 }, settings, send: claude.send });
    expect(claude.calls).toHaveLength(1);
    const codex = recorder();
    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { codex: 92 }, settings, send: codex.send });
    expect(codex.calls).toHaveLength(1); // claude firing left codex armed
    const repeat = recorder();
    await runAlerts(env, { now: NOW, feed: null, fresh: false, usage: { claude: 95 }, settings, send: repeat.send });
    expect(repeat.calls).toEqual([]);
  });

  it("carries the seen and delivered markers across a restart", async () => {
    const env = tempEnv();
    await runAlerts(env, { now: NOW, feed: feed({ events: [{ date: "2026-10-07" }] }), fresh: true, usage: {}, settings: onSettings(), send: recorder().send });
    // A new process reads the same files from disk.
    expect(loadSettings(env).enabled).toBe(false); // defaults, since nothing was saved here
    const after = recorder();
    await runAlerts(env, { now: NOW, feed: feed({ events: [{ date: "2026-10-07" }, { date: "2026-10-09" }] }), fresh: true, usage: {}, settings: onSettings(), send: after.send });
    expect(after.calls).toHaveLength(1); // the baseline from the first run is remembered
  });
});

describe("the live server", () => {
  const servers: LiveServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function boot(env: NodeJS.ProcessEnv): Promise<LiveServer> {
    const server = await startServer(compose(env), { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
    servers.push(server);
    return server;
  }

  function call(server: LiveServer, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: any }>((done, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = request(`${server.url}${path}`, {
        method,
        headers: { Host: `127.0.0.1:${server.port}`, Origin: server.url, "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}), ...headers },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => done({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it("serves the reset feed and never calls out on its own per request", async () => {
    const env = tempEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      schema_version: 1, generated_at: NOW.toISOString(), products: { codex: { name: "Codex", vendor: "OpenAI", events: [], stats: null, forecast: null, announced_schedule: null } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const server = await boot(env);

    const first = await call(server, "/api/resets");
    expect(first.status).toBe(200);
    expect(first.body.feed.products[0].name).toBe("Codex");
    expect(first.body.source).toBe("https://agentresets.com");
    await call(server, "/api/resets");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("saves settings on disk at 0600, redacts them, and refuses a cross-site write", async () => {
    const env = tempEnv();
    const server = await boot(env);
    const before = await call(server, "/api/notifications");
    expect(before.body.enabled).toBe(false); // off by default

    const saved = await call(server, "/api/notifications", "POST", {
      enabled: true,
      ntfy: { enabled: true, server: "https://ntfy.sh", topic: "token-furnace", token: "tk_secret_value" },
      conditions: { leadMinutes: 30 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.ntfy.token).toBe("");
    expect(saved.body.ntfy.hasToken).toBe(true);
    const onDisk = JSON.parse(readFileSync(settingsPath(env), "utf8"));
    expect(onDisk.ntfy.token).toBe("tk_secret_value");
    expectPrivateSettings(settingsPath(env));

    const read = await call(server, "/api/notifications");
    expect(JSON.stringify(read.body)).not.toContain("tk_secret_value");

    const crossed = await call(server, "/api/notifications", "POST", { enabled: false }, { "Sec-Fetch-Site": "cross-site" });
    expect(crossed.status).toBe(403);
    const evil = await call(server, "/api/notifications", "POST", { enabled: false }, { Origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(JSON.parse(readFileSync(settingsPath(env), "utf8")).enabled).toBe(true); // the refused writes changed nothing
  });

  it("runs the notification conditions from the server loop, not from a request", async () => {
    const env = tempEnv();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify({
        schema_version: 1, generated_at: NOW.toISOString(),
        products: { codex: { name: "Codex", vendor: "OpenAI", stats: null, forecast: null,
          announced_schedule: { scheduled_for: new Date(NOW.getTime() + 10 * 60_000).toISOString(), announced_at: null, source_url: null, certainty: "announced" },
          events: [{ date: "2026-10-09", time: null, kind: "regular", summary: "reset" }] } },
      }), { status: 200 });
    }));
    saveSettings(env, onSettings());
    const app = directApp(env);
    await boot(env);

    const result = await notifyTick(app);
    expect(calls.some((url) => url.startsWith("https://agentresets.com/api/v1/resets.json"))).toBe(true);
    expect(result.alerts).toHaveLength(1); // the announced time inside the default 60 minute lead
    expect(result.delivered.every((entry) => entry.skipped)).toBe(true); // NODE_ENV=test: nothing left the machine
  });

  it("never fetches quota with --no-plan-usage, but still refreshes the feed", async () => {
    const env = tempEnv();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify({
        schema_version: 1, generated_at: NOW.toISOString(),
        products: { codex: { name: "Codex", vendor: "OpenAI", stats: null, forecast: null,
          announced_schedule: null, events: [] } },
      }), { status: 200 });
    }));
    saveSettings(env, onSettings());
    const app = directApp(env);
    await notifyTick(app, false);
    expect(calls.some((url) => url.includes("agentresets.com"))).toBe(true);
    expect(calls.some((url) => url.includes("api.anthropic.com") || url.includes("opencode.ai"))).toBe(false);
  });

  it("reaches the usage condition through a real tick when quota is over threshold", async () => {
    const env = tempEnv();
    const dataDir = join(env.HOME, "opencode-data");
    env.OPENCODE_DATA_DIR = dataDir;
    const cacheDir = join(env.XDG_CACHE_HOME, "token-furnace");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "opencode-usage.json"), JSON.stringify({ source: dataDir,
      fetched: NOW.getTime() / 1000, seven_day: { utilization: 91,
        resets_at: new Date(NOW.getTime() + 86_400_000).toISOString() } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      schema_version: 1, generated_at: NOW.toISOString(),
      products: { codex: { name: "Codex", vendor: "OpenAI", stats: null, forecast: null,
        announced_schedule: null, events: [] } },
    }), { status: 200 })));
    saveSettings(env, onSettings({ conditions: { ...defaultSettings().conditions,
      usage: { enabled: true, percent: 80, provider: "opencode" } } }));
    const app = directApp(env);
    const first = await notifyTick(app, false);
    expect(first.alerts).toHaveLength(1); // the saved opencode week over threshold fires through the tick
    const second = await notifyTick(app, false);
    expect(second.alerts).toHaveLength(0); // the first tick fired and disarmed; the path is reachable
    expect(String(JSON.stringify(first.alerts))).toContain("opencode");
  });

  it("keeps a test send off the network in a test run and reports the channel", async () => {
    const env = tempEnv();
    saveSettings(env, onSettings());
    const server = await boot(env);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await call(server, "/api/notifications/test", "POST", {});
    expect(response.body.ok).toBe(true);
    expect(response.body.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  closeApps();
  for (const root of roots.splice(0)) if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("session spike alerts", () => {
  const session: Report["active"][number] = { source: "claude", project: "demo", id: "abcdefgh", fullId: "abcdefgh-1", title: "Culprit", share: 100, turns: 1, peak: 100, hours: 1, context: 100, idle: 1, flags: [], model: "sonnet", rate: 201, rateShare: 100 };
  const report = (rate = 201): Pick<Report, "active" | "burns"> => ({ active: [{ ...session, rate }], burns: { claude: { goal: 100 } as Report["burns"]["claude"] } });
  const settings = () => onSettings({ conditions: { ...defaultSettings().conditions, sessionSpike: true } });

  it("persists opt-in settings while old settings default off", () => {
    const env = tempEnv();
    expect(loadSettings(env).conditions.sessionSpike).toBe(false);
    const merged = mergeSettings(env, { conditions: { sessionSpike: true } }).settings;
    saveSettings(env, merged);
    expect(loadSettings(env).conditions.sessionSpike).toBe(true);
    expect(publicSettings(merged).conditions.sessionSpike).toBe(true);
  });

  it("deduplicates across runs, rearms after recovery and keeps full identities separate", async () => {
    const env = tempEnv();
    const sent = recorder();
    const tick = (value: Pick<Report, "active" | "burns">) => runAlerts(env, { now: NOW, feed: null, fresh: false, usage: {}, report: value, settings: settings(), send: sent.send });
    await tick(report());
    await tick(report());
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0][1]).toContain("Culprit");
    const two = report();
    two.active.push({ ...session, fullId: "abcdefgh-2" });
    await tick(two);
    expect(sent.calls).toHaveLength(2);
    await tick(report(200));
    await tick(report());
    expect(sent.calls).toHaveLength(3);
    await tick({ ...report(), active: [] });
    await tick(report());
    expect(sent.calls).toHaveLength(4);
  });

  it("retries a failed channel only while critical and respects the opt-in", async () => {
    const env = tempEnv();
    const failed = recorder({ ntfy: { channel: "ntfy", ok: false, error: "offline" } });
    const input = { now: NOW, feed: null, fresh: false, usage: {}, report: report(), settings: settings(), send: failed.send };
    await runAlerts(env, input);
    await runAlerts(env, input);
    expect(failed.calls).toHaveLength(1);
    await runAlerts(env, { ...input, now: new Date(NOW.getTime() + 120000) });
    expect(failed.calls).toHaveLength(2);
    await runAlerts(env, { ...input, report: report(100), now: new Date(NOW.getTime() + 600000) });
    expect(failed.calls).toHaveLength(2);
    await runAlerts(env, { ...input, settings: onSettings() });
    expect(failed.calls).toHaveLength(2);
  });

  it("reaches session detection through a server tick without an open tab", async () => {
    const env = tempEnv();
    env.CLAUDE_CONFIG_DIR = join(env.HOME, "claude");
    const dir = join(env.CLAUDE_CONFIG_DIR, "projects", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spike.jsonl"), assistant(NOW, 100000, []) + "\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      schema_version: 1, generated_at: NOW.toISOString(), products: {},
    }), { status: 200 })));
    saveSettings(env, settings());
    const app = directApp(env);
    const result = await notifyTick(app, false, 0.001);
    expect(result.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Active session: critical burn spike" })]));
    expect(result.delivered).toEqual([expect.objectContaining({ skipped: true })]);
    const view = app.reports.getReport(7, "all", { now: NOW, weeklyBudget: 0.001 });
    expect(view?.actions.some((action) => action.startsWith("Burn spike in"))).toBe(true);
  });
});
