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
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
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
  const at = now.getTime() / 1000;
  const path = usageCachePath(env);
  const saved = readJson(path);
  let data = saved?.seven_day ?? null;
  const stale = !data || at - (saved?.fetched ?? 0) >= REUSE_SECONDS;
  if (network && stale && at - lastTry >= RETRY_SECONDS) {
    const token = accessToken(env);
    if (token) {
      lastTry = at;
      const fresh = await fetchWeek(token);
      if (fresh) {
        data = fresh;
        if (!(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0")) {
          writeJson(path, { fetched: at, seven_day: data });
        }
      }
    }
  }
  return toWeek(data, now);
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

type GoReading = { fetched: number; lastTry: number; data: Record<string, any> | null; history: [number, number][] };
const goReadings = new Map<string, GoReading>();
/** A week of 5-minute readings is about 2,000; the cap only guards a runaway file. */
const HISTORY_CAP = 4096;

/** Go supplies its actual weekly meter; local token totals only calibrate the burn estimate. */
export async function openCodeWeek(env: Env, now: Date, network: boolean): Promise<Week | null> {
  const source = new OpenCodeSource(env);
  const path = join(dirname(usageCachePath(env)), "opencode-usage.json");
  const key = source.base();
  const saved = readJson(path);
  const mine = saved?.source === key;
  const reading: GoReading = goReadings.get(key) ?? { fetched: saved?.fetched ?? 0, lastTry: 0,
    data: mine ? saved?.seven_day ?? null : null, history: mine ? savedHistory(saved) : [] };
  const at = now.getTime() / 1000;
  if (network && (!reading.data || at - reading.fetched >= REUSE_SECONDS) && at - reading.lastTry >= RETRY_SECONDS) {
    const auth = jsonAuth(source.readFile("auth.json"));
    // The login OpenCode itself uses (auth.json) owns the sessions we read, so it goes first. The
    // env key is another possible account: a fallback only, never the one that hides the login.
    const tokens = [...new Set([auth?.["opencode-go"]?.key, env.OPENCODE_API_KEY])]
      .filter((t): t is string => typeof t === "string" && t !== "");
    if (tokens.length) {
      reading.lastTry = at;
      goReadings.set(key, reading);
      for (const token of tokens) {
        try {
          const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
            headers: { Authorization: `Bearer ${token}`, "User-Agent": "token-furnace" },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) continue;
          const body = await response.json() as Record<string, any>;
          const weekly = body?.usage?.weekly;
          if (typeof weekly?.percent === "number" && Number.isFinite(weekly.percent) && weekly.percent >= 0) {
            const data = { utilization: weekly.percent, resets_at: weekly.resetsAt };
            // Within one week the meter only rises. A lower reading is another account (the env key
            // fallback) or a glitch, so it must not replace the plan's reading.
            const same = reading.data?.resets_at === data.resets_at;
            if (toWeek(data, now) && !(same && weekly.percent < reading.data!.utilization)) {
              // A new reset is a new week: its meter starts over.
              if (!same) reading.history = [];
              reading.history = [...reading.history, [now.getTime(), weekly.percent] as [number, number]].slice(-HISTORY_CAP);
              reading.data = data; reading.fetched = at;
              if (!(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0"))
                writeJson(path, { source: key, fetched: at, seven_day: data, history: reading.history });
            }
          }
          break;
        } catch { /* Keep the last unexpired reading when offline or rate limited. */ }
      }
    }
  }
  const week = toWeek(reading.data, now);
  if (!week) return null;
  const valid = reading.history.filter((r): r is [number, number] =>
    Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] >= week.start.getTime() && r[0] <= now.getTime());
  // Two processes can interleave their writes, and older files hold dips from the fallback account:
  // order by time and keep only readings that do not fall below an earlier one.
  let top = 0;
  const readings = valid.sort((a, b) => a[0] - b[0]).filter(r => r[1] >= top && ((top = r[1]), true));
  return { ...week, readings };
}

/** The saved meter. A file from before history existed still holds one reading: the last fetch. */
function savedHistory(saved: Record<string, any> | null): [number, number][] {
  if (Array.isArray(saved?.history)) return saved.history;
  const used = Number(saved?.seven_day?.utilization);
  const at = Number(saved?.fetched) * 1000;
  return Number.isFinite(used) && Number.isFinite(at) && at > 0 ? [[at, used]] : [];
}

function jsonAuth(text: string | null): Record<string, any> | null {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
