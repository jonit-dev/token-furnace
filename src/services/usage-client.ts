import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AgySource } from "../sources/agy";
import { OpenCodeSource } from "../sources/opencode";
import type { Week } from "../core/model";
import type { Env } from "../sources/agent-source";
import type { BankedResetGrant, ProviderBankedResets, Source } from "../core/model";

/** A saved reading is reused for 5 minutes, and one call is tried per minute. burn.py:862 */
const REUSE_SECONDS = 300;
const RETRY_SECONDS = 60;

/** `cedar_ember` rides on the same call as `seven_day`: one request, no extra rate limit. */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";

/**
 * What this process knows about one cache file's account: the last call it made, one a minute so
 * a server does not burn the rate limit, the body that call returned, and the call still open. The
 * week and the credits both read it, so one request feeds both.
 */
type Call = {
  lastTry: number;
  at: number;
  body: Record<string, any> | null;
  banked: { at: number; block: unknown } | null;
  inflight: Promise<void> | null;
};
const calls = new Map<string, Call>();

function account(path: string): Call {
  const known = calls.get(path);
  if (known) return known;
  const fresh: Call = { lastTry: 0, at: 0, body: null, banked: null, inflight: null };
  calls.set(path, fresh);
  return fresh;
}

/** The saved reading, in the file burn.py writes and a status line can feed. */
export function usageCachePath(env: Env): string {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(base, "token-furnace", "usage.json");
}

/**
 * Where one provider home's reset-credit reading is kept. One file per home, named by a hash of it,
 * so a second home never shares a reading and two writers of the same home replace a whole
 * snapshot rather than merging into one file.
 */
export function bankedCachePath(env: Env, source: Source, home: string): string {
  const key = createHash("sha256").update(homeIdentity(home)).digest("hex").slice(0, 16);
  return join(dirname(usageCachePath(env)), "banked", `${source}-${key}.json`);
}

/**
 * One directory as one identity: symlinks followed when it exists, and resolved when it does not, so
 * `/profiles/current` and the account directory it points at are the same home and one cache file.
 */
export function homeIdentity(path: string): string {
  try {
    // `.native` hands the path to the operating system, which resolves `..` after following each
    // symlink; the JavaScript implementation can normalise `..` lexically and name another home.
    return realpathSync.native(path);
  } catch {
    return resolve(path); // no such directory yet: the spelling is all there is to go on
  }
}

/**
 * A shared cache file as an object. `usage.json` is a file a status line may keep, so a link to a
 * regular file is followed; a FIFO, directory or device under that name answers nothing at all.
 */
function readShared(path: string): Record<string, any> | null {
  try {
    if (!statSync(path).isFile()) return null; // a pipe with no writer would block the event loop
  } catch {
    return null;
  }
  return readJson(path);
}

/** A cache file as an object, or null when it is missing, unreadable, or a link to another file. */
export function savedJson(path: string): Record<string, any> | null {
  try {
    // This home's own regular file, or nothing: a link (or a pipe, or a directory, or a device)
    // under that name would answer for a file this program did not write.
    if (!lstatSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return readJson(path);
}

/** Replace a cache file in one step: a reader never sees half a snapshot. */
export function saveJson(path: string, file: Record<string, unknown>): void {
  // A name nothing can have prepared, opened with O_EXCL so a planted symlink or file at that path
  // fails the write instead of being followed. The rename then replaces whatever `path` names.
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 12)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify(file), { flag: "wx" });
    renameSync(temp, path);
  } catch {
    // A cache we cannot write is a slow refresh, not a wrong reading.
  }
}

/** The Claude home this process is about: one identity, so two spellings of one directory agree. */
function claudeHome(env: Env): string {
  return homeIdentity(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"));
}

/**
 * An explicit `CLAUDE_CONFIG_DIR` that names nothing, and is not the default home: `.../missing/..`
 * would otherwise read a neighbouring account. The default home is exempt, because the keychain can
 * hold the login with no `~/.claude` on disk at all.
 */
function missingHome(env: Env): boolean {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (!configured || existsSync(configured)) return false;
  // The default home is exempt only when it is named outright: `.../.claude/missing/..` resolves
  // there too, and would read the default profile through a path that does not exist.
  const defaultHome = join(env.HOME || homedir(), ".claude");
  const detour = configured.split(/[\\/]/).includes("..");
  return detour || resolve(configured) !== resolve(defaultHome);
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
  const call = account(claudeHome(env)); // one call per home, so a second profile cannot inherit it
  const saved = readShared(path);
  const savedAt = stampAt(saved?.fetched, at, 60); // seconds
  const stale = !saved?.seven_day || aged(at, savedAt, REUSE_SECONDS);
  if (network) {
    if (call.inflight) await call.inflight; // join the call this process already has open
    else if (stale && aged(at, call.lastTry, RETRY_SECONDS)) await refreshUsage(env, path, call, at);
  }
  // A reading from this process outranks the file it may not have written (--no-cache).
  const fresh = call.body && call.at >= savedAt ? call.body.seven_day : null;
  return toWeek(typeof fresh === "object" && fresh !== null ? fresh : saved?.seven_day ?? null, now);
}

/**
 * The one call to api.anthropic.com, shared by the week and the credits: at most one at a time,
 * and every caller waits for it. The token goes there and nowhere else, and a failed call keeps
 * the saved reading. No login on the machine means no call.
 */
function refreshUsage(env: Env, path: string, call: Call, at: number): Promise<void> {
  call.lastTry = at;
  // An explicit home that names nothing has no login, unless it is the default one (the keychain).
  if (missingHome(env)) return Promise.resolve();
  // Named before the request goes out: a CLAUDE_CONFIG_DIR that changes while this call waits must
  // not file one account's answer under another account's name.
  const credits = bankedCachePath(env, "claude", claudeHome(env));
  call.inflight = (async () => {
    const token = await accessToken(env);
    const fresh = token ? await fetchUsage(token) : null;
    if (!fresh) return;
    call.at = at;
    // The body is this process's reading of both halves: an answer that leaves the week out keeps
    // the one already held, exactly as the file writer keeps the one already saved.
    call.body = fresh.seven_day || !call.body?.seven_day ? fresh : { ...fresh, seven_day: call.body.seven_day };
    const block = fresh.cedar_ember ?? null;
    // A CLI version refusal can accompany valid quota data. Keep the previous credit reading.
    const creditsReadable = block?.ineligible_reason !== "cli_version";
    if (creditsReadable) call.banked = { at, block };
    const week = typeof fresh.seven_day === "object" && fresh.seven_day !== null ? fresh.seven_day : null;
    // When the answer omits the week the saved one is kept: one missing field must not throw away
    // the half it did carry. The credits ride on this answer and are saved by claudeBankedResets,
    // which is why this file stays exactly the shape a status line already writes.
    // The answer is a reading of both halves, so it saves both: a caller that only wanted the week
    // must not leave the credits it was handed unsaved for the next process to miss.
    if (!(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0")) {
      const saved = readShared(path);
      if (at >= stampAt(saved?.fetched, at, 60)) {
        const kept = week ?? saved?.seven_day;
        // The week is written to a file of ours, never through a link: deciding whether a link's
        // target is "really" a usage reading cannot be done safely, so it is not attempted.
        saveJson(path, {
          fetched: week ? at : seconds(saved?.fetched),
          ...(kept && typeof kept === "object" ? { seven_day: kept } : {}),
        });
      }
      // A reading another process made later than this one is not this call's to overwrite.
      if (creditsReadable && at >= stampAt(savedJson(credits)?.fetched, at, 60)) {
        saveJson(credits, { source: "claude-usage", fetched: at, block });
      }
    }
  })().finally(() => {
    call.inflight = null;
  });
  return call.inflight;
}

async function fetchUsage(token: string): Promise<Record<string, any> | null> {
  try {
    const response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", ...(await claudeAgent()) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, any>) : null;
  } catch {
    return null; // the endpoint rate-limits; the saved reading stays
  }
}

/**
 * Anthropic releases the personal reset credits only to Claude Code's own surface, so the call has
 * to name it. The version is read once per process, off the event loop: a wedged `claude` slows one
 * refresh, never a response. Without an install the request is the plain one and the credits read
 * as unavailable. The cache hangs off the global object so it survives a reloaded module: once per
 * process means once, however many times this file is evaluated.
 */
const AGENT_KEY = "__tokenFurnaceClaudeAgent";
let probes = 0;

function claudeAgent(): Promise<Record<string, string>> {
  const holder = globalThis as unknown as Record<string, Promise<Record<string, string>> | undefined>;
  if (holder[AGENT_KEY]) return holder[AGENT_KEY]!;
  let transient = false;
  const started = new Promise<Record<string, string>>((done) => {
    execFile("claude", ["--version"], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" }, (error, out) => {
      // Only a wedged `claude` is worth another look: an absent install, or one that answers with a
      // failure, is an answer this process should not pay for again.
      transient = Boolean(error) && (error as { killed?: boolean }).killed === true;
      const version = error ? null : /^(\d+\.\d+\.\d+)/.exec(String(out).trim())?.[1] ?? null;
      done(version ? { "User-Agent": `claude-cli/${version} (external, cli)` } : {});
    });
  });
  holder[AGENT_KEY] = started;
  // No `claude` on this machine is an answer, and stays one. A probe that failed or timed out is
  // not: asking again next time costs one `--version`, while remembering the failure would cost
  // this process every credit until it restarts.
  void started.then((header) => {
    // A probe that timed out is worth one more try, not one per refresh; anything else is answered.
    if (header["User-Agent"] || !transient || holder[AGENT_KEY] !== started) return;
    if (++probes < 2) delete holder[AGENT_KEY];
  });
  return started;
}

/**
 * The account's own reset credits: the `cedar_ember` block of the same usage call, kept in a file
 * of this Claude home's own. The saved reading answers, and with `network` true an aged one is
 * refreshed by that one call, so the credits never cost a second request and never break the week.
 * Never throws.
 */
export async function claudeBankedResets(env: Env, now: Date, network: boolean): Promise<ProviderBankedResets> {
  if (missingHome(env)) {
    return { source: "api.anthropic.com", availableCount: 0, nextExpiresAt: null, grants: [], fetchedAt: null, stale: false, state: "no_login", note: "No Claude login on this machine." };
  }
  const at = now.getTime() / 1000;
  const path = bankedCachePath(env, "claude", claudeHome(env));
  const call = account(claudeHome(env)); // the same call the week uses: one request feeds both
  if (network) {
    if (call.inflight) await call.inflight; // the same call this process already has open
    else if (aged(at, stampAt(savedJson(path)?.fetched, at, 60), REUSE_SECONDS) && aged(at, call.lastTry, RETRY_SECONDS)) {
      await refreshUsage(env, usageCachePath(env), call, at);
    }
  }
  // Compare against the file as it stands after the call, not before it: another process may have
  // published a later reading while this one waited, and that reading is not this call's to replace.
  // One read answers both the stamp and the block, so the two can never come from different files.
  const saved = savedJson(path);
  const savedAt = stampAt(saved?.fetched, at, 60); // seconds
  const current = call.banked;
  const fresh = current && current.at >= savedAt && current.at <= at + 60 ? current : null;
  // An answer with no block is a reading of no credits rather than a stale copy of the ones it had.
  const block = fresh ? fresh.block : saved?.block ?? undefined;
  const fetchedAt = fresh?.at ?? savedAt;
  try {
    return parseCedarEmber(block, now, fetchedAt);
  } catch {
    // An undocumented field that changes shape must cost the credits card, never the week.
    return parseCedarEmber(null, now, fetchedAt);
  }
}

/** What `clears` means to the page. An unknown key keeps its own name. */
const SCOPE = new Map([["seven_day", "Weekly limits"], ["seven_day_overage_included", "Weekly overage"]]);

/**
 * `cedar_ember` as the page uses it. Absent, malformed, or ineligible reads as unavailable and
 * never throws: this is an undocumented field, and a change to it must not touch the week.
 */
export function parseCedarEmber(value: unknown, now: Date, fetchedAt = 0): ProviderBankedResets {
  const root = value && typeof value === "object" ? (value as Record<string, any>) : null;
  const base: ProviderBankedResets = {
    source: "api.anthropic.com",
    availableCount: 0,
    nextExpiresAt: null,
    grants: [],
    fetchedAt: stamp(fetchedAt),
    stale: !fetchedAt || now.getTime() / 1000 - fetchedAt >= REUSE_SECONDS,
    state: "unavailable",
  };
  if (!root) return { ...base, note: "No personal reset credits reported." };
  if (root.eligible !== undefined && typeof root.eligible !== "boolean") {
    return { ...base, note: "The reset credits could not be read." }; // a string here would hide a balance
  }
  if (root.eligible === false) {
    return { ...base, note: text(root.ineligible_reason) ?? "This account has no personal reset credits." };
  }
  if (!Array.isArray(root.grants)) return { ...base, note: "No personal reset credits reported." };
  const grants = root.grants.flatMap((entry: unknown) => cedarGrant(entry, now)).sort(soonest);
  // A row this code cannot read is a changed schema, and it may hold the whole balance: the answer
  // is unavailable rather than the grants that happened to parse.
  if (grants.length !== root.grants.length) return { ...base, note: "The reset credits could not be read." };
  const live = grants.filter((grant) => grant.status === "available");
  const next = live[0];
  return {
    ...base,
    state: "ok",
    grants: grants.map((grant) => (grant === next ? { ...grant, next: true } : grant)),
    availableCount: live.reduce((sum, grant) => sum + grant.remaining, 0),
    nextExpiresAt: next?.expiresAt ?? null,
  };
}

function cedarGrant(value: unknown, now: Date): BankedResetGrant[] {
  const grant = value && typeof value === "object" ? (value as Record<string, any>) : null;
  const id = text(grant?.id);
  // Without the number of resets left, and Claude's own word on whether they can be spent, the row
  // carries no balance: the answer is not readable.
  const expiresAt = time(grant?.ends_at);
  if (!grant || !id || typeof grant.resets_left !== "number" || !(grant.resets_left >= 0) ||
    typeof grant.usable_now !== "boolean" || expiresAt === null) return [];
  const expired = expiresAt !== null && Date.parse(expiresAt) <= now.getTime();
  const remaining = count(grant.resets_left);
  const status = expired ? "expired"
    : grant.paused === true ? "paused"
      : grant.usable_now === true && remaining > 0 ? "available"
        : "unusable";
  return [{
    id,
    title: text(grant.label) ?? id,
    description: text(grant.unavailable_reason) ?? "",
    status,
    remaining,
    total: count(grant.resets_total),
    scope: (Array.isArray(grant.clears) ? grant.clears : [])
      .filter((key: unknown): key is string => typeof key === "string")
      .map((key: string) => SCOPE.get(key) ?? key)
      .join(" + "),
    grantedAt: time(grant.starts_at),
    expiresAt,
  }];
}

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** A credit's expiry order: the one that lapses first comes first, and no expiry comes last. */
export function soonest(a: Pick<BankedResetGrant, "expiresAt">, b: Pick<BankedResetGrant, "expiresAt">): number {
  return (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity);
}

/** Epoch seconds a cache file recorded, or 0 when the value is missing or is not a number. A corrupt
 * entry (`{"fetched": {"toString": null}}`) must read as "never fetched", not throw. */
/**
 * A stamp as this process may compare it: one from the future is another clock's, so it counts as
 * no stamp at all. A minute of skew is allowed, since two processes are rarely far apart.
 */
export function stampAt(value: unknown, now: number, skew: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value > now + skew ? 0 : value;
}

/** True when a reading is too old to reuse, or dated later than now: a clock skewed both ways ages. */
export function aged(now: number, stamp: number, window: number): boolean {
  return stamp <= 0 || stamp > now || now - stamp >= window;
}

/** A stamp in epoch seconds, or 0 when it is not one: a value no date can hold would never age. */
export function seconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8.64e12 ? value : 0;
}

/** A count the provider reported, or 0 when it is missing or nonsense. */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** A stamp in epoch milliseconds, or 0 when it is not one: a value no date can hold would never age. */
export function millis(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : 0;
}

/** Epoch seconds as an ISO instant, or null when the value cannot be one. A corrupt cache entry
 * (a timestamp of 1e20 reads as an invalid Date) must not throw out of a snapshot. */
export function stamp(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** An ISO instant the page can print, or null. */
const time = (value: unknown): string | null => {
  const stamp = text(value);
  return stamp && !Number.isNaN(Date.parse(stamp)) ? stamp : null;
};

/**
 * The Claude Code login token: the credentials file, else the macOS Keychain. burn.py:881
 * The keychain is a subprocess, so it runs off the event loop: a wedged one delays this refresh,
 * never a response the server is already holding.
 */
function accessToken(env: Env): Promise<string | null> {
  const home = claudeHome(env); // the same identity the credits are filed under
  try {
    return Promise.resolve(token(readFileSync(join(home, ".credentials.json"), "utf8")));
  } catch {
    // The keychain entry is not scoped to a home, so it only answers for the default one: reading it
    // for another profile would hand this home that account's credits.
    if (home !== homeIdentity(join(env.HOME || homedir(), ".claude"))) return Promise.resolve(null);
    return new Promise((done) => {
      execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 5_000 },
        (error, out) => done(error ? null : token(String(out))));
    });
  }
}

function token(creds: string): string | null {
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

type MeterReading = { fetched: number; lastTry: number; data: Record<string, any> | null; history: [number, number][] };
type MeterData = { utilization: number; resets_at: string };
const meterReadings = new Map<string, MeterReading>();
/** A week of 5-minute readings is about 2,000; the cap only guards a runaway file. */
const HISTORY_CAP = 4096;

/**
 * A plan that reports its own weekly meter (OpenCode Go, Google AI via agy). The reading and its
 * history live in `file` next to usage.json, keyed by `key` (the agent's data dir). `call` returns
 * null when there is no login (no network call), else a promise of the meter or null on failure.
 */
async function meterWeek(env: Env, now: Date, network: boolean, file: string, key: string,
  call: () => Promise<MeterData | null> | null): Promise<Week | null> {
  const path = join(dirname(usageCachePath(env)), file);
  const saved = readJson(path);
  const mine = saved?.source === key;
  const reading: MeterReading = meterReadings.get(path + key) ?? { fetched: seconds(saved?.fetched), lastTry: 0,
    data: mine ? saved?.seven_day ?? null : null, history: mine ? savedHistory(saved) : [] };
  const at = now.getTime() / 1000;
  if (network && (!reading.data || at - reading.fetched >= REUSE_SECONDS) && at - reading.lastTry >= RETRY_SECONDS) {
    const pending = call();
    if (pending) {
      reading.lastTry = at;
      meterReadings.set(path + key, reading);
      const data = await pending.catch(() => null); // offline or rate limited: keep the last reading
      // Within one week the meter only rises. A lower reading is another account (the env key
      // fallback) or a glitch, so it must not replace the plan's reading.
      const same = data && reading.data?.resets_at === data.resets_at;
      if (data && toWeek(data, now) && !(same && data.utilization < reading.data!.utilization)) {
        // A new reset is a new week: its meter starts over.
        if (!same) reading.history = [];
        reading.history = [...reading.history, [now.getTime(), data.utilization] as [number, number]].slice(-HISTORY_CAP);
        reading.data = data; reading.fetched = at;
        if (!(env.TOKEN_FURNACE_NO_CACHE && env.TOKEN_FURNACE_NO_CACHE !== "0"))
          writeJson(path, { source: key, fetched: at, seven_day: data, history: reading.history });
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

/** Go supplies its actual weekly meter; local token totals only calibrate the burn estimate. */
export function openCodeWeek(env: Env, now: Date, network: boolean): Promise<Week | null> {
  const source = new OpenCodeSource(env);
  return meterWeek(env, now, network, "opencode-usage.json", source.base(), () => {
    const auth = jsonAuth(source.readFile("auth.json"));
    // The login OpenCode itself uses (auth.json) owns the sessions we read, so it goes first. The
    // env key is another possible account: a fallback only, never the one that hides the login.
    const tokens = [...new Set([auth?.["opencode-go"]?.key, env.OPENCODE_API_KEY])]
      .filter((t): t is string => typeof t === "string" && t !== "");
    if (!tokens.length) return null;
    return (async () => {
      for (const token of tokens) {
        try {
          const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
            headers: { Authorization: `Bearer ${token}`, "User-Agent": "token-furnace" },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) continue;
          const weekly = ((await response.json()) as Record<string, any>)?.usage?.weekly;
          return typeof weekly?.percent === "number" && Number.isFinite(weekly.percent) && weekly.percent >= 0
            ? { utilization: weekly.percent, resets_at: weekly.resetsAt } : null;
        } catch { /* try the next token */ }
      }
      return null;
    })();
  });
}

/**
 * The Google AI plan's weekly meter: the most-used weekly group (Gemini, or Claude and GPT) that
 * agy's own `/usage` prints. It needs no model call; agy uses its own login, so no token leaves it.
 */
export function agyWeek(env: Env, now: Date, network: boolean): Promise<Week | null> {
  const base = new AgySource(env).base();
  return meterWeek(env, now, network, "agy-usage.json", base, () => {
    if (!existsSync(base)) return null; // no agy here
    return new Promise((done) => execFile("agy", ["-p", "/usage", "--print-timeout", "30s"], { timeout: 45_000 },
      (error, out) => done(error ? null : agyUsage(String(out)))));
  });
}

/** `/usage` rows are tab-separated: group, limit name, percent remaining, reset time. */
export function agyUsage(text: string): MeterData | null {
  return text.split("\n").map((line) => line.split("\t"))
    .filter((c) => c.length >= 4 && /weekly/i.test(c[1]) && /^\d+(\.\d+)?%$/.test(c[2].trim()))
    .map((c) => ({ utilization: 100 - parseFloat(c[2]), resets_at: c[3].trim() }))
    .sort((a, b) => b.utilization - a.utilization)[0] ?? null;
}

/** The saved meter. A file from before history existed still holds one reading: the last fetch. */
function savedHistory(saved: Record<string, any> | null): [number, number][] {
  if (Array.isArray(saved?.history)) return saved.history;
  const used = Number(saved?.seven_day?.utilization);
  const at = seconds(saved?.fetched) * 1000;
  return Number.isFinite(used) && Number.isFinite(at) && at > 0 ? [[at, used]] : [];
}

function jsonAuth(text: string | null): Record<string, any> | null {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
