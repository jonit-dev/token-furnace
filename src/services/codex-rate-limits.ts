import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "../sources/agent-source";
import { usageCachePath, withId, type QuotaWindow } from "./usage-client";

/** Same cadence as the other quota clients: a reading is reused for 5 minutes, one call per minute. */
const REUSE_SECONDS = 300;
const RETRY_SECONDS = 60;
const TIMEOUT_MS = 10_000;

export interface CodexRateLimits {
  account: string | null;
  windows: QuotaWindow[];
}

interface CodexRaw {
  accountId: string | null;
  rateLimits: { primary: unknown; secondary: unknown };
}

const memory = new Map<string, { fetched: number; tried: number; raw: CodexRaw | null }>();

/** "10080" minutes becomes "7d", "300" becomes "5h". The label is what the budget meter measures its window by. */
function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * `account/rateLimits/read` response as separate windows (`openai:primary`, `openai:secondary`).
 * A window without a reset or a duration cannot be paced or calibrated, so it is skipped.
 */
export function parseCodexRateLimits(response: unknown, now: Date, observedAt: Date): CodexRateLimits {
  const body = (response && typeof response === "object" ? response : {}) as Record<string, any>;
  const account = typeof body.accountId === "string" && body.accountId.trim() ? body.accountId : null;
  const windows: QuotaWindow[] = [];
  for (const name of ["primary", "secondary"] as const) {
    const window = body.rateLimits?.[name];
    const used = Number(window?.usedPercent);
    const minutes = Number(window?.windowDurationMins);
    const resetsAt = Number(window?.resetsAt);
    if (!window || !Number.isFinite(used) || used < 0 || !Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(resetsAt)) continue;
    const resets = new Date(resetsAt * 1000);
    if (resets <= now) continue;
    const entry = withId(`openai:${name}`, {
      start: new Date(resets.getTime() - minutes * 60_000), resets, used, observedAt, window: windowLabel(minutes), account, authoritative: true,
    });
    if (entry) windows.push(entry);
  }
  return { account, windows };
}

/**
 * A fresh authoritative reading from the installed Codex app-server, or the saved one. With `network`
 * true, a reading older than 5 minutes triggers one `codex app-server` run, at most once a minute
 * across processes (the try time is saved). No Codex login or binary means no reading.
 */
export async function codexRateLimits(env: Env, now: Date, network: boolean): Promise<CodexRateLimits | null> {
  const at = now.getTime() / 1000;
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  const path = join(dirname(usageCachePath(env)), "codex-rate-limits.json");
  const noCache = Boolean(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0");
  const saved = readSaved(path, home);
  const state = memory.get(home) ?? { fetched: saved?.fetched ?? Number.NaN, tried: saved?.tried ?? 0, raw: saved?.raw ?? null };
  const stale = !state.raw || !Number.isFinite(state.fetched) || at - state.fetched >= REUSE_SECONDS;
  if (network && stale && at - Math.max(state.tried, saved?.tried ?? 0) >= RETRY_SECONDS) {
    state.tried = at;
    if (!noCache) writeSaved(path, home, state);
    const raw = await readAppServer(env, home);
    if (raw) {
      state.raw = raw;
      state.fetched = at;
      if (!noCache) writeSaved(path, home, state);
    }
  }
  memory.set(home, state);
  if (!state.raw) return null;
  const parsed = parseCodexRateLimits(state.raw, now, new Date(Number.isFinite(state.fetched) ? state.fetched * 1000 : 0));
  return parsed.windows.length ? parsed : null;
}

function readSaved(path: string, home: string): { fetched: number; tried: number; raw: CodexRaw | null } | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.home !== home) return null;
    return { fetched: Number(value.fetched), tried: Number(value.tried) || 0, raw: value.raw ?? null };
  } catch {
    return null;
  }
}

function writeSaved(path: string, home: string, state: { fetched: number; tried: number; raw: CodexRaw | null }): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ home, fetched: state.fetched, tried: state.tried, raw: state.raw }), { mode: 0o600 });
  } catch {
    // A cache we cannot write is a slow run, not a wrong one.
  }
}

/** initialize, initialized, account/rateLimits/read over the app-server's JSON-lines stdio. */
function readAppServer(env: Env, home: string): Promise<CodexRaw | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const child = spawn(env.TOKEN_FURNACE_CODEX_BIN || "codex", ["app-server"], {
      env: { ...process.env, ...env, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
    const finish = (value: CodexRaw | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.destroy();
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    const send = (message: Record<string, unknown>): void => { child.stdin?.write(`${JSON.stringify(message)}\n`); };
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdin?.on("error", () => finish(null));
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: Record<string, any>;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(null);
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2) {
          const result = message.result;
          if (message.error || !result?.rateLimits) return finish(null);
          // Keep only what the meter needs; the response also carries credit and reset-credit details.
          return finish({ accountId: typeof result.accountId === "string" ? result.accountId : null, rateLimits: { primary: result.rateLimits.primary ?? null, secondary: result.rateLimits.secondary ?? null } });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "token-furnace", version: "1" } } });
  });
}
