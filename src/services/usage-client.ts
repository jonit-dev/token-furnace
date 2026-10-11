import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OpenCodeSource } from "../sources/opencode";
import type { Week } from "../core/model";
import type { Env } from "../sources/agent-source";

/** A saved reading is reused for 5 minutes, and one call is tried per minute. burn.py:862 */
const REUSE_SECONDS = 300;
const RETRY_SECONDS = 60;

/** Last network call in this process: one a minute, so a server does not burn the rate limit. */
let lastTry = 0;

/** The saved reading, in the file burn.py writes and a status line can feed. */
export function usageCachePath(env: Env): string {
  const base = env.TOKEN_FURNACE_CACHE_HOME || env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(base, "token-furnace", "usage.json");
}

/**
 * The subscription's 7-day window, or null when unavailable. The saved reading is a local file a
 * status line can feed. With `network` true, a login on this machine (the credentials file or the
 * macOS Keychain) triggers one call to api.anthropic.com when the reading is over 5 minutes old,
 * at most once a minute. The token goes there and nowhere else. A failed call keeps the saved
 * reading. No login on the machine means no call.
 */
export async function planWeek(env: Env, now: Date, network: boolean): Promise<Week | null> {
  return planReading(env, now, network);
}

/** The subscription window plus the cache observation metadata used by Auto admission. */
export async function planReading(env: Env, now: Date, network: boolean): Promise<Week | null> {
  const at = now.getTime() / 1000;
  const path = usageCachePath(env);
  const saved = readJson(path);
  let data = saved?.seven_day ?? null;
  let observedAt = finiteEpoch(saved?.fetched);
  let account = typeof saved?.account === "string" ? saved.account : null;
  const stale = !data || at - (saved?.fetched ?? 0) >= REUSE_SECONDS;
  if (network && stale && at - lastTry >= RETRY_SECONDS) {
    const credentials = accessCredentials(env);
    if (credentials?.token) {
      lastTry = at;
      const fresh = await fetchWeek(credentials.token);
      if (fresh) {
        data = fresh;
        observedAt = at;
        account = credentials.account;
        if (!(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0")) {
          writeJson(path, { fetched: at, account, window: "7d", seven_day: data });
        }
      }
    }
  }
  return toWeek(data, now, observedAt, account);
}

async function fetchWeek(token: string): Promise<Record<string, any> | null> {
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
function accessCredentials(env: Env): { token: string; account: string | null } | null {
  let creds: string | null = null;
  const home = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  try {
    creds = readFileSync(join(home, ".credentials.json"), "utf8");
  } catch {
    try {
      creds = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      return null;
    }
  }
  try {
    const oauth = JSON.parse(creds).claudeAiOauth;
    const token = typeof oauth?.accessToken === "string" ? oauth.accessToken : "";
    if (!token) return null;
    const account = [oauth.accountUuid, oauth.accountUUID, oauth.accountId].find((value: unknown) => typeof value === "string" && value.trim());
    return { token, account: typeof account === "string" ? account : null };
  } catch {
    return null;
  }
}

/** The endpoint's reading as a Week: epoch seconds or an ISO string, and only while it runs. */
function toWeek(data: Record<string, any> | null, now: Date, observedSeconds = Number.NaN, account: string | null = null): Week | null {
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
  return {
    start: new Date(resets.getTime() - 7 * 86_400_000), resets, used,
    observedAt: new Date(Number.isFinite(observedSeconds) ? observedSeconds * 1000 : 0), window: "7d", account, authoritative: true,
  };
}

function finiteEpoch(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
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

const goReadings = new Map<string, { fetched: number; lastTry: number; account: string | null; data: Record<string, any> | null }>();

/** Go supplies its actual weekly meter; local token totals only calibrate the burn estimate. */
export async function openCodeWeek(env: Env, now: Date, network: boolean): Promise<Week | null> {
  const source = new OpenCodeSource(env);
  const path = join(dirname(usageCachePath(env)), "opencode-usage.json");
  const key = source.base();
  const saved = readJson(path);
  const reading = goReadings.get(key) ?? { fetched: saved?.fetched ?? Number.NaN, lastTry: 0,
    account: typeof saved?.account === "string" ? saved.account : null,
    data: saved?.source === key ? saved?.seven_day ?? null : null };
  const at = now.getTime() / 1000;
  if (network && (!reading.data || at - reading.fetched >= REUSE_SECONDS) && at - reading.lastTry >= RETRY_SECONDS) {
    const auth = jsonAuth(source.readFile("auth.json"));
    const providerAuth = auth?.["opencode-go"];
    const token = env.OPENCODE_API_KEY || providerAuth?.key;
    if (typeof token === "string" && token) {
      reading.lastTry = at;
      goReadings.set(key, reading);
      try {
        const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "token-furnace" },
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const body = await response.json() as Record<string, any>;
          const weekly = body?.usage?.weekly;
          if (typeof weekly?.percent === "number" && Number.isFinite(weekly.percent) && weekly.percent >= 0) {
            const data = { utilization: weekly.percent, resets_at: weekly.resetsAt };
            if (toWeek(data, now)) {
              reading.data = data; reading.fetched = at;
              const account = providerAuth?.accountId ?? providerAuth?.account ?? providerAuth?.id;
              reading.account = typeof account === "string" && account.trim() ? account : null;
              if (!(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0"))
                writeJson(path, { source: key, fetched: at, account: reading.account, window: "7d", seven_day: data });
            }
          }
        }
      } catch { /* Keep the last unexpired reading when offline or rate limited. */ }
    }
  }
  return toWeek(reading.data, now, reading.fetched, reading.account);
}

function jsonAuth(text: string | null): Record<string, any> | null {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
