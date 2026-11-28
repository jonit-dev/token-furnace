/**
 * Personal banked resets: how many unused reset credits sit in the local account and when each one
 * expires. Read-only by construction: the only calls here read a balance (Codex's own
 * `account/rateLimits/read` and Anthropic's usage field), and nothing consumes or redeems a credit.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { CodexSource } from "../sources/codex";
import type { Env } from "../sources/agent-source";
import type { BankedResetGrant, BankedResetsSnapshot, ProviderBankedResets, Source } from "../core/model";
import { aged, bankedCachePath, claudeBankedResets, count, homeIdentity, millis, savedJson, saveJson, soonest, stampAt } from "./usage-client";

/** A reading is reused for 5 minutes, and a failed one is retried after a minute. */
const REUSE_MS = 300_000;
const RETRY_MS = 60_000;
/** A hung `codex app-server` must not hold a refresh open. */
const TIMEOUT_MS = 10_000;

/** The credit states Codex documents. Anything else is a schema this code cannot read. */
const STATUSES = new Set(["available", "redeeming", "redeemed", "unknown"]);

/** Providers with no banked-reset concept at all. No I/O, no spawn, no request. */
const UNSUPPORTED: Partial<Record<Source, string>> = {
  opencode: "OpenCode Go reports usage only, with no reset credits.",
  agy: "Google AI issues global resets rather than account credits.",
};

/** The Codex reading for one home: a file of its own, so no other home can touch it. */
export function codexCachePath(env: Env, base: string): string {
  return bankedCachePath(env, "codex", base);
}

/**
 * Every tracked provider's own reset credits. `network` false reads only what is already saved:
 * no subprocess, no request, nothing written.
 */
export async function bankedResetsSnapshot(env: Env, now: Date, network: boolean): Promise<BankedResetsSnapshot> {
  const [claude, codex] = await Promise.all([
    claudeBankedResets(env, now, network),
    codexBankedResets(env, now, network),
  ]);
  const providers: Partial<Record<Source, ProviderBankedResets>> = { claude, codex };
  for (const [source, note] of Object.entries(UNSUPPORTED) as [Source, string][]) {
    providers[source] = { source, availableCount: 0, nextExpiresAt: null, grants: [], fetchedAt: null, stale: false, state: "unsupported", note };
  }
  return { providers, fetchedAt: now.toISOString() };
}

/** What one `codex app-server` round-trip yields: the raw `rateLimitResetCredits` block. */
export type CodexRunner = (env: Env, base: string) => Promise<unknown | null>;

/** A reading: when it was fetched, when it was last attempted, and what came back. */
type Cache = { fetchedAt: number; triedAt: number; credits: unknown; error: string | null };

/** What the last completed read in this process produced, which --no-cache never writes down. */
const settled = new Map<string, Cache>();
const inflight = new Map<string, Promise<void>>();

/**
 * Codex's own reset credits, through its official local JSON-RPC (`account/rateLimits/read`), so
 * Codex handles its own login and Token Furnace never reads a bearer token. A saved reading is
 * reused for 5 minutes; a failed one is retried after a minute, and one read at a time is shared
 * by every caller. No Codex home on this machine means no spawn at all.
 */
export async function codexBankedResets(env: Env, now: Date, network: boolean, runner: CodexRunner = codexAppServer): Promise<ProviderBankedResets> {
  const configured = new CodexSource(env).base();
  // The configured path itself has to exist: `.../missing/..` names a directory that does, but the
  // path that was configured does not, and Codex could not read a login through it either.
  if (!existsSync(configured)) return blank("codex app-server", "no_login", "No Codex login on this machine.");
  const base = homeIdentity(configured); // one home, however it is spelled

  const path = codexCachePath(env, base);
  const at = now.getTime();
  // The gate sees the reading this process already has, so --no-cache cannot loop: a call it just
  // made (or just failed) is not repeated a second later.
  const saved = newest(base, reading(path, at), at);
  if (!network) return view(saved, now);
  // An attempt stamped in the future is an attempt that has just happened, so it gates like one.
  const tried = Math.min(saved.triedAt, at);
  // A balance with no usable stamp is not reusable either: it says nothing about when it was read.
  if (!inflight.has(base) && (aged(at, tried, saved.error ? RETRY_MS : REUSE_MS) || (!saved.error && !saved.fetchedAt))) {
    inflight.set(base, refresh(env, base, path, saved, at, runner).finally(() => inflight.delete(base)));
  }
  await inflight.get(base); // this call's read, or the one already open
  return view(newest(base, reading(path, at), at), now);
}

/**
 * One read of the balance, then the reading this process keeps: what came back, or the error that
 * it did not. A failed read keeps the last balance and is retried after a minute.
 */
async function refresh(env: Env, base: string, path: string, saved: Cache, at: number, runner: CodexRunner): Promise<void> {
  const entry: Cache = { ...saved, triedAt: at }; // this attempt, kept even when the read fails
  try {
    // An answer without a credits block is not a reading: keep the last one and retry soon.
    const credits = block(await runner(env, base));
    entry.credits = credits ?? entry.credits;
    entry.error = credits ? null : "Codex did not answer the rate-limit read.";
    entry.fetchedAt = credits ? at : entry.fetchedAt;
  } catch {
    entry.error = "Codex did not answer the rate-limit read.";
  }
  // One file per home, so the only other writer is a second refresh of this same account: a
  // reading the file already has that is at least as new as this one is what the caller shows.
  // An attempt is a reading too, so a slow failure cannot publish an older stamp over a newer one.
  const write = !(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0");
  const disk = reading(path, at);
  if (ahead(disk, entry)) {
    // The balance on disk is newer and stays. This attempt still happened, so it is worth recording —
    // unless the file already holds a later attempt, whose stamp a slow failure must not replace.
    const kept = entry.triedAt >= disk.triedAt ? { ...disk, triedAt: entry.triedAt, error: entry.error } : disk;
    if (write && kept !== disk) {
      saveJson(path, { source: "codex-app-server", fetchedAt: kept.fetchedAt, triedAt: kept.triedAt, credits: kept.credits, error: kept.error });
    }
    settled.set(base, kept);
    return;
  }
  if (write) {
    saveJson(path, { source: "codex-app-server", fetchedAt: entry.fetchedAt, triedAt: entry.triedAt, credits: entry.credits, error: entry.error });
  }
  settled.set(base, entry);
}

/**
 * The newer of what this process holds and what is on disk. A failed attempt is a reading too: it
 * has no new balance, but its `triedAt` is what keeps the next spawn on its one-minute gate.
 */
function newest(base: string, disk: Cache, now: number): Cache {
  const mine = settled.get(base);
  // A reading this process made under a clock that has since been corrected back is not "newer".
  if (!mine || mine.fetchedAt > now + 60_000 || mine.triedAt > now + 60_000) return disk;
  return ahead(mine, disk) ? mine : disk;
}

/** True when `a` is at least as new a reading as `b`: a later balance, or a later attempt at one. */
function ahead(a: Cache, b: Cache): boolean {
  return a.fetchedAt === b.fetchedAt ? a.triedAt >= b.triedAt : a.fetchedAt > b.fetchedAt;
}

/** This home's reading from its file, or an empty reading when it has none yet, or one from a clock
 * this process cannot compare with. */
function reading(path: string, now = Number.MAX_SAFE_INTEGER): Cache {
  const saved = savedJson(path);
  return {
    fetchedAt: stampAt(millis(saved?.fetchedAt), now, 60_000), // milliseconds
    triedAt: stampAt(millis(saved?.triedAt), now, 60_000),
    // A file is not trusted either: a cached block that a fresh answer would have been refused for
    // must not answer with a balance the page can count.
    credits: block(saved?.credits),
    error: typeof saved?.error === "string" ? saved.error : null,
  };
}

/** Epoch milliseconds as an ISO instant, or null when the value cannot be one. */
function instant(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The reading as the page uses it. A reading with no credits block yet is unavailable, not zero. */
function view(entry: Cache, now: Date): ProviderBankedResets {
  const fetchedAt = instant(entry.fetchedAt);
  const stale = entry.error !== null || aged(now.getTime(), entry.fetchedAt, REUSE_MS);
  const credits = entry.credits && typeof entry.credits === "object" ? (entry.credits as Record<string, any>) : null;
  if (!credits) {
    return { ...blank("codex app-server", "unavailable", entry.error ?? "No reset-credit reading yet."), fetchedAt, stale };
  }
  const grants = (Array.isArray(credits.credits) ? credits.credits : [])
    .flatMap((credit: unknown) => codexGrant(credit, now))
    .sort(soonest);
  const live = grants.filter((grant) => grant.status === "available");
  const next = live[0] ?? null;
  return {
    source: "codex app-server",
    // Rows are the truth: a cached count must not survive the credit it counted.
    availableCount: grants.length ? live.length : count(credits.availableCount),
    nextExpiresAt: next?.expiresAt ?? null,
    grants: grants.map((grant) => (grant === next ? { ...grant, next: true } : grant)),
    fetchedAt,
    stale,
    state: "ok",
    ...(entry.error ? { note: entry.error } : {}),
  };
}

/** One credit. Epoch seconds become ISO instants, and a credit past its expiry is `expired`. */
function codexGrant(value: unknown, now: Date): BankedResetGrant[] {
  const credit = value && typeof value === "object" ? (value as Record<string, any>) : null;
  const id = typeof credit?.id === "string" ? credit.id : "";
  if (!credit || !id) return [];
  const expiresAt = iso(credit.expiresAt);
  const expired = expiresAt !== null && Date.parse(expiresAt) <= now.getTime();
  return [{
    id,
    title: typeof credit.title === "string" && credit.title ? credit.title : "Reset credit",
    description: typeof credit.description === "string" ? credit.description : "",
    status: expired ? "expired" : typeof credit.status === "string" && credit.status ? credit.status : "unknown",
    remaining: 1, // one credit resets the limits once
    total: 1,
    scope: typeof credit.resetType === "string" ? credit.resetType : "",
    grantedAt: iso(credit.grantedAt),
    expiresAt,
  }];
}

/**
 * The `rateLimitResetCredits` block, or null when the answer is not one. A block whose `credits` is
 * neither a list nor an explicit null is a broken reading, not a balance of zero.
 */
function block(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const credits = value as Record<string, any>;
  if (typeof credits.availableCount !== "number" || !Number.isFinite(credits.availableCount)) return null;
  if (credits.credits === null) return credits;
  if (!Array.isArray(credits.credits)) return null;
  const readable = credits.credits.every((row: unknown) => {
    if (typeof row !== "object" || row === null) return false;
    const credit = row as Record<string, unknown>;
    // Without an id, a documented status and an expiry the row cannot be counted, so the answer is
    // not a balance: a credit nobody can date is not one the page may advertise.
    return typeof credit.id === "string" && credit.id !== "" &&
      typeof credit.status === "string" && STATUSES.has(credit.status) &&
      iso(credit.expiresAt) !== null;
  });
  return readable ? credits : null;
}

const EMPTY = { availableCount: 0, nextExpiresAt: null, grants: [] as BankedResetGrant[], fetchedAt: null, stale: false };

function blank(source: string, state: ProviderBankedResets["state"], note: string): ProviderBankedResets {
  return { ...EMPTY, source, state, note };
}

function iso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const at = new Date(value * 1000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * One read-only round-trip over Codex's stdio JSON-RPC: `initialize`, then `initialized`, then
 * `account/rateLimits/read`. The child is killed whatever happens, and a child that hangs or dies
 * reads as null rather than holding the caller.
 */
export function codexAppServer(env: Env, base: string, timeoutMs = TIMEOUT_MS): Promise<unknown | null> {
  return new Promise((done) => {
    const child = spawn("codex", ["app-server", "--stdio"], { env: { ...env, CODEX_HOME: base }, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let settled = false;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL"); // a child that ignores SIGTERM would outlive its reading
      done(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    const send = (message: unknown): void => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(null);
      }
    };
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null)); // a child that dies mid-handshake has no reading
    child.stdin.on("error", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const message = json(line);
        if (message?.id === 2) finish(message?.result?.rateLimitResetCredits ?? null);
        else if (message?.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "token-furnace", version: "0.1" } } });
  });
}

function json(line: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null; // the app-server also prints notices on this stream
  }
}
