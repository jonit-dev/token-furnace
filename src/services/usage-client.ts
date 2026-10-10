import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Week } from "../core/model";
import type { Env } from "../sources/agent-source";

/** A saved reading is reused for 5 minutes, and one call is tried per minute. burn.py:862 */
const REUSE_SECONDS = 300;
const RETRY_SECONDS = 60;

/** Last call in this process: one call a minute, so a server does not burn the rate limit. */
let lastTry = 0;
let lastWeek: Week | null = null;

/** The saved reading, in the file burn.py writes and a status line can feed. */
export function usageCachePath(env: Env): string {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(base, "token-furnace", "usage.json");
}

/**
 * The subscription's 7-day window, or null when unavailable. The login token goes to
 * api.anthropic.com and nowhere else, so only --plan-usage calls this. Any failure keeps the last
 * good reading.
 */
export async function planWeek(env: Env, now: Date): Promise<Week | null> {
  const at = now.getTime() / 1000;
  if (at - lastTry < RETRY_SECONDS) return lastWeek;
  lastTry = at;

  const path = usageCachePath(env);
  const saved = readJson(path);
  let data = saved?.seven_day ?? null;
  if (!data || at - (saved?.fetched ?? 0) >= REUSE_SECONDS) {
    const fresh = await fetchWeek(env);
    if (fresh) {
      data = fresh;
      writeJson(path, { fetched: at, seven_day: data });
    }
  }

  lastWeek = toWeek(data, now);
  return lastWeek;
}

async function fetchWeek(env: Env): Promise<Record<string, any> | null> {
  const token = accessToken(env);
  if (!token) return null;
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, any>;
    return typeof body?.seven_day === "object" && body.seven_day !== null ? body.seven_day : null;
  } catch {
    return null; // the endpoint rate-limits; the saved reading stays
  }
}

/** The Claude Code login token: the credentials file, else the macOS Keychain. burn.py:881 */
function accessToken(env: Env): string | null {
  let creds: string | null = null;
  const home = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  try {
    creds = readFileSync(join(home, ".credentials.json"), "utf8");
  } catch {
    try {
      creds = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", timeout: 5_000 },
      );
    } catch {
      return null;
    }
  }
  try {
    return (JSON.parse(creds).claudeAiOauth.accessToken as string) ?? null;
  } catch {
    return null;
  }
}

/** The endpoint's reading as a Week: epoch seconds or an ISO string, and only while it runs. */
function toWeek(data: Record<string, any> | null, now: Date): Week | null {
  if (!data) return null;
  const resets =
    typeof data.resets_at === "number"
      ? new Date(data.resets_at * 1000)
      : typeof data.resets_at === "string"
        ? new Date(data.resets_at)
        : null;
  if (!resets || Number.isNaN(resets.getTime()) || resets <= now) return null;
  const used = Number(data.utilization);
  if (!Number.isFinite(used)) return null;
  return { start: new Date(resets.getTime() - 7 * 86_400_000), resets, used };
}

function readJson(path: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  } catch {
    // A cache we cannot write is a slow run, not a wrong one.
  }
}