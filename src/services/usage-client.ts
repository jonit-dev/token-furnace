import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** One quota window with the id its budget meter uses, for example `anthropic:5h`. */
export type QuotaWindow = Week & { id: string };

/** The subscription window plus the cache observation metadata used by Auto admission. */
export async function planReading(env: Env, now: Date, network: boolean): Promise<Week | null> {
  const plan = await loadPlan(env, now, network);
  return toWeek(plan.sevenDay, now, plan.observedAt, plan.account);
}

/** Every window the usage endpoint supplies (7-day and 5-hour), each its own meter. */
export async function planWindows(env: Env, now: Date, network: boolean): Promise<QuotaWindow[]> {
  const plan = await loadPlan(env, now, network);
  return [
    withId("anthropic:7d", toWeek(plan.sevenDay, now, plan.observedAt, plan.account)),
    withId("anthropic:5h", toWeek(plan.fiveHour, now, plan.observedAt, plan.account, "5h", 5 * 3_600_000)),
  ].filter((window): window is QuotaWindow => window !== null);
}

export function withId(id: string, week: Week | null): QuotaWindow | null {
  return week ? { ...week, id } : null;
}

async function loadPlan(env: Env, now: Date, network: boolean) {
  const at = now.getTime() / 1000;
  const path = usageCachePath(env);
  const saved = readJson(path);
  let data = saved?.seven_day ?? null;
  let fiveHour = saved?.five_hour ?? null;
  let observedAt = finiteEpoch(saved?.fetched);
  let account = typeof saved?.account === "string" ? saved.account : null;
  const stale = !data || at - (saved?.fetched ?? 0) >= REUSE_SECONDS;
  if (network && stale && at - lastTry >= RETRY_SECONDS) {
    const credentials = accessCredentials(env);
    if (credentials?.token) {
      lastTry = at;
      const fresh = await fetchPlan(credentials.token);
      if (fresh) {
        data = fresh.seven_day;
        fiveHour = fresh.five_hour;
        observedAt = at;
        account = credentials.account;
        if (!(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0")) {
          writeJson(path, { fetched: at, account, window: "7d", seven_day: data, five_hour: fiveHour });
        }
      }
    }
  }
  return { sevenDay: data as Record<string, any> | null, fiveHour: fiveHour as Record<string, any> | null, observedAt, account: account ?? claudeAccount(env) };
}

async function fetchPlan(token: string): Promise<{ seven_day: Record<string, any>; five_hour: Record<string, any> | null } | null> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, any>;
    if (typeof body?.seven_day !== "object" || body.seven_day === null) return null;
    return { seven_day: body.seven_day, five_hour: typeof body.five_hour === "object" ? body.five_hour : null };
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
    return { token, account: typeof account === "string" ? account : claudeAccount(env) };
  } catch {
    return null;
  }
}

/**
 * The signed-in Claude account: `oauthAccount.accountUuid` in Claude Code's own `.claude.json`, which sits in
 * CLAUDE_CONFIG_DIR when that is set, else in the home directory. The credentials file does not carry it.
 */
export function claudeAccount(env: Env): string | null {
  const home = env.HOME || homedir();
  for (const path of [env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : null, join(home, ".claude.json")]) {
    if (!path) continue;
    const uuid = readJson(path)?.oauthAccount?.accountUuid;
    if (typeof uuid === "string" && uuid.trim()) return uuid;
  }
  return null;
}

/** The endpoint's reading as a Week: epoch seconds or an ISO string, and only while it runs. */
function toWeek(data: Record<string, any> | null, now: Date, observedSeconds = Number.NaN, account: string | null = null, window = "7d", windowMs = 7 * 86_400_000): Week | null {
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
    start: new Date(resets.getTime() - windowMs), resets, used,
    observedAt: new Date(Number.isFinite(observedSeconds) ? observedSeconds * 1000 : 0), window, account, authoritative: true,
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

/**
 * The OpenCode Go credential this machine uses and its account identity: an explicit account id when the
 * auth file has one, else `go-key:` plus the first 16 hex of the key's SHA-256. The key itself is never kept.
 */
export function openCodeCredential(env: Env): { token: string; account: string } | null {
  const providerAuth = jsonAuth(new OpenCodeSource(env).readFile("auth.json"))?.["opencode-go"];
  const token = env.OPENCODE_API_KEY || providerAuth?.key;
  if (typeof token !== "string" || !token) return null;
  const explicit = providerAuth?.accountId ?? providerAuth?.account ?? providerAuth?.id;
  const account = typeof explicit === "string" && explicit.trim() ? explicit : `go-key:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  return { token, account };
}

/** Go windows beyond the weekly one, by the key Go uses; lengths are what the meter calibrates over. */
const GO_EXTRA_WINDOWS: Record<string, { window: string; ms: number }> = {
  rolling: { window: "5h", ms: 5 * 3_600_000 },
  monthly: { window: "30d", ms: 30 * 86_400_000 },
};

type GoReading = { fetched: number; lastTry: number; account: string | null; data: Record<string, any> | null; extra: Record<string, Record<string, any>> };
const goReadings = new Map<string, GoReading>();

/** Go supplies its actual weekly meter; local token totals only calibrate the burn estimate. */
export async function openCodeWeek(env: Env, now: Date, network: boolean): Promise<Week | null> {
  const reading = await loadGo(env, now, network);
  return toWeek(reading.data, now, reading.fetched, reading.account);
}

/** The weekly window plus any rolling or monthly window Go supplies, each its own meter. */
export async function openCodeWindows(env: Env, now: Date, network: boolean): Promise<QuotaWindow[]> {
  const reading = await loadGo(env, now, network);
  return [
    withId("opencode-go:weekly", toWeek(reading.data, now, reading.fetched, reading.account)),
    ...Object.entries(GO_EXTRA_WINDOWS).map(([key, { window, ms }]) =>
      withId(`opencode-go:${key}`, toWeek(reading.extra[key] ?? null, now, reading.fetched, reading.account, window, ms))),
  ].filter((entry): entry is QuotaWindow => entry !== null);
}

/**
 * Go's usage body, as recorded from the live endpoint:
 * `{ usage: { rolling|weekly|monthly: { status: "ok", percent: <0-100 number>, resetsAt: <ISO string> } } }`.
 * The weekly window is required, the others are kept when present.
 */
export function parseGoUsage(body: unknown): { weekly: Record<string, any>; extra: Record<string, Record<string, any>> } | null {
  const usage = (body as { usage?: Record<string, any> } | null)?.usage;
  const window = (key: string): Record<string, any> | null => {
    const entry = usage?.[key];
    return typeof entry?.percent === "number" && Number.isFinite(entry.percent) && entry.percent >= 0
      ? { utilization: entry.percent, resets_at: entry.resetsAt } : null;
  };
  const weekly = window("weekly");
  if (!weekly) return null;
  const extra: Record<string, Record<string, any>> = {};
  for (const key of Object.keys(GO_EXTRA_WINDOWS)) {
    const entry = window(key);
    if (entry) extra[key] = entry;
  }
  return { weekly, extra };
}

async function loadGo(env: Env, now: Date, network: boolean): Promise<GoReading> {
  const source = new OpenCodeSource(env);
  const path = join(dirname(usageCachePath(env)), "opencode-usage.json");
  const key = source.base();
  const saved = readJson(path);
  const reading: GoReading = goReadings.get(key) ?? { fetched: saved?.fetched ?? Number.NaN, lastTry: 0,
    account: typeof saved?.account === "string" ? saved.account : null,
    data: saved?.source === key ? saved?.seven_day ?? null : null,
    extra: saved?.source === key && saved?.extra && typeof saved.extra === "object" ? saved.extra : {} };
  const at = now.getTime() / 1000;
  const credential = openCodeCredential(env);
  if (credential) {
    // A reading belongs to the credential that fetched it; another key's reading must not be reused.
    if (reading.account !== null && reading.account !== credential.account) { reading.data = null; reading.extra = {}; }
    reading.account = credential.account;
  }
  if (network && (!reading.data || at - reading.fetched >= REUSE_SECONDS) && at - reading.lastTry >= RETRY_SECONDS) {
    const token = credential?.token;
    if (typeof token === "string" && token) {
      reading.lastTry = at;
      goReadings.set(key, reading);
      try {
        const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "token-furnace" },
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const parsed = parseGoUsage(await response.json());
          if (parsed) {
            const data = parsed.weekly;
            if (toWeek(data, now)) {
              reading.data = data; reading.fetched = at;
              reading.extra = parsed.extra;
              if (!(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0"))
                writeJson(path, { source: key, fetched: at, account: reading.account, window: "7d", seven_day: data, extra: reading.extra });
            }
          }
        }
      } catch { /* Keep the last unexpired reading when offline or rate limited. */ }
    }
  }
  return reading;
}

function jsonAuth(text: string | null): Record<string, any> | null {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
