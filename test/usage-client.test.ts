import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/compose";

const TOKEN = "unit-test-token";
const CLOCK = 1_800_000_000_000;

let roots: string[] = [];
let apps: App[] = [];
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
  return {
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
  for (const app of apps) app.close();
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
