/**
 * Notifications: the settings this machine sends from, the two channels it can send over, and the
 * conditions that decide when. Settings live in the user config directory with mode 0600; the seen
 * and delivered markers live in the cache directory, so a restart does not re-announce old resets.
 *
 * Nothing here sends while TOKEN_FURNACE_NO_SEND is set (or NODE_ENV=test, which the test
 * suite sets so a run stays off the network). An injected sender in tests bypasses that guard on
 * purpose, so both channels can be driven without reaching ntfy or Telegram. A withheld send is
 * reported as skipped, never as delivered, and never persisted as a delivery. A failed or
 * returned message never carries the destination URL or the token.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderId, Report, Source } from "../core/model";
import { kindOf } from "../core/providers";
import { isSessionSpike } from "../core/analyze/burn";
import { eventKey, type ResetsFeed, type ResetEvent } from "./resets-client";
import { usageCachePath } from "./usage-client";
import type { Env } from "../sources/agent-source";

export const LEAD_MIN = 1;
export const LEAD_MAX = 1440;
const SEND_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 120_000;
const RETRY_MAX = 3;
const SEEN_LIMIT = 300;

export interface NotificationSettings {
  /** The master switch. Off by default: nothing is sent until the user turns it on. */
  enabled: boolean;
  ntfy: { enabled: boolean; server: string; topic: string; token: string };
  telegram: { enabled: boolean; botToken: string; chatId: string };
  conditions: {
    newReset: boolean;
    sessionSpike: boolean;
    upcoming: boolean;
    /** How long before an announced reset time the reminder goes out. */
    leadMinutes: number;
    usage: { enabled: boolean; percent: number; provider: Source | "any" };
  };
}

export interface PublicSettings extends Omit<NotificationSettings, "ntfy" | "telegram"> {
  ntfy: NotificationSettings["ntfy"] & { hasToken: boolean };
  telegram: NotificationSettings["telegram"] & { hasToken: boolean };
}

export function defaultSettings(): NotificationSettings {
  return {
    enabled: false,
    ntfy: { enabled: false, server: "https://ntfy.sh", topic: "", token: "" },
    telegram: { enabled: false, botToken: "", chatId: "" },
    conditions: { newReset: true, sessionSpike: false, upcoming: true, leadMinutes: 60,
      usage: { enabled: false, percent: 80, provider: "any" } },
  };
}

export function settingsPath(env: Env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "token-furnace", "notifications.json");
}

function statePath(env: Env): string {
  return join(dirname(usageCachePath(env)), "notifications-state.json");
}

/** The saved settings, or the defaults. A file we cannot read is the defaults, never a crash. */
export function loadSettings(env: Env): NotificationSettings {
  const saved = object(readJson(settingsPath(env)));
  return saved ? mergeInto(defaultSettings(), saved).settings : defaultSettings();
}

/** Settings for the browser: the credentials are gone, only the fact that one is saved remains. */
export function publicSettings(settings: NotificationSettings): PublicSettings {
  return {
    enabled: settings.enabled,
    ntfy: { enabled: settings.ntfy.enabled, server: settings.ntfy.server, topic: settings.ntfy.topic,
      token: "", hasToken: settings.ntfy.token !== "" },
    telegram: { enabled: settings.telegram.enabled, chatId: settings.telegram.chatId,
      botToken: "", hasToken: settings.telegram.botToken !== "" },
    conditions: { ...settings.conditions, usage: { ...settings.conditions.usage } },
  };
}

/**
 * A submitted form over the saved settings. A blank secret field keeps what is saved; a channel only
 * turns on when it is complete. Returns the reason a field was refused, so the page can say it.
 */
export function mergeSettings(env: Env, raw: unknown): { settings: NotificationSettings; error: string | null } {
  return mergeInto(loadSettings(env), raw);
}

function mergeInto(saved: NotificationSettings, raw: unknown): { settings: NotificationSettings; error: string | null } {
  const input = object(raw) ?? {};
  const ntfy = object(input.ntfy);
  const telegram = object(input.telegram);
  const conditions = object(input.conditions);
  const usage = object(conditions?.usage);
  // One nested schema: {ntfy:{enabled,...}, telegram:{enabled,...}, conditions:{..., usage:{...}}}.
  const nested = (section: Record<string, unknown> | null, key: string, fallback: boolean): boolean =>
    typeof section?.[key] === "boolean" ? section[key] as boolean : fallback;
  const leadMinutes = bounded(conditions?.leadMinutes, saved.conditions.leadMinutes, LEAD_MIN, LEAD_MAX);
  const percent = bounded(usage?.percent, saved.conditions.usage.percent, 1, 100);
  const settings: NotificationSettings = {
    enabled: typeof input.enabled === "boolean" ? input.enabled as boolean : saved.enabled,
    ntfy: {
      enabled: nested(ntfy, "enabled", saved.ntfy.enabled),
      server: text(ntfy?.server, saved.ntfy.server, 200),
      topic: text(ntfy?.topic, saved.ntfy.topic, 100),
      token: input.removeNtfyToken === true ? "" : secret(ntfy?.token, saved.ntfy.token),
    },
    telegram: {
      enabled: nested(telegram, "enabled", saved.telegram.enabled),
      chatId: text(telegram?.chatId, saved.telegram.chatId, 40),
      botToken: input.removeTelegramToken === true ? "" : secret(telegram?.botToken, saved.telegram.botToken),
    },
    conditions: {
      newReset: nested(conditions, "newReset", saved.conditions.newReset),
      sessionSpike: nested(conditions, "sessionSpike", saved.conditions.sessionSpike),
      upcoming: nested(conditions, "upcoming", saved.conditions.upcoming),
      leadMinutes,
      usage: {
        enabled: nested(usage, "enabled", saved.conditions.usage.enabled),
        percent,
        provider: provider(usage?.provider, saved.conditions.usage.provider),
      },
    },
  };
  return { settings, error: validate(settings) };
}

/** Why these settings would not work, or null. Empty strings mean "not set", so they pass. */
export function validate(settings: NotificationSettings): string | null {
  if (!settings.enabled) return null;
  for (const channel of channels(settings)) {
    if (!channel.enabled) continue;
    const error = channel.problem();
    if (error) return error;
  }
  return null;
}

function channels(settings: NotificationSettings) {
  return [
    { name: "ntfy" as const, enabled: settings.ntfy.enabled, problem: () => ntfyError(settings.ntfy) },
    { name: "telegram" as const, enabled: settings.telegram.enabled, problem: () => telegramError(settings.telegram) },
  ];
}

function ntfyError(channel: NotificationSettings["ntfy"]): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(channel.topic)) return "The ntfy topic needs 1-64 letters, digits, - or _.";
  const error = urlError(channel.server);
  return error ? `ntfy server: ${error}` : null;
}

function telegramError(channel: NotificationSettings["telegram"]): string | null {
  // A bot token is digits, a colon, then the secret. Checked here, never echoed back.
  if (!/^\d{5,12}:[A-Za-z0-9_-]{30,60}$/.test(channel.botToken)) return "The Telegram bot token looks wrong.";
  if (!/^-?\d{5,20}$/.test(channel.chatId)) return "The Telegram chat id looks wrong.";
  return null;
}

/** https anywhere, http only on loopback, and never a URL that carries its own credentials. */
function urlError(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "needs to be a full URL.";
  }
  if (url.username || url.password) return "must not carry a username or password.";
  if (url.protocol === "https:") return null;
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol === "http:" && loopback) return null;
  return "needs https, or http on loopback for a self-hosted server.";
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

const text = (value: unknown, fallback: string, max: number): string =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value.trim() : fallback;

const secret = (value: unknown, fallback: string): string =>
  typeof value === "string" && value !== "" ? value.trim() : fallback;

const provider = (value: unknown, fallback: Source | "any"): Source | "any" =>
  value === "claude" || value === "codex" || value === "opencode" || value === "any" ? value : fallback;

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Write through a temporary file in the same directory, then rename. Mode 0600, never world readable. */
export function saveSettings(env: Env, settings: NotificationSettings): void {
  const path = settingsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export interface DeliveryResult {
  channel: "ntfy" | "telegram";
  ok: boolean;
  /** True when the send was withheld on purpose (test or development run). */
  skipped?: boolean;
  /** A short reason. It never carries the destination URL, the topic, or the token. */
  error: string | null;
}

export type Sender = (channel: "ntfy" | "telegram", title: string, message: string) => Promise<DeliveryResult>;

const suppressed = (env: Env): boolean =>
  (env.TOKEN_FURNACE_NO_SEND && env.TOKEN_FURNACE_NO_SEND !== "0") || env.NODE_ENV === "test";

/** Send one message over every enabled, configured channel. One failure never stops the other. */
export async function deliver(env: Env, settings: NotificationSettings, title: string, message: string,
  send?: Sender, only?: ("ntfy" | "telegram")[]): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  // An injected sender is a real channel the caller chose: only the built-in one is withheld here.
  if (send === undefined && suppressed(env)) {
    for (const channel of channels(settings)) if (channel.enabled) results.push({ channel: channel.name, ok: true, skipped: true, error: null });
    return results;
  }
  const via: Sender = send ?? ((name, subject, body) =>
    name === "ntfy" ? postNtfy(settings, subject, body) : postTelegram(settings, subject, body));
  for (const channel of channels(settings)) {
    if (!channel.enabled) continue;
    if (only && !only.includes(channel.name)) continue; // a retry reaches only the channels that missed it
    const problem = channel.problem();
    if (problem) {
      results.push({ channel: channel.name, ok: false, error: problem });
      continue;
    }
    try {
      results.push(await via(channel.name, title, message));
    } catch {
      results.push({ channel: channel.name, ok: false, error: `${channel.name} could not be reached.` });
    }
  }
  return results;
}

async function postNtfy(settings: NotificationSettings, title: string, message: string): Promise<DeliveryResult> {
  // ntfy's topic endpoint takes the message as the plain-text body; Title arrives as a header.
  const response = await fetch(`${settings.ntfy.server.replace(/\/+$/, "")}/${settings.ntfy.topic}`, {
    method: "POST",
    headers: {
      Title: title,
      "User-Agent": "token-furnace",
      ...(settings.ntfy.token ? { authorization: `Bearer ${settings.ntfy.token}` } : {}),
    },
    body: message,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  return { channel: "ntfy", ok: response.ok, error: response.ok ? null : `ntfy answered HTTP ${response.status}.` };
}

async function postTelegram(settings: NotificationSettings, title: string, message: string): Promise<DeliveryResult> {
  const response = await fetch(`https://api.telegram.org/bot${settings.telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "token-furnace" },
    body: JSON.stringify({ chat_id: settings.telegram.chatId, text: `${title}\n${message}` }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  // Telegram answers HTTP 200 with ok:false when it refuses, so the body decides.
  const body = await response.json().catch(() => null) as { ok?: boolean } | null;
  if (!response.ok) return { channel: "telegram", ok: false, error: `telegram answered HTTP ${response.status}.` };
  return body?.ok === true ? { channel: "telegram", ok: true, error: null }
    : { channel: "telegram", ok: false, error: "telegram did not accept the message." };
}

interface Marker {
  /** Channels that delivered this alert. A delivered channel is never asked again. */
  ok: ("ntfy" | "telegram")[];
  /** Channel name to its failure count and the last attempt, for a bounded retry. */
  fails: Record<string, { tries: number; at: number }>;
  /** The message, kept so a retry does not need the condition to fire again. */
  title: string;
  message: string;
}

interface NotifyState {
  /** False until the first feed is read: history seen then is a baseline, never an alert. */
  baseline: boolean;
  seen: string[];
  alerts: Record<string, Marker>;
  /** Per-provider arm: true until that provider's usage threshold fires, back to true below it. */
  usageArmed: Partial<Record<string, boolean>>;
}

const PENDING_LIMIT = 50;

const emptyState = (): NotifyState => ({ baseline: false, seen: [], alerts: {}, usageArmed: {} });

const armedOf = (state: NotifyState, source: string): boolean => state.usageArmed[source] !== false;

/** The instant an upcoming key reminds about. The ISO itself contains colons, so split after the product. */
function upcomingWhen(key: string): number {
  const rest = key.slice("upcoming:".length);
  const at = rest.indexOf(":");
  return at < 0 ? NaN : Date.parse(rest.slice(at + 1));
}

function readState(env: Env): NotifyState {
  const saved = object(readJson(statePath(env)));
  const state = emptyState();
  if (!saved) return state;
  state.baseline = saved.baseline === true;
  // Legacy single boolean (or missing) means every provider starts armed.
  if (typeof saved.usageArmed === "boolean" || saved.usageArmed === undefined) {
    if (saved.usageArmed !== false) state.usageArmed = {};
    else state.usageArmed = { claude: false, codex: false, opencode: false };
  } else {
    const arms = object(saved.usageArmed);
    for (const [key, value] of Object.entries(arms ?? {})) {
      if (value === false) state.usageArmed[key] = false;
    }
  }
  state.seen = Array.isArray(saved.seen) ? saved.seen.filter((key): key is string => typeof key === "string") : [];
  const alerts = object(saved.alerts);
  for (const [key, value] of Object.entries(alerts ?? {})) {
    const marker = object(value) as Marker | null;
    if (!marker) continue;
    state.alerts[key] = {
      ok: Array.isArray(marker.ok) ? marker.ok.filter((name) => name === "ntfy" || name === "telegram") as Marker["ok"] : [],
      fails: (object(marker.fails) ?? {}) as Marker["fails"],
      title: typeof marker.title === "string" ? marker.title : key,
      message: typeof marker.message === "string" ? marker.message : "",
    };
  }
  return state;
}

function writeState(env: Env, state: NotifyState): void {
  writeJson(statePath(env), state);
}

export interface Alert {
  key: string;
  title: string;
  message: string;
}

export interface AlertInput {
  now: Date;
  /** Null or a stale feed means no reset condition runs: an old announcement is not news. */
  feed: ResetsFeed | null;
  fresh: boolean;
  /** Subscription utilization per provider, the same number the report shows. */
  usage: Partial<Record<ProviderId, number | null>>;
  report?: Pick<Report, "active" | "burns"> | null;
  settings?: NotificationSettings | null;
  send?: Sender;
}

/**
 * The conditions, in order: new reset announcements, announced times inside the lead window, and a
 * usage crossing. Marks are written after the send, so a restart mid-flight retries rather than
 * loses the alert.
 */
export async function runAlerts(env: Env, input: AlertInput): Promise<{ alerts: Alert[]; delivered: DeliveryResult[] }> {
  const settings = input.settings ?? loadSettings(env);
  const state = readState(env);
  const candidates: Alert[] = [];
  // A feed whose own build time is clearly old is not news, even when the HTTP fetch just
  // succeeded: fetchedAt says when we asked, generated_at says when the source built it.
  const buildAt = input.feed?.generated_at ? Date.parse(input.feed.generated_at) : NaN;
  const buildStale = !input.feed || Number.isNaN(buildAt) || input.now.getTime() - buildAt > 24 * 3_600_000;
  const feed = input.fresh && !buildStale ? input.feed : null;

  if (feed) {
    for (const product of feed.products) {
      for (const event of product.events) {
        const key = `event:${eventKey(product.id, event)}`;
        if (state.seen.includes(key)) continue;
        if (!state.baseline) { // the first feed only records history
          state.seen.push(key);
          continue;
        }
        if (settings.conditions.newReset) {
          candidates.push({ key, title: `${product.name} reset announced`,
            message: `${event.date}${event.kind === "banked" ? " (banked credit)" : ""}` });
        }
        state.seen.push(key);
      }
      const schedule = product.announced_schedule;
      if (!settings.conditions.upcoming) continue;
      if (schedule && schedule.certainty === "announced" && Date.parse(schedule.scheduled_for) > input.now.getTime()) {
        const at = Date.parse(schedule.scheduled_for);
        const lead = input.now.getTime() + settings.conditions.leadMinutes * 60_000;
        if (lead >= at) {
          candidates.push({ key: `upcoming:${product.id}:${schedule.scheduled_for}`,
            title: `${product.name} reset due soon`,
            message: `Announced for ${schedule.scheduled_for}.` });
        }
      }
    }
    state.baseline = true;
  }
  // An announced time already past is over: drop its pending retry instead of re-sending it.
  for (const key of Object.keys(state.alerts)) {
    if (!key.startsWith("upcoming:")) continue;
    const when = upcomingWhen(key);
    if (!Number.isNaN(when) && when <= input.now.getTime()) delete state.alerts[key];
  }
  // A schedule that disappeared or was cancelled is over too: drop its pending retry.
  if (feed) {
    const live = new Set<string>();
    for (const product of feed.products) {
      const schedule = product.announced_schedule;
      if (schedule?.certainty === "announced" && Date.parse(schedule.scheduled_for) > input.now.getTime()) {
        live.add(`upcoming:${product.id}:${schedule.scheduled_for}`);
      }
    }
    for (const key of Object.keys(state.alerts)) {
      if (key.startsWith("upcoming:") && !live.has(key)) delete state.alerts[key];
    }
  }

  if (input.report) {
    const live = new Set<string>();
    if (settings.conditions.sessionSpike) {
      for (const session of input.report.active) {
        if (!isSessionSpike(session, input.report.burns[session.source])) continue;
        const key = `spike:${JSON.stringify([session.source, session.project, session.fullId || session.id])}`;
        live.add(key);
        candidates.push({ key, title: "Active session: critical burn spike",
          message: `${session.title || session.id} (${session.source}, ${session.id}) is burning ${Math.round(session.rate).toLocaleString("en-US")} tokens/h, above twice the ideal pace. Pause or finish this session.` });
      }
    }
    for (const key of Object.keys(state.alerts)) {
      if (key.startsWith("spike:") && !live.has(key)) delete state.alerts[key];
    }
  }

  const threshold = settings.conditions.usage.percent;
  const wanted = settings.conditions.usage.provider;
  if (settings.conditions.usage.enabled) {
    for (const [source, used] of Object.entries(input.usage)) {
      const kind = kindOf(source);
      if (!kind || (wanted !== "any" && wanted !== kind)) continue;
      if (typeof used !== "number" || !Number.isFinite(used)) continue;
      const key = `usage:${source}`;
      if (used < threshold) {
        state.usageArmed[source] = true; // back under the line: the next crossing is news again
        delete state.alerts[key];
        continue;
      }
      if (!armedOf(state, source)) continue;
      candidates.push({ key, title: `${source} usage ${Math.round(used)}%`,
        message: `Past the ${threshold}% threshold.` });
      state.usageArmed[source] = false;
      delete state.alerts[key];
    }
  }

  // An alert whose channel failed stays on the list until that channel gives up, so a condition
  // that only fires once (a new announcement) still gets its retry. Exhausted channels keep
  // their terminal count, so a later re-detection does not restart the retry.
  // A pending retry still needs its condition: a toggled-off condition stops its retries.
  for (const [key, marker] of Object.entries(state.alerts)) {
    if (candidates.some((alert) => alert.key === key)) continue;
    if (!Object.values(marker.fails).some((failure) => failure.tries < RETRY_MAX)) continue;
    if (key.startsWith("event:") && !settings.conditions.newReset) continue;
    if (key.startsWith("spike:")) continue; // only retry sessions still critical in this report
    if (key.startsWith("upcoming:") && !settings.conditions.upcoming) continue;
    if (key.startsWith("usage:")) {
      if (!settings.conditions.usage.enabled) continue;
      const source = key.slice("usage:".length);
      if (wanted !== "any" && wanted !== source) continue;
    }
    candidates.push({ key, title: marker.title ?? key, message: marker.message ?? "" });
  }

  state.seen = state.seen.slice(-SEEN_LIMIT);
  const delivered: DeliveryResult[] = [];
  if (settings.enabled && candidates.length > 0) {
    for (const alert of candidates) {
      const marker = state.alerts[alert.key] ?? { ok: [], fails: {}, title: alert.title, message: alert.message };
      const pending = ["ntfy", "telegram"] as const;
      const due = pending.filter((name) => {
        if (marker.ok.includes(name)) return false; // delivered already: never twice
        const failure = marker.fails[name];
        if (!failure) return true;
        return failure.tries < RETRY_MAX && input.now.getTime() - failure.at >= RETRY_BASE_MS * failure.tries;
      });
      if (due.length === 0) { state.alerts[alert.key] = marker; continue; }
      const results = await deliver(env, settings, alert.title, alert.message, input.send, due);
      for (const result of results) {
        if (result.skipped) {
          // Withheld on purpose: reported, never stored as a delivery or a failure.
        } else if (result.ok) {
          if (!marker.ok.includes(result.channel)) marker.ok.push(result.channel);
          delete marker.fails[result.channel];
        } else {
          const failure = marker.fails[result.channel] ?? { tries: 0, at: 0 };
          marker.fails[result.channel] = { tries: failure.tries + 1, at: input.now.getTime() };
        }
        delivered.push(result);
      }
      marker.title = alert.title;
      marker.message = alert.message;
      state.alerts[alert.key] = marker;
    }
    // Bounded pending: the oldest retries leave first, so one storm cannot grow the file.
    const keys = Object.keys(state.alerts);
    for (const key of keys.slice(0, Math.max(0, keys.length - PENDING_LIMIT))) delete state.alerts[key];
  }
  writeState(env, state);
  return { alerts: candidates, delivered };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  } catch {
    // A state file we cannot write costs a duplicate alert, never a lost settings file.
  }
}

/** The recent history lines the notifications tab shows next to the saved settings. */
export function recentEvents(feed: ResetsFeed | null, limit = 5): { product: string; event: ResetEvent }[] {
  const rows: { product: string; event: ResetEvent }[] = [];
  for (const product of feed?.products ?? []) {
    for (const event of product.events.slice(0, limit)) rows.push({ product: product.name, event });
  }
  return rows.sort((a, b) => b.event.date.localeCompare(a.event.date)).slice(0, limit);
}
