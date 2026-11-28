/**
 * Personal banked resets: Claude's `cedar_ember` from the saved usage reading, and Codex's own
 * `account/rateLimits/read`. Every test keeps the network and the subprocess out unless the case
 * under test is exactly that call.
 */

import { createHash } from "node:crypto";
import { lstatSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLOCK = 1_800_000_000_000;
const HOUR = 3_600_000;

let roots: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A home with a Claude login, a Codex home, and a cache that is ours alone. */
function machine(): { claude: string; codex: string; cache: string; env: NodeJS.ProcessEnv } {
  const root = tempRoot("tf-banked-");
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  const cache = join(root, "cache");
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  mkdirSync(join(cache, "token-furnace", "banked"), { recursive: true });
  return {
    claude,
    codex,
    cache,
    env: {
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: codex,
      XDG_CACHE_HOME: cache,
      PATH: process.env.PATH,
    },
  };
}

function credentials(claude: string): void {
  writeFileSync(join(claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "unit-token" } }));
}

/** The credit file this home's reading lives in, as the client names it: one file per home. */
function bankedFile(cache: string, source: string, home: string): string {
  let one = home;
  try {
    one = realpathSync(home); // the same identity the client uses: symlinks followed
  } catch {
    one = resolve(home);
  }
  const key = createHash("sha256").update(one).digest("hex").slice(0, 16);
  return join(cache, "token-furnace", "banked", `${source}-${key}.json`);
}

/** Claude's credit file for this machine. */
function claudeFile(env: NodeJS.ProcessEnv, cache: string): string {
  return bankedFile(cache, "claude", String(env.CLAUDE_CONFIG_DIR));
}

/** Codex's credit file for this machine. */
function codexFile(env: NodeJS.ProcessEnv, cache: string): string {
  return bankedFile(cache, "codex", String(env.CODEX_HOME));
}

/** A saved reading from a previous call: the week in `usage.json`, the credits in their own file. */
function usageCache(env: NodeJS.ProcessEnv, cache: string, cedar?: unknown, fetched = CLOCK / 1000): void {
  mkdirSync(join(cache, "token-furnace"), { recursive: true });
  writeFileSync(join(cache, "token-furnace", "usage.json"), JSON.stringify({
    fetched,
    seven_day: { utilization: 42, resets_at: CLOCK / 1000 + 3 * 86_400 },
  }));
  if (cedar === undefined) return;
  mkdirSync(join(cache, "token-furnace", "banked"), { recursive: true });
  writeFileSync(claudeFile(env, cache), JSON.stringify({ source: "claude-usage", fetched, block: cedar }));
}

/** Claude's saved credits as the client keeps them, for assertions. */
function savedClaude(env: NodeJS.ProcessEnv, cache: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(claudeFile(env, cache), "utf8"));
  } catch {
    return {};
  }
}

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "full-reset-1",
    label: "One full limit reset",
    resets_total: 1,
    resets_left: 1,
    starts_at: new Date(CLOCK - 5 * 86_400_000).toISOString(),
    ends_at: new Date(CLOCK + 3 * 86_400_000).toISOString(),
    clears: ["seven_day"],
    type: "weekly",
    usable_now: true,
    paused: false,
    gives_back_weekly: false,
    unavailable_reason: null,
    ...overrides,
  };
}

function credits(list: unknown[] | null, availableCount = 2): unknown {
  return { availableCount, credits: list };
}

function credit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "RateLimitResetCredit_1",
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: (CLOCK - 86_400_000) / 1000,
    expiresAt: (CLOCK + 2 * 86_400_000) / 1000,
    title: "Full reset",
    description: "You've been granted one free rate limit reset.",
    ...overrides,
  };
}

/** The cache file as the client writes it: one line per Codex home. */
/** A credit file's content. */
function cacheFile(line: Record<string, unknown>): string {
  return JSON.stringify(line);
}

/** A `codex` on PATH: a node script that answers the handshake with `credits`. */
function fakeCodex(dir: string, body: string): string {
  const path = join(dir, "codex");
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return path;
}

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify({
      seven_day: { utilization: 42, resets_at: new Date(CLOCK + 3 * 86_400_000).toISOString() },
      cedar_ember: { eligible: true, ineligible_reason: null, grants: [grant()] },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

describe("Claude banked resets", () => {
  it("reads the credits saved beside the week, with no request", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, ineligible_reason: null, grants: [grant(), grant({ id: "full-reset-2", ends_at: new Date(CLOCK + 9 * 86_400_000).toISOString() })] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(resets.state).toBe("ok");
    expect(resets.availableCount).toBe(2);
    expect(resets.nextExpiresAt).toBe(new Date(CLOCK + 3 * 86_400_000).toISOString());
    expect(resets.grants.map((g) => g.next)).toEqual([true, undefined]); // soonest expiry first
    expect(resets.grants[0]).toMatchObject({ title: "One full limit reset", scope: "Weekly limits", remaining: 1, total: 1 });
  });

  it("marks a grant past its expiry, so an old reading shows nothing to spend", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [grant({ ends_at: new Date(CLOCK - 1000).toISOString() })] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.grants[0].status).toBe("expired");
    expect(resets.availableCount).toBe(0);
    expect(resets.nextExpiresAt).toBeNull();
  });

  it("says why an account has none, without touching the week", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: false, ineligible_reason: "surface", grants: [] });
    const { claudeBankedResets, planWeek } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("unavailable");
    expect(resets.note).toBe("surface");
    expect(((await planWeek(env, new Date(CLOCK), false))!.used)).toBe(42);
  });

  it("keeps the week when cedar_ember is missing or malformed", async () => {
    const { cache, env } = machine();
    usageCache(env, cache); // a cache file from before the credits existed
    const { claudeBankedResets, planWeek } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("unavailable");
    expect(resets.grants).toEqual([]);
    expect((await planWeek(env, new Date(CLOCK), false))!.used).toBe(42);
  });

  it("survives a grants array of nonsense, and calls it unreadable rather than empty", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [null, 7, { id: "" }, { id: "x", resets_left: "many" }] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.grants).toEqual([]);
    expect(resets.state).toBe("unavailable"); // no row carries a balance, so this is not "zero left"
    expect(resets.note).toBe("The reset credits could not be read.");
  });

  it("calls a list with one unreadable grant unreadable, even beside a good one", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [grant({ resets_left: 0, paused: true }), { id: "g2", label: "no count" }] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("unavailable"); // the row it cannot read may hold the whole balance
    expect(resets.note).toBe("The reset credits could not be read.");
  });

  it("preserves the last balance when Anthropic refuses the CLI version", async () => {
    const { claude, cache, env } = machine();
    credentials(claude);
    const previous = CLOCK / 1000 - 3600;
    usageCache(env, cache, { eligible: true, grants: [grant()] }, previous);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      seven_day: { utilization: 55, resets_at: CLOCK / 1000 + 86_400 },
      cedar_ember: { eligible: false, ineligible_reason: "cli_version", grants: [] },
    }), { status: 200 }));
    const { claudeBankedResets, planWeek } = await import("../src/services/usage-client");

    expect(await claudeBankedResets(env, new Date(CLOCK), true)).toMatchObject({
      state: "ok", availableCount: 1, stale: true, fetchedAt: new Date(previous * 1000).toISOString(),
    });
    expect((await planWeek(env, new Date(CLOCK), false))?.used).toBe(55);
    expect(savedClaude(env, cache).fetched).toBe(previous);
  });

  it("clears the saved credits when a good answer carries none", async () => {
    const { claude, cache, env } = machine();
    credentials(claude);
    usageCache(env, cache, { eligible: true, grants: [grant()] }, CLOCK / 1000 - 3600); // a good, aged-out reading
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ seven_day: null, cedar_ember: null }), { status: 200 }));
    const { claudeBankedResets } = await import("../src/services/usage-client");

    expect((await claudeBankedResets(env, new Date(CLOCK), true)).state).toBe("unavailable");

    expect(savedClaude(env, cache).block).toBeNull(); // the next process must not resurrect it
    vi.resetModules();
    const next = await import("../src/services/usage-client");
    expect((await next.claudeBankedResets(env, new Date(CLOCK + 60_000), false)).state).toBe("unavailable");
  });

  it("keeps the week it already has when an answer carries only the credits", async () => {
    const { claude, cache, env } = machine();
    credentials(claude);
    usageCache(env, cache, undefined, CLOCK / 1000 - 3600); // a week on disk, no credits
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ seven_day: null, cedar_ember: { eligible: true, grants: [grant()] } }), { status: 200 }));
    const { claudeBankedResets, planWeek } = await import("../src/services/usage-client");

    // --no-cache: nothing is written, so the in-memory answer is all this process has.
    const offline = { ...env, TOKEN_FURNACE_NO_CACHE: "1" };
    await claudeBankedResets(offline, new Date(CLOCK), true);

    expect((await planWeek(offline, new Date(CLOCK), false))!.used).toBe(42); // the week the answer omitted
  });

  it("calls a grant whose end date is not a date unreadable", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [grant({ ends_at: "not-a-date" })] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("unavailable"); // not a credit the page can advertise as never expiring
    expect(resets.note).toBe("The reset credits could not be read.");
  });

  it("does not trust an eligibility field that is not Claude's own boolean", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: "false", grants: [grant()] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("unavailable"); // a string "false" would otherwise read as eligible
    expect(resets.note).toBe("The reset credits could not be read.");
  });

  it("calls a grant whose usable_now is not Claude's own boolean unreadable", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [grant({ usable_now: "true" })] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("unavailable"); // a zero here would hide a real balance
    expect(resets.note).toBe("The reset credits could not be read.");
  });

  it("keeps a grant that is spent or paused, with no balance to count", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [grant({ resets_left: 0 }), grant({ id: "g2", paused: true })] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("ok");
    expect(resets.grants.map((g) => g.status)).toEqual(["unusable", "paused"]);
    expect(resets.availableCount).toBe(0);
  });

  it("reports no credits when a fresh call stops carrying the field", async () => {
    const { claude, cache, env } = machine();
    credentials(claude);
    usageCache(env, cache, { eligible: true, grants: [grant()] }, CLOCK / 1000 - 3600); // a good reading, aged out
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      seven_day: { utilization: 42, resets_at: new Date(CLOCK + 3 * 86_400_000).toISOString() },
    }), { status: 200 }));
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), true);

    // A field that is gone is a reading of "none", not an old balance wearing a fresh timestamp.
    expect(resets.state).toBe("unavailable");
    expect(resets.grants).toEqual([]);
    expect(resets.availableCount).toBe(0);
    expect(savedClaude(env, cache).block).toBeNull(); // and the cache agrees with the answer
  });

  it("calls a negative credit count unreadable", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [grant({ resets_left: -1 })] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("unavailable"); // not "ok" with nothing to spend
    expect(resets.note).toBe("The reset credits could not be read.");
  });

  it("says a saved reading is stale once it is older than the reuse window", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [grant()] }, CLOCK / 1000 - 3600);
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("ok");
    expect(resets.stale).toBe(true);
    expect(resets.fetchedAt).toBe(new Date(CLOCK - HOUR).toISOString());
  });

  it("calls a list of unreadable grants unavailable, not an account with nothing left", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [{}, null, 7] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("unavailable");
    expect(resets.note).toBe("The reset credits could not be read.");
  });

  it("survives a cache file whose timestamp is not an instant", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [grant()] }, 1e20);
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("ok");
    expect(resets.fetchedAt).toBeNull();
  });

  it("survives a clears list of poisoned keys", async () => {
    const { cache, env } = machine();
    usageCache(env, cache, { eligible: true, grants: [grant({ clears: [{ toString: null }, "constructor", "seven_day"] })] });
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("ok"); // an object key cannot throw, and a Map cannot leak a prototype
    expect(resets.grants[0].scope).toBe("constructor + Weekly limits"); // an unknown key keeps its own name
  });

  it("one call refreshes the week and the credits together and saves both", async () => {
    const { claude, cache, env } = machine();
    credentials(claude);
    usageCache(env, cache, undefined, CLOCK / 1000 - 3600); // aged out, so the call goes out
    const { claudeBankedResets, planWeek } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), true);
    const week = await planWeek(env, new Date(CLOCK), true);

    expect(fetchMock).toHaveBeenCalledTimes(1); // the credits reuse the one request
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
    expect(resets.state).toBe("ok");
    expect(week!.used).toBe(42);
    const saved = JSON.parse(readFileSync(join(cache, "token-furnace", "usage.json"), "utf8"));
    expect(saved.seven_day.utilization).toBe(42);
    expect(saved.cedar_ember).toBeUndefined(); // the credits never enter the week's file
    expect(savedClaude(env, cache).block.grants).toHaveLength(1);
  });

  it("reads a cache file whose timestamp is not a number as never fetched", async () => {
    const { cache, claude, env } = machine();
    credentials(claude);
    mkdirSync(join(cache, "token-furnace"), { recursive: true });
    writeFileSync(join(cache, "token-furnace", "usage.json"), JSON.stringify({
      fetched: { toString: null },
      seven_day: { utilization: 42, resets_at: CLOCK / 1000 + 3 * 86_400 },
    }));
    writeFileSync(claudeFile(env, cache), JSON.stringify({ fetched: { toString: null }, block: { eligible: true, grants: [grant()] } }));
    const { claudeBankedResets, planWeek } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), false);

    expect(resets.state).toBe("ok");
    expect(resets.fetchedAt).toBeNull();
    expect(resets.stale).toBe(true); // nothing says when this was read
    expect((await planWeek(env, new Date(CLOCK), false))!.used).toBe(42);
  });

  it("saves the credits even when the call carried no weekly reading", async () => {
    const { claude, cache, env } = machine();
    credentials(claude);
    usageCache(env, cache, undefined, 0); // a week already saved, no credits
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      seven_day: null,
      cedar_ember: { eligible: true, grants: [grant()] },
    }), { status: 200 }));
    const { claudeBankedResets, planWeek } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), true);

    expect(resets.availableCount).toBe(1);
    const saved = JSON.parse(readFileSync(join(cache, "token-furnace", "usage.json"), "utf8"));
    expect(savedClaude(env, cache).block.grants).toHaveLength(1);
    expect(saved.seven_day.utilization).toBe(42); // the week the answer omitted is still there
    // And a later --no-plan-usage run reads both halves off the disk.
    vi.resetModules();
    const offline = await import("../src/services/usage-client");
    expect((await offline.claudeBankedResets(env, new Date(CLOCK + 60_000), false)).availableCount).toBe(1);
    expect((await offline.planWeek(env, new Date(CLOCK + 60_000), false))!.used).toBe(42);
  });

  it("does not let a credit-only answer make an expired week look fresh", async () => {
    const { claude, cache, env } = machine();
    credentials(claude);
    // The saved week ended an hour ago; the credits read beside it are still good.
    usageCache(env, cache, { eligible: true, grants: [grant()] }, CLOCK / 1000 - 3600);
    writeFileSync(join(cache, "token-furnace", "usage.json"), JSON.stringify({
      fetched: CLOCK / 1000 - 3600,
      seven_day: { utilization: 90, resets_at: CLOCK / 1000 - 3600 },
    }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      seven_day: null,
      cedar_ember: { eligible: true, grants: [grant()] },
    }), { status: 200 }));
    const { claudeBankedResets, planWeek } = await import("../src/services/usage-client");

    await claudeBankedResets(env, new Date(CLOCK), true);

    const saved = JSON.parse(readFileSync(join(cache, "token-furnace", "usage.json"), "utf8"));
    expect(saved.fetched).toBe(CLOCK / 1000 - 3600); // the week's stamp is still the old one
    expect(savedClaude(env, cache).fetched).toBe(CLOCK / 1000); // the credits got their own
    expect(await planWeek(env, new Date(CLOCK + 61_000), false)).toBeNull(); // an ended week is no week

    // The next call still goes out for the new week, because the credit answer did not refresh it.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      seven_day: { utilization: 42, resets_at: new Date(CLOCK + 3 * 86_400_000).toISOString() },
      cedar_ember: { eligible: true, grants: [grant()] },
    }), { status: 200 }));
    expect((await planWeek(env, new Date(CLOCK + 61_000), true))?.used).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends Claude Code's own User-Agent, which Anthropic's credit surface requires", async () => {
    const { claude, cache, env } = machine();
    credentials(claude);
    const { claudeBankedResets } = await import("../src/services/usage-client");

    await claudeBankedResets(env, new Date(CLOCK), true);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const agent = (init.headers as Record<string, string>)["User-Agent"];
    expect(agent === undefined || /^claude-cli\//.test(agent)).toBe(true);
  });
});

describe("Codex banked resets", () => {
  it("does not spawn a process when there is no Codex home", async () => {
    const { codex, env } = machine();
    rmSync(codex, { recursive: true, force: true });
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK), true, runner);

    expect(runner).not.toHaveBeenCalled();
    expect(resets.state).toBe("no_login");
    expect(resets.availableCount).toBe(0);
  });

  it("answers no_login when the configured Codex home does not exist, even beside a real one", async () => {
    const { cache, env } = machine();
    // `codex/missing/..` resolves to a real directory, but the path itself names nothing.
    const configured = `${env.CODEX_HOME}/missing/..`; // a string join, so `..` stays in the path
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets({ ...env, CODEX_HOME: configured }, new Date(CLOCK), true, runner);

    expect(resets.state).toBe("no_login");
    expect(runner).not.toHaveBeenCalled();
    expect(existsSync(join(cache, "token-furnace", "banked")) && readdirSync(join(cache, "token-furnace", "banked")).length).toBe(0);
  });

  it("does not answer from a credit file that is a link to another home's", async () => {
    const { cache, env } = machine();
    const other = join(cache, "other-codex");
    mkdirSync(other, { recursive: true });
    // Another home's valid reading, linked from this home's file.
    writeFileSync(codexFile({ ...env, CODEX_HOME: other } as NodeJS.ProcessEnv, cache), cacheFile({ fetchedAt: CLOCK, triedAt: CLOCK, credits: credits([credit()]), error: null }));
    symlinkSync(codexFile({ ...env, CODEX_HOME: other } as NodeJS.ProcessEnv, cache), codexFile(env, cache));
    const runner = vi.fn(async () => credits([credit(), credit({ id: "b" })]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK + 6 * 60_000), true, runner);

    expect(runner).toHaveBeenCalledTimes(1); // the link answered nothing, so this home read for itself
    expect(resets.availableCount).toBe(2);
  });

  it("replaces a linked usage.json instead of writing through it", async () => {
    const { cache, claude, env } = machine();
    credentials(claude);
    // A file of somebody else's, linked in as usage.json. Nothing this program does may rewrite it.
    const shared = join(cache, "..", "shared-usage.json");
    const theirs = JSON.stringify({ seven_day: { utilization: 42, resets_at: "2027-01-20T00:00:00+00:00" }, note: "someone else's" });
    writeFileSync(shared, theirs);
    rmSync(join(cache, "token-furnace", "usage.json"), { force: true });
    symlinkSync(shared, join(cache, "token-furnace", "usage.json"));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ seven_day: { utilization: 77, resets_at: new Date(CLOCK + 86_400_000).toISOString() } }), { status: 200 }));
    const { planWeek } = await import("../src/services/usage-client");

    // The link is still read, so a status line's reading still answers.
    expect((await planWeek(env, new Date(CLOCK), false))!.used).toBe(42);
    await planWeek(env, new Date(CLOCK + 3_600_000), true); // a week old enough to refresh

    expect(readFileSync(shared, "utf8")).toBe(theirs); // untouched
    expect(lstatSync(join(cache, "token-furnace", "usage.json")).isSymbolicLink()).toBe(false); // replaced
    expect(JSON.parse(readFileSync(join(cache, "token-furnace", "usage.json"), "utf8")).seven_day.utilization).toBe(77);
  });

  it("does not trust a stamp that is later than now, so a corrected clock still reads", async () => {
    const { cache, env } = machine();
    // Written while the clock was a day ahead, then the clock was put right.
    writeFileSync(codexFile(env, cache), cacheFile({ fetchedAt: CLOCK + 86_400_000, triedAt: CLOCK, credits: credits([credit()]), error: null }));
    const runner = vi.fn(async () => credits([credit(), credit({ id: "b" })]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK), true, runner);

    expect(runner).toHaveBeenCalledTimes(1); // dated in the future is not fresh
    expect(resets.availableCount).toBe(2);
  });

  it("ages a stamp no date can hold, so a corrupt file cannot suppress the read for ever", async () => {
    const { env, cache } = machine();
    const at = codexFile(env, cache);
    writeFileSync(at, cacheFile({ fetchedAt: 1e20, triedAt: 1e20, credits: credits([credit()]), error: null }));
    const runner = vi.fn(async () => credits([credit(), credit({ id: "b" })]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK), true, runner);

    expect(runner).toHaveBeenCalledTimes(1); // the stamp said nothing, so it read again
    expect(resets.availableCount).toBe(2);
    expect(resets.fetchedAt).toBe(new Date(CLOCK).toISOString());
  });

  it("refuses a cached balance a fresh answer would have been refused for", async () => {
    const { cache, env } = machine();
    // Nine credits beside a credit list that is not a list: not a balance, whoever wrote it.
    writeFileSync(codexFile(env, cache), cacheFile({ fetchedAt: CLOCK, triedAt: CLOCK, credits: { availableCount: 9, credits: "invalid" }, error: null }));
    const runner = vi.fn(async () => null);
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK + 1_000), false, runner);

    expect(resets.state).toBe("unavailable"); // not "ok" with nine
    expect(resets.availableCount).toBe(0);
  });

  it("never blocks on a cache path that is not a regular file", async () => {
    const { cache, env } = machine();
    const at = codexFile(env, cache);
    // A pipe with no writer would hold a synchronous read for ever if it were trusted.
    execFileSync("mkfifo", [at]);
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK), true, runner);

    expect(resets.state).toBe("ok"); // the pipe answered nothing, so this home read for itself
    expect(resets.availableCount).toBe(1);
    expect(lstatSync(at).isFile()).toBe(true); // and its own file replaced the pipe
  });

  it("replaces a planted symlink at the cache path instead of writing through it", async () => {
    const { cache, env } = machine();
    const victim = join(cache, "victim.json");
    const at = claudeFile(env, cache);
    writeFileSync(victim, JSON.stringify({ keep: true }));
    rmSync(at, { force: true });
    symlinkSync(victim, at);
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets(env, new Date(CLOCK), true, runner);

    expect(JSON.parse(readFileSync(victim, "utf8"))).toEqual({ keep: true }); // untouched
    expect(JSON.parse(readFileSync(codexFile(env, cache), "utf8")).credits.credits).toHaveLength(1);
  });

  it("reads the credits through the runner and marks a past expiry as expired", async () => {
    const { env } = machine();
    const runner = vi.fn(async () => credits([
      credit({ expiresAt: (CLOCK - 1000) / 1000 }),
      credit({ id: "RateLimitResetCredit_2", expiresAt: (CLOCK + 5 * 86_400_000) / 1000 }),
    ]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK), true, runner);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(resets.state).toBe("ok");
    expect(resets.availableCount).toBe(1);
    expect(resets.grants.map((g) => g.status)).toEqual(["expired", "available"]);
    expect(resets.grants[1]).toMatchObject({ next: true, title: "Full reset", scope: "codexRateLimits" });
    expect(resets.grants[1].expiresAt).toBe(new Date(CLOCK + 5 * 86_400_000).toISOString()); // epoch seconds became an instant
  });

  it("reports the reading time as an instant, not as a year 59009 date", async () => {
    const { env } = machine();
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK), true, runner);

    expect(resets.fetchedAt).toBe(new Date(CLOCK).toISOString());
    expect(new Date(resets.fetchedAt!).getUTCFullYear()).toBe(2027);
  });

  it("leaves no half-written file behind, so a cached read still parses", async () => {
    const { cache, env } = machine();
    const dir = join(cache, "token-furnace", "banked");
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets(env, new Date(CLOCK), true, runner);

    expect(readdirSync(dir)).toEqual([codexFile(env, cache).split("/").pop()]); // the temp file was renamed, not left
    expect(() => JSON.parse(readFileSync(codexFile(env, cache), "utf8"))).not.toThrow();
  });

  it("gives each Codex home a file of its own, so one home cannot disturb another", async () => {
    const { cache, env } = machine();
    const at = codexFile(env, cache);
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");
    const second = join(cache, "other-codex");
    mkdirSync(second, { recursive: true });

    expect((await codexBankedResets(env, new Date(CLOCK), true, runner)).availableCount).toBe(1);
    await codexBankedResets({ ...env, CODEX_HOME: second }, new Date(CLOCK + 1000), true,
      vi.fn(async () => credits([credit(), credit({ id: "b" })])));

    const resets = await codexBankedResets(env, new Date(CLOCK + 60_000), false, runner);

    expect(resets.state).toBe("ok");
    expect(resets.availableCount).toBe(1); // this home's reading, not the other home's
    expect(bankedFile(cache, "codex", second)).not.toBe(at); // two files, not one
    expect(JSON.parse(readFileSync(at, "utf8")).credits.credits).toHaveLength(1);
    expect(JSON.parse(readFileSync(bankedFile(cache, "codex", second), "utf8")).credits.credits).toHaveLength(2);
    expect(runner).toHaveBeenCalledTimes(1); // and its 5-minute reading was reused
  });

  it("records a failed read's backoff in the file, so the next process waits too", async () => {
    const { cache, env } = machine();
    const at = codexFile(env, cache);
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets(env, new Date(CLOCK), true, runner); // a good balance on disk
    runner.mockRejectedValueOnce(new Error("timeout"));
    await codexBankedResets(env, new Date(CLOCK + 6 * 60_000), true, runner);

    const saved = JSON.parse(readFileSync(at, "utf8"));
    expect(saved.triedAt).toBe(CLOCK + 6 * 60_000); // the attempt is on disk
    expect(saved.error).toBe("Codex did not answer the rate-limit read.");
    expect(saved.credits.credits).toHaveLength(1); // and the balance it kept is still there
  });

  it("does not let an older answer overwrite a newer credit reading", async () => {
    const { claude, cache, env } = machine();
    credentials(claude);
    usageCache(env, cache, undefined, CLOCK / 1000 - 10); // the week, and no credits yet
    // Another process has already saved a reading made after the call this one is about to make.
    const later = CLOCK / 1000 + 5;
    writeFileSync(claudeFile(env, cache), JSON.stringify({ source: "claude-usage", fetched: later, block: { eligible: true, grants: [grant()] } }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      seven_day: { utilization: 42, resets_at: new Date(CLOCK + 3 * 86_400_000).toISOString() },
      cedar_ember: { eligible: true, grants: [grant(), grant({ id: "second" })] },
    }), { status: 200 }));
    const { claudeBankedResets } = await import("../src/services/usage-client");

    const resets = await claudeBankedResets(env, new Date(CLOCK), true);

    expect(resets.availableCount).toBe(1); // the newer reading answers, not this call's later one
    expect(savedClaude(env, cache).fetched).toBe(later); // and its file was left alone
    vi.resetModules();
    const next = await import("../src/services/usage-client");
    expect((await next.claudeBankedResets(env, new Date(CLOCK + 61_000), false)).availableCount).toBe(1);
  });

  it("counts another process's failed attempt, so it does not spawn a second later", async () => {
    const { cache, env } = machine();
    const at = codexFile(env, cache);
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets(env, new Date(CLOCK), true, runner); // this process holds a good reading
    // Another process fails a read at CLOCK + 6m and records the attempt with the same balance.
    writeFileSync(at, cacheFile({ fetchedAt: CLOCK, triedAt: CLOCK + 6 * 60_000, credits: credits([credit()]), error: "Codex did not answer the rate-limit read." }));

    await codexBankedResets(env, new Date(CLOCK + 6 * 60_000 + 1_000), true, runner);

    expect(runner).toHaveBeenCalledTimes(1); // the minute has not passed, whatever this process remembers
  });

  it("shares one read between two spellings of the same home", async () => {
    const { env } = machine();
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const runner = vi.fn(async () => {
      await gate;
      return credits([credit()]);
    });
    const { codexBankedResets } = await import("../src/services/banked-resets-client");
    const rel = relative(process.cwd(), String(env.CODEX_HOME));

    const both = Promise.all([
      codexBankedResets(env, new Date(CLOCK), true, runner),
      codexBankedResets({ ...env, CODEX_HOME: rel }, new Date(CLOCK), true, runner),
    ]);
    release();
    const [a, b] = await both;

    expect(runner).toHaveBeenCalledTimes(1); // one home, one read
    expect([a.availableCount, b.availableCount]).toEqual([1, 1]);
  });

  it("does not let a slow failure publish an older attempt over a newer one", async () => {
    const { cache, env } = machine();
    const at = codexFile(env, cache);
    // A later attempt is already on disk with the same (old) balance.
    writeFileSync(at, cacheFile({ fetchedAt: CLOCK - HOUR, triedAt: CLOCK + 5_000, credits: credits([credit()]), error: "Codex did not answer the rate-limit read." }));
    // This attempt started five seconds earlier and only now gives up.
    const runner = vi.fn(async () => {
      throw new Error("timeout");
    });
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets(env, new Date(CLOCK), true, runner);

    expect(JSON.parse(readFileSync(at, "utf8")).triedAt).toBe(CLOCK + 5_000); // the later attempt stands
  });

  it("treats a symlinked Codex home as the home it points at", async () => {
    const { codex, cache, env } = machine();
    const link = join(cache, "..", "codex-link");
    symlinkSync(codex, link);
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets(env, new Date(CLOCK), true, runner);
    const viaLink = await codexBankedResets({ ...env, CODEX_HOME: link }, new Date(CLOCK + 1_000), true, runner);

    expect(viaLink.availableCount).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1); // one home, one read, one reuse window
    expect(existsSync(bankedFile(cache, "codex", link))).toBe(true);
    expect(bankedFile(cache, "codex", link)).toBe(codexFile(env, cache));
  });

  it("treats two spellings of one Codex home as one file", async () => {
    const { cache, env } = machine();
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");
    const rel = relative(process.cwd(), String(env.CODEX_HOME));

    await codexBankedResets(env, new Date(CLOCK), true, runner);
    await codexBankedResets({ ...env, CODEX_HOME: rel }, new Date(CLOCK + 1_000), true, runner);

    expect(runner).toHaveBeenCalledTimes(1); // same home: the 5-minute reading is reused
    expect(readdirSync(join(cache, "token-furnace", "banked"))).toHaveLength(1);
  });

  it("keeps its 5-minute and 1-minute gates under --no-cache, where nothing is on disk", async () => {
    const { env } = machine();
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets({ ...env, TOKEN_FURNACE_NO_CACHE: "1" }, new Date(CLOCK), true, runner);
    await codexBankedResets({ ...env, TOKEN_FURNACE_NO_CACHE: "1" }, new Date(CLOCK + 1_000), true, runner);
    expect(runner).toHaveBeenCalledTimes(1); // the reading this process made is still fresh

    runner.mockRejectedValueOnce(new Error("timeout"));
    const failed = await codexBankedResets({ ...env, TOKEN_FURNACE_NO_CACHE: "1" }, new Date(CLOCK + 6 * 60_000), true, runner);
    expect(failed.availableCount).toBe(1); // and a failure keeps the balance it had
    await codexBankedResets({ ...env, TOKEN_FURNACE_NO_CACHE: "1" }, new Date(CLOCK + 6 * 60_000 + 1_000), true, runner);
    expect(runner).toHaveBeenCalledTimes(2); // the minute has not passed
  });

  it("files each Claude profile apart, and treats two spellings of one home as one", async () => {
    const { claude, cache, env } = machine();
    credentials(claude);
    // A second profile with a reading of its own already saved.
    const other = join(cache, "second-claude");
    mkdirSync(other, { recursive: true });
    credentials(other);
    writeFileSync(bankedFile(cache, "claude", other), JSON.stringify({ source: "claude-usage", fetched: CLOCK / 1000, block: { eligible: true, grants: [grant()] } }));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      seven_day: null,
      cedar_ember: { eligible: true, grants: [grant(), grant({ id: "second" })] },
    }), { status: 200 }));
    const { claudeBankedResets } = await import("../src/services/usage-client");

    // A relative spelling of the same home is the same home: one file, one answer.
    const rel = relative(process.cwd(), claude);
    expect((await claudeBankedResets({ ...env, CLAUDE_CONFIG_DIR: rel }, new Date(CLOCK), true)).availableCount).toBe(2);
    expect(existsSync(claudeFile(env, cache))).toBe(true);

    // A second profile answers from its own reading, not from the first one's.
    expect((await claudeBankedResets({ ...env, CLAUDE_CONFIG_DIR: other }, new Date(CLOCK), true)).availableCount).toBe(1);
    expect(JSON.parse(readFileSync(bankedFile(cache, "claude", other), "utf8")).block.grants).toHaveLength(1);
  });

  it("reuses the saved reading for 5 minutes and rereads after that", async () => {
    const { cache, env } = machine();
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets(env, new Date(CLOCK), true, runner);
    await codexBankedResets(env, new Date(CLOCK + 4 * 60_000), true, runner);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(existsSync(codexFile(env, cache))).toBe(true);

    // A new process reuses the saved file, then reads again once it ages out.
    vi.resetModules();
    const again = await import("../src/services/banked-resets-client");
    expect((await again.codexBankedResets(env, new Date(CLOCK + 4 * 60_000 + 30_000), true, runner)).state).toBe("ok");
    expect(runner).toHaveBeenCalledTimes(1);
    await again.codexBankedResets(env, new Date(CLOCK + 6 * 60_000), true, runner);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good reading and backs off for a minute after a failure", async () => {
    const { env } = machine();
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets(env, new Date(CLOCK), true, runner);
    runner.mockRejectedValueOnce(new Error("spawn codex ENOENT"));
    const failed = await codexBankedResets(env, new Date(CLOCK + 6 * 60_000), true, runner);

    expect(runner).toHaveBeenCalledTimes(2);
    expect(failed.state).toBe("ok"); // the credits we had are still real
    expect(failed.stale).toBe(true);
    expect(failed.note).toBe("Codex did not answer the rate-limit read.");

    await codexBankedResets(env, new Date(CLOCK + 6 * 60_000 + 30_000), true, runner);
    expect(runner).toHaveBeenCalledTimes(2); // the minute has not passed
    await codexBankedResets(env, new Date(CLOCK + 6 * 60_000 + 61_000), true, runner);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("never spawns or writes with network false, and answers from the saved file", async () => {
    const { cache, env } = machine();
    const at = codexFile(env, cache);
    mkdirSync(join(cache, "token-furnace"), { recursive: true });
    writeFileSync(at, cacheFile({ fetchedAt: CLOCK - HOUR, triedAt: CLOCK - HOUR, credits: credits([credit()]), error: null }));
    const before = readFileSync(at, "utf8");
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK), false, runner);

    expect(runner).not.toHaveBeenCalled();
    expect(resets.availableCount).toBe(1);
    expect(resets.stale).toBe(true); // an hour old: the page says so
    expect(readFileSync(at, "utf8")).toBe(before);
  });

  it("writes no cache under --no-cache", async () => {
    const { cache, env } = machine();
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets({ ...env, TOKEN_FURNACE_NO_CACHE: "1" }, new Date(CLOCK), true, runner);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(existsSync(codexFile(env, cache))).toBe(false);
  });

  it("rejects an answer whose credits are not a list, keeping the balance it had", async () => {
    const { env } = machine();
    const runner = vi.fn(async () => credits([credit()]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    await codexBankedResets(env, new Date(CLOCK), true, runner);
    for (const broken of [
      { availableCount: 0, credits: "malformed" },
      { availableCount: 0, credits: [null] },
      { availableCount: 0, credits: [{}] },
      { availableCount: 1, credits: [{ id: "credit-1" }] }, // a row with no status cannot be counted
      { availableCount: 1, credits: [{ id: "credit-1", status: "" }] }, // nor one with an empty status
      { availableCount: 1, credits: [{ id: "credit-1", status: "AVAILABLE" }] }, // nor a status outside the enum
      { availableCount: 1, credits: [{ id: "credit-1", status: "available", expiresAt: "1700000000" }] }, // nor a string expiry
      { availableCount: 1, credits: [{ id: "credit-1", status: "available", expiresAt: 1e20 }] }, // nor one that is not an instant
    ]) {
      runner.mockResolvedValueOnce(broken);
      const resets = await codexBankedResets(env, new Date(CLOCK + 6 * 60_000), true, runner);
      expect(resets.availableCount, JSON.stringify(broken)).toBe(1); // not a fresh zero from a broken answer
      expect(resets.state).toBe("ok");
      expect(resets.stale).toBe(true);
      expect(resets.note).toBe("Codex did not answer the rate-limit read.");
    }
  });

  it("does not let a failed read overwrite a newer reading another process saved", async () => {
    const { cache, env } = machine();
    const at = codexFile(env, cache);
    mkdirSync(join(cache, "token-furnace"), { recursive: true });
    writeFileSync(at, cacheFile({ fetchedAt: CLOCK - HOUR, triedAt: CLOCK - HOUR, credits: credits([credit()]), error: null }));
    // While this read is open, another process (an MCP client) saves a newer balance; then ours times out.
    const runner = vi.fn(async () => {
      writeFileSync(at, cacheFile({
        fetchedAt: CLOCK, triedAt: CLOCK, error: null,
        credits: credits([credit(), credit({ id: "RateLimitResetCredit_2" })]),
      }));
      throw new Error("codex app-server timed out");
    });
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK + 6 * 60_000), true, runner);

    expect(resets.availableCount).toBe(2); // the newer reading wins, not this call's older one
    expect(JSON.parse(readFileSync(at, "utf8")).credits.credits).toHaveLength(2);
  });

  it("does not let another Codex home's newer file make its own read look empty", async () => {
    const { cache, env } = machine();
    // Another home has a newer reading, in its own file.
    const other = join(cache, "other-codex");
    writeFileSync(bankedFile(cache, "codex", other), cacheFile({ fetchedAt: CLOCK + HOUR, triedAt: CLOCK, credits: credits([credit()]), error: null }));
    const runner = vi.fn(async () => credits([credit(), credit({ id: "RateLimitResetCredit_2" })]));
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const resets = await codexBankedResets(env, new Date(CLOCK), true, runner);

    expect(resets.state).toBe("ok"); // this home's own read stands, whatever the other file says
    expect(resets.availableCount).toBe(2);
    expect(JSON.parse(readFileSync(codexFile(env, cache), "utf8")).fetchedAt).toBe(CLOCK);
  });

  it("picks up a reading another process wrote after it first looked", async () => {
    const { cache, env } = machine();
    const at = codexFile(env, cache);
    const runner = vi.fn(async () => null);
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    // Nothing saved yet: the long-lived process answers "unavailable".
    expect((await codexBankedResets(env, new Date(CLOCK), false, runner)).state).toBe("unavailable");

    // Another process (an MCP client) saves a reading; this one must see it without a restart.
    mkdirSync(join(cache, "token-furnace"), { recursive: true });
    writeFileSync(at, cacheFile({ fetchedAt: CLOCK, triedAt: CLOCK, credits: credits([credit()]), error: null }));
    const resets = await codexBankedResets(env, new Date(CLOCK), false, runner);

    expect(resets.state).toBe("ok");
    expect(resets.availableCount).toBe(1);
    expect(runner).not.toHaveBeenCalled();
  });

  it("shares one read between concurrent callers", async () => {
    const { env } = machine();
    const runner = vi.fn(async () => {
      await new Promise((done) => setTimeout(done, 10));
      return credits([credit()]);
    });
    const { codexBankedResets } = await import("../src/services/banked-resets-client");

    const [a, b] = await Promise.all([
      codexBankedResets(env, new Date(CLOCK), true, runner),
      codexBankedResets(env, new Date(CLOCK), true, runner),
    ]);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(a.availableCount).toBe(1);
    expect(b.availableCount).toBe(1);
  });
});

describe("the snapshot", () => {
  it("carries both supported providers and marks the rest unsupported without any I/O", async () => {
    const { env } = machine();
    const { bankedResetsSnapshot } = await import("../src/services/banked-resets-client");

    const snapshot = await bankedResetsSnapshot(env, new Date(CLOCK), false);

    expect(snapshot.fetchedAt).toBe(new Date(CLOCK).toISOString());
    expect(Object.keys(snapshot.providers).sort()).toEqual(["agy", "claude", "codex", "opencode"]);
    expect(snapshot.providers.opencode).toMatchObject({ state: "unsupported", availableCount: 0, grants: [] });
    expect(snapshot.providers.agy).toMatchObject({ state: "unsupported", availableCount: 0, grants: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the codex app-server read", () => {
  it("answers over stdio with the credits block and kills the child", async () => {
    const { codex, cache, env } = machine();
    const bin = tempRoot("tf-codex-bin-");
    const pid = join(cache, "child.pid");
    fakeCodex(bin, `
      require("node:fs").writeFileSync(${JSON.stringify(pid)}, String(process.pid));
      const read = require("node:readline").createInterface({ input: process.stdin });
      read.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
        if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: ${JSON.stringify({ rateLimitResetCredits: credits([credit()]) })} }) + "\\n");
      });`);
    const { codexAppServer } = await import("../src/services/banked-resets-client");

    const result = await codexAppServer({ ...env, PATH: `${bin}:${process.env.PATH}` }, codex, 8_000);

    expect(result).toEqual(credits([credit()]));
    await until(() => !alive(Number(readFileSync(pid, "utf8"))));
  });

  it("gives up on a child that never answers and leaves nothing running", async () => {
    const { codex, cache, env } = machine();
    const bin = tempRoot("tf-codex-bin-");
    const pid = join(cache, "child.pid");
    fakeCodex(bin, `
      require("node:fs").writeFileSync(${JSON.stringify(pid)}, String(process.pid));
      process.on("SIGTERM", () => {}); // a child that refuses to leave
      process.stdin.resume(); // stay up, say nothing
      setInterval(() => {}, 1000);`);
    const { codexAppServer } = await import("../src/services/banked-resets-client");

    const started = Date.now();
    const result = await codexAppServer({ ...env, PATH: `${bin}:${process.env.PATH}` }, codex, 1_000);

    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    await until(() => existsSync(pid)); // the child ran and recorded itself
    await until(() => !alive(Number(readFileSync(pid, "utf8")))); // and the kill took it out
  });

  it("reads null when there is no codex on PATH at all", async () => {
    const { codex, cache, env } = machine();
    const { codexAppServer } = await import("../src/services/banked-resets-client");

    expect(await codexAppServer({ ...env, PATH: cache }, codex, 200)).toBeNull();
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((next) => setTimeout(next, 5));
  expect(check()).toBe(true);
}
