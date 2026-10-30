import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "unit-test-token";
const CLOCK = 1_800_000_000_000;

let roots: string[] = [];
let apps: { repo: unknown }[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function sevenDay(): { resets_at: string; utilization: number } {
  return { resets_at: new Date(CLOCK + 3 * 86_400_000).toISOString(), utilization: 37 };
}

function makeEnv(claudeDir: string, cacheDir: string): NodeJS.ProcessEnv {
  const home = tempRoot("tf-usage-home-");
  symlinkSync(claudeDir, join(home, ".claude"), "dir");
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    XDG_CACHE_HOME: cacheDir,
    TOKEN_FURNACE_NOW: new Date(CLOCK).toISOString(),
    TOKEN_FURNACE_WORKERS: "0",
  };
}

function writeCreds(claudeDir: string): void {
  writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
}

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify({ seven_day: sevenDay() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const app of apps) (app.repo as { close?: () => void }).close?.();
  apps = [];
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

describe("planWeek cache opt-out", () => {
  it("--no-cache fetches a fresh week but writes no usage cache", async () => {
    const claudeDir = tempRoot("tf-usage-claude-");
    const cacheDir = tempRoot("tf-usage-cache-");
    writeCreds(claudeDir);
    const { compose } = await import("../src/compose");
    const { planWeek } = await import("../src/services/usage-client");
    const app = compose(makeEnv(claudeDir, cacheDir), { noCache: true });
    apps.push(app);

    const week = await planWeek(app.env, new Date(CLOCK), true);

    expect(week).not.toBeNull();
    expect(week!.used).toBe(37);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(existsSync(join(cacheDir, "token-furnace"))).toBe(false);
  });

  it("default path still writes usage.json", async () => {
    const claudeDir = tempRoot("tf-usage-claude-");
    const cacheDir = tempRoot("tf-usage-cache-");
    writeCreds(claudeDir);
    const { compose } = await import("../src/compose");
    const { planWeek } = await import("../src/services/usage-client");
    const app = compose(makeEnv(claudeDir, cacheDir));
    apps.push(app);

    const week = await planWeek(app.env, new Date(CLOCK), true);

    expect(week!.used).toBe(37);
    const saved = JSON.parse(readFileSync(join(cacheDir, "token-furnace", "usage.json"), "utf8"));
    expect(saved.seven_day.utilization).toBe(37);
  });

  it("explicit noCache:false overrides TOKEN_FURNACE_NO_CACHE=1", async () => {
    const claudeDir = tempRoot("tf-usage-claude-");
    const cacheDir = tempRoot("tf-usage-cache-");
    writeCreds(claudeDir);
    const { compose } = await import("../src/compose");
    const { planWeek } = await import("../src/services/usage-client");
    const app = compose({ ...makeEnv(claudeDir, cacheDir), TOKEN_FURNACE_NO_CACHE: "1" }, { noCache: false });
    apps.push(app);

    expect(app.env.TOKEN_FURNACE_NO_CACHE).toBe("0");
    const week = await planWeek(app.env, new Date(CLOCK), true);

    expect(week!.used).toBe(37);
    expect(existsSync(join(cacheDir, "token-furnace", "usage.json"))).toBe(true);
    expect(existsSync(join(cacheDir, "token-furnace", "cache.sqlite"))).toBe(true);
  });

  it("network false reads the saved reading and writes nothing", async () => {
    const claudeDir = tempRoot("tf-usage-claude-");
    const cacheDir = tempRoot("tf-usage-cache-");
    const dir = join(cacheDir, "token-furnace");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "usage.json");
    const before = JSON.stringify({ fetched: CLOCK / 1000 - 10, seven_day: sevenDay() });
    writeFileSync(file, before);
    const { compose } = await import("../src/compose");
    const { planWeek } = await import("../src/services/usage-client");
    const app = compose(makeEnv(claudeDir, cacheDir), { noCache: true });
    apps.push(app);

    const week = await planWeek(app.env, new Date(CLOCK), false);

    expect(week!.used).toBe(37);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("per-install Claude credentials and usage cache", () => {
  it("uses the hashed Keychain service and an install-specific usage file", async () => {
    const claudeDir = tempRoot("tf-usage-cc-work-");
    const cacheDir = tempRoot("tf-usage-cache-");
    const security = vi.fn(() => JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
    const { planWeek } = await import("../src/services/usage-client");
    const install = { id: "claude:work", label: "Claude Code (work)", dir: claudeDir, isDefault: false, found: ["scan" as const] };

    const week = await planWeek(
      { ...makeEnv(claudeDir, cacheDir), CLAUDE_CONFIG_DIR: undefined },
      new Date(CLOCK),
      true,
      install,
      security,
    );

    expect(week?.used).toBe(37);
    expect(security).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", `Claude Code-credentials-${createHash("sha256").update(claudeDir).digest("hex").slice(0, 8)}`, "-w"],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(existsSync(join(cacheDir, "token-furnace", "usage-work.json"))).toBe(true);
    expect(existsSync(join(cacheDir, "token-furnace", "usage.json"))).toBe(false);
  });

  it("prefers the install credentials file and never falls back to another install", async () => {
    const home = tempRoot("tf-usage-home-");
    const cacheDir = tempRoot("tf-usage-cache-");
    const a = tempRoot("tf-usage-a-");
    const b = tempRoot("tf-usage-b-");
    writeCreds(a);
    const security = vi.fn((_: string, args: string[]) => {
      if (args.includes("Claude Code-credentials-b")) return TOKEN;
      throw new Error("missing keychain item");
    });
    const { planWeek } = await import("../src/services/usage-client");
    const installA = { id: "claude:a", label: "Claude Code (a)", dir: a, isDefault: false, found: ["scan" as const] };
    const installB = { id: "claude:b", label: "Claude Code (b)", dir: b, isDefault: false, found: ["scan" as const] };

    expect((await planWeek({ ...makeEnv(a, cacheDir), HOME: home }, new Date(CLOCK), true, installA, security))?.used).toBe(37);
    expect(security).not.toHaveBeenCalled();
    expect(await planWeek({ ...makeEnv(b, cacheDir), HOME: home }, new Date(CLOCK), true, installB, security)).toBeNull();
    expect(existsSync(join(cacheDir, "token-furnace", "usage-a.json"))).toBe(true);
    expect(existsSync(join(cacheDir, "token-furnace", "usage-b.json"))).toBe(false);
  });
});


it("keeps a no-cache 100% reading in memory for A without serving it to B", async () => {
  const home = tempRoot("tf-usage-isolation-");
  const a = tempRoot("tf-usage-a-");
  const b = tempRoot("tf-usage-b-");
  const env = { HOME: home, XDG_CACHE_HOME: join(home, ".cache"), TOKEN_FURNACE_NO_CACHE: "1" };
  writeCreds(a);
  const { planWeek } = await import("../src/services/usage-client");
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ seven_day: { ...sevenDay(), utilization: 100 } })));
  const security = vi.fn(() => { throw new Error("missing Keychain item"); });
  const installA = { id: "claude:a", label: "Claude Code (a)", dir: a, isDefault: false, found: [] };
  const installB = { id: "claude:b", label: "Claude Code (b)", dir: b, isDefault: false, found: [] };
  expect((await planWeek(env, new Date(CLOCK), true, installA, security))?.used).toBe(100);
  expect((await planWeek(env, new Date(CLOCK + 1000), true, installA, security))?.used).toBe(100);
  expect(await planWeek(env, new Date(CLOCK + 1000), true, installB, security)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(security).toHaveBeenCalledTimes(1);
  expect(existsSync(join(home, ".cache"))).toBe(false);
});

it("queries the default Keychain service for the default install only", async () => {
  const home = tempRoot("tf-usage-default-");
  const dir = join(home, ".claude");
  mkdirSync(dir);
  const { accessToken } = await import("../src/services/usage-client");
  const security = vi.fn(() => JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
  expect(accessToken({ id: "claude", label: "Claude Code", dir, isDefault: true, found: [] }, security)).toBe(TOKEN);
  expect(security.mock.calls[0]).toBeDefined();
  expect(security).toHaveBeenCalledWith("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], expect.anything());
});
