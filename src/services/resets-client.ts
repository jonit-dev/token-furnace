/**
 * The public reset feed: agentresets.com/api/v1/resets.json. One fetch per 5 minutes, shared by every
 * caller, validated before it leaves this file. A failed fetch keeps the last good feed and marks it
 * stale, so the page and the alert conditions both say the data is old.
 */

export const FEED_SOURCE = "https://agentresets.com";
const FEED_URL = `${FEED_SOURCE}/api/v1/resets.json`;
const REUSE_MS = 300_000;
const RETRY_MS = 300_000;
const TIMEOUT_MS = 8_000;

export interface ResetEvent {
  date: string;
  /** The exact ISO instant, or null for an archive entry with only a day. */
  time: string | null;
  kind: "regular" | "banked";
  summary: string;
  delivered_at?: string;
  delivered_source?: string;
  delivery_note?: string;
}

export interface ResetStats {
  total: number | null;
  last_date: string | null;
  last30d: number | null;
  median_gap: number | null;
  max_gap: number | null;
  banked_total: number;
  unavailable: boolean;
}

export interface ResetForecast {
  probabilities: { raw_24h: number | null; raw_48h: number | null; raw_7d: number | null } | null;
  hours_since_last: number | null;
  model: string | null;
  method_url: string | null;
  unavailable: boolean;
}

export interface ResetSchedule {
  scheduled_for: string;
  announced_at: string | null;
  source_url: string | null;
  certainty: string;
}

export interface ResetProduct {
  id: string;
  name: string;
  vendor: string;
  events: ResetEvent[];
  stats: ResetStats | null;
  forecast: ResetForecast | null;
  announced_schedule: ResetSchedule | null;
}

export interface ResetAttribution {
  note: string | null;
  cutoff_date: string | null;
  sources: { name: string; url: string }[];
}

export interface ResetsFeed {
  schema_version: number;
  generated_at: string | null;
  source: string;
  attribution: ResetAttribution | null;
  products: ResetProduct[];
}

export interface ResetsSnapshot {
  feed: ResetsFeed | null;
  /** When the feed was last fetched from the source. */
  fetchedAt: string | null;
  /** True when the feed on hand is older than the cache window or the last fetch failed. */
  stale: boolean;
  error: string | null;
  source: string;
}

type Cache = { feed: ResetsFeed | null; fetchedAt: number; triedAt: number; error: string | null };

let cache: Cache | null = null;
let inflight: Promise<ResetsFeed | null> | null = null;

/** The validated feed, from the shared cache or one network fetch. Never throws. */
export async function resetsSnapshot(now: Date = new Date()): Promise<ResetsSnapshot> {
  const at = now.getTime();
  const gate = cache?.error ? RETRY_MS : REUSE_MS;
  if (cache && at - cache.triedAt < gate) return view(cache, at);
  inflight ??= load().finally(() => { inflight = null; });
  const feed = await inflight;
  const fresh = feed ? { feed, fetchedAt: at, triedAt: at, error: null } : keep(cache, at);
  cache = fresh;
  return view(fresh, at);
}

/** The same snapshot without waiting on the network: what a request answers with. */
export function cachedResets(now: Date = new Date()): ResetsSnapshot {
  return view(cache ?? { feed: null, fetchedAt: 0, triedAt: 0, error: null }, now.getTime());
}

/** Drop the shared cache. A test and a source switch use it; nothing else. */
export function forgetResets(): void {
  cache = null;
  inflight = null;
}

async function load(): Promise<ResetsFeed | null> {
  try {
    const response = await fetch(FEED_URL, {
      headers: { accept: "application/json", "User-Agent": "token-furnace" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseFeed(await response.json());
  } catch {
    return null; // offline, timed out, or a body we cannot read: the old feed stays
  }
}

function keep(previous: Cache | null, at: number): Cache {
  return { feed: previous?.feed ?? null, fetchedAt: previous?.fetchedAt ?? 0, triedAt: at,
    error: "The reset feed could not be refreshed." };
}

function view(entry: Cache, at: number): ResetsSnapshot {
  const age = at - entry.fetchedAt;
  return {
    feed: entry.feed,
    fetchedAt: entry.fetchedAt ? new Date(entry.fetchedAt).toISOString() : null,
    stale: entry.error !== null || entry.fetchedAt === 0 || age >= REUSE_MS,
    error: entry.error,
    source: FEED_SOURCE,
  };
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** An ISO string that Date can read, or null. A date we cannot parse is dropped, never guessed. */
function iso(value: unknown): string | null {
  const text = str(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

/** A 0..1 fraction, or null. Values outside the range are dropped, not clamped. */
function fraction(value: unknown): number | null {
  const parsed = num(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The feed as this app uses it, or null when the body is not the documented shape. */
export function parseFeed(body: unknown): ResetsFeed | null {
  const root = object(body);
  const products = object(root?.products);
  if (!root || !products) return null;
  if (num(root.schema_version) !== 1) return null; // a breaking change ships as /v2, not as this path
  const parsed: ResetProduct[] = [];
  for (const [id, value] of Object.entries(products)) {
    const product = object(value);
    if (!product) continue;
    const schedule = object(product.announced_schedule);
    const scheduled = schedule ? iso(schedule.scheduled_for) : null;
    const stats = object(product.stats);
    const forecast = object(product.forecast);
    const probabilities = object(forecast?.probabilities);
    const three = probabilities
      ? { raw_24h: fraction(probabilities.raw_24h), raw_48h: fraction(probabilities.raw_48h),
          raw_7d: fraction(probabilities.raw_7d) }
      : null;
    parsed.push({
      id,
      name: str(product.name) ?? id,
      vendor: str(product.vendor) ?? "",
      events: Array.isArray(product.events) ? product.events.flatMap(parseEvent) : [],
      stats: stats ? {
        total: num(stats.total), last_date: iso(stats.last_date), last30d: num(stats.last30d),
        median_gap: num(stats.median_gap), max_gap: num(stats.max_gap),
        banked_total: num(stats.banked_total) ?? 0, unavailable: stats.unavailable === true,
      } : null,
      forecast: forecast ? {
        probabilities: probabilities && three ? three : null,
        hours_since_last: num(forecast.hours_since_last),
        model: str(forecast.model),
        method_url: str(forecast.method_url),
        unavailable: forecast.unavailable === true,
      } : null,
      announced_schedule: schedule && scheduled ? {
        scheduled_for: scheduled,
        announced_at: iso(schedule.announced_at),
        source_url: str(schedule.source_url),
        certainty: str(schedule.certainty) ?? "announced",
      } : null,
    });
  }
  const attribution = object(root.attribution);
  return {
    schema_version: 1,
    generated_at: iso(root.generated_at),
    source: str(root.source) ?? FEED_SOURCE,
    attribution: attribution ? {
      note: str(attribution.note),
      cutoff_date: iso(attribution.cutoff_date),
      sources: Array.isArray(attribution.sources) ? attribution.sources.flatMap((entry) => {
        const item = object(entry);
        const name = item ? str(item.name) : null;
        const url = item ? str(item.url) : null;
        return name && url ? [{ name, url }] : [];
      }) : [],
    } : null,
    products: parsed,
  };
}

function parseEvent(value: unknown): ResetEvent[] {
  const event = object(value);
  const date = iso(event?.date);
  if (!event || !date) return [];
  const kind = event.kind === "banked" ? "banked" : "regular";
  return [{
    date,
    time: iso(event.time),
    kind,
    summary: str(event.summary) ?? "",
    ...(iso(event.delivered_at) ? { delivered_at: String(iso(event.delivered_at)) } : {}),
    ...(str(event.delivered_source) ? { delivered_source: String(str(event.delivered_source)) } : {}),
    ...(str(event.delivery_note) ? { delivery_note: String(str(event.delivery_note)) } : {}),
  }];
}

/** One reset event, stable across fetches: the same day, kind, and instant. */
export function eventKey(productId: string, event: ResetEvent): string {
  return `${productId}|${event.date}|${event.time ?? ""}|${event.kind}`;
}