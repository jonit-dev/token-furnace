/**
 * Personal banked resets: how many unused reset credits sit in the local account and when each one
 * expires. Read-only by construction: the only calls here read a balance (Codex's own
 * `account/rateLimits/read` and Anthropic's usage field), and nothing consumes or redeems a credit.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CodexSource } from "../sources/codex";
import type { Env } from "../sources/agent-source";
import type { BankedResetGrant, BankedResetsSnapshot, ProviderBankedResets, Source } from "../core/model";
import { claudeBankedResets, count, soonest, usageCachePath } from "./usage-client";

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

/** The Codex reading lives next to usage.json. */
export function codexCachePath(env: Env): string {
  return join(dirname(usageCachePath(env)), "codex-banked-resets.json");
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

/** A reading, with the cache file's mtime so another process's newer reading is never missed. */
type Cache = { fetchedAt: number; triedAt: number; credits: unknown; error: string | null; mtimeMs: number };

/** One line of the cache file. The file is a map keyed by Codex home, so two homes never share a reading. */
type Saved = { fetchedAt?: unknown; triedAt?: unknown; credits?: unknown; error?: unknown };

/** The reading in this process, one per Codex home, and the read each home has open. */
const readings = new Map<string, Cache>();
const inflight = new Map<string, Promise<void>>();

/**
 * Codex's own reset credits, through its official local JSON-RPC (`account/rateLimits/read`), so
 * Codex handles its own login and Token Furnace never reads a bearer token. A saved reading is
 * reused for 5 minutes; a failed one is retried after a minute, and one read at a time is shared
 * by every caller. No Codex home on this machine means no spawn at all.
 */
export async function codexBankedResets(env: Env, now: Date, network: boolean, runner: CodexRunner = codexAppServer): Promise<ProviderBankedResets> {
  const base = new CodexSource(env).base();
  if (!existsSync(base)) return blank("codex app-server", "no_login", "No Codex login on this machine.");

  const path = codexCachePath(env);
  const entry = reading(base, path);
  const at = now.getTime();
  if (!network) return view(entry, now);
  let read = false;
  if (!inflight.has(base) && at - entry.triedAt >= (entry.error ? RETRY_MS : REUSE_MS)) {
    entry.triedAt = at;
    read = true;
    inflight.set(base, runner(env, base)
      .then((answer) => {
        // An answer without a credits block is not a reading: keep the last one and retry soon.
        const credits = block(answer);
        entry.credits = credits ?? entry.credits;
        entry.error = credits ? null : "Codex did not answer the rate-limit read.";
        entry.fetchedAt = credits ? at : entry.fetchedAt;
      })
      .catch(() => {
        entry.error = "Codex did not answer the rate-limit read.";
      })
      .finally(() => {
        inflight.delete(base);
      }));
  }
  await inflight.get(base); // this call's read, or the one already open
  const latest = read && !(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0") ? save(path, base, entry) : entry;
  return view(latest, now);
}

/**
 * The reading for one Codex home: this process's while the cache file is untouched, else the file.
 * A server and an MCP client share that file, so the older writer must see the newer reading.
 * ponytail: mtime + size, so two writes inside one millisecond can still miss; use a sequence file if it ever matters.
 */
function reading(base: string, path: string): Cache {
  const mtimeMs = mtimeOf(path);
  const known = readings.get(base);
  if (known && known.mtimeMs === mtimeMs) return known;
  const entry = fromFile(saved(path), base, mtimeMs);
  readings.set(base, entry);
  return entry;
}

/** This home's line in a cache file, or an empty reading when it has none yet. */
function fromFile(file: Record<string, any> | null, base: string, mtimeMs: number): Cache {
  const saved = (file?.[base] ?? null) as Saved | null;
  return {
    fetchedAt: count(saved?.fetchedAt),
    triedAt: count(saved?.triedAt),
    credits: saved?.credits ?? null,
    error: typeof saved?.error === "string" ? saved.error : null,
    mtimeMs,
  };
}

/** Epoch milliseconds as an ISO instant, or null when the value cannot be one. */
function instant(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function mtimeOf(path: string): number {
  try {
    const stat = statSync(path);
    return stat.mtimeMs + stat.size;
  } catch {
    return 0; // no cache file: nothing to reload
  }
}

/** The reading as the page uses it. A reading with no credits block yet is unavailable, not zero. */
function view(entry: Cache, now: Date): ProviderBankedResets {
  const fetchedAt = instant(entry.fetchedAt);
  const stale = entry.error !== null || !entry.fetchedAt || now.getTime() - entry.fetchedAt >= REUSE_MS;
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

/** The whole cache file: one line per Codex home. */
function saved(path: string): Record<string, any> | null {
  return readJson(path);
}

function readJson(path: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Save the reading and hand back what the caller should show. A file another process wrote with a
 * newer reading wins: its balance is not this call's to overwrite with one read before it.
 */
function save(path: string, base: string, entry: Cache): Cache {
  // One writer at a time: the read, the merge and the rename happen under a lock file, so a
  // refresh that started before another process's cannot publish its older balance over it.
  const lock = lockFile(path);
  if (lock === null) {
    // Another process is writing: its reading stands, so read the file again rather than the entry
    // this call has already changed in memory.
    readings.delete(base);
    return reading(base, path);
  }
  let latest = entry;
  try {
    const file = saved(path);
    // Belt and braces: even under the lock, a newer reading already on disk wins.
    if (count((file?.[base] as Saved | undefined)?.fetchedAt) > latest.fetchedAt) {
      latest = { ...fromFile(file, base, latest.mtimeMs), triedAt: latest.triedAt, error: latest.error };
    }
    persist(path, { ...file, [base]: { fetchedAt: latest.fetchedAt, triedAt: latest.triedAt, credits: latest.credits, error: latest.error } });
  } finally {
    closeSync(lock);
    try {
      unlinkSync(`${path}.lock`);
    } catch {
      // A lock we cannot remove is stale after a few seconds, and the next writer takes it then.
    }
  }
  latest.mtimeMs = mtimeOf(path); // what the next call compares against, written or not
  readings.set(base, latest);
  return latest;
}

/**
 * Hold the cache file for a moment. `O_EXCL` is atomic, so only one process gets the lock. A lock
 * left by a writer that died is taken over by renaming it away: rename is atomic and its target is
 * this process's own path, so two takers cannot both succeed and neither can delete a live lock.
 */
function lockFile(path: string): number | null {
  const lock = `${path}.lock`;
  try {
    mkdirSync(dirname(lock), { recursive: true });
    return openSync(lock, "wx");
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs < 5_000) return null; // a live writer
      const moved = `${lock}.${process.pid}.stale`;
      renameSync(lock, moved); // one winner; the loser gets ENOENT and backs off
      unlinkSync(moved);
      return openSync(lock, "wx");
    } catch {
      return null;
    }
  }
}

/**
 * Write the cache through a file of this process's own and rename it into place: a reader never
 * sees half a snapshot, and two writers cannot leave each other's tail bytes behind. Other homes'
 * lines in the file are kept as they were.
 */
function persist(path: string, file: Record<string, unknown>): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify(file));
    renameSync(temp, path);
  } catch {
    // A cache we cannot write is a slow refresh, not a wrong reading.
  }
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
