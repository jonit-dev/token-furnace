import { useCallback, useEffect, useState } from "react";
import type { ResetProduct, ResetsSnapshot } from "../../../src/services/resets-client";
import { Card } from "./ui";
import { clock, dayTime, pct, stamp, toDate } from "./format";

const POLL_MS = 300_000;
const FEED_HOME = "https://agentresets.com";
const live = location.protocol === "http:" || location.protocol === "https:";

/** Public reset announcements for the providers this report tracks. Nothing personal, no secrets. */
export function Resets() {
  const [snapshot, setSnapshot] = useState<ResetsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!live) return;
    try {
      const response = await fetch("/api/resets", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSnapshot((await response.json()) as ResetsSnapshot);
      setError(null);
    } catch {
      // The last feed stays on screen; the page says the refresh failed.
      setError("The reset feed could not be read from the server.");
    }
  }, []);

  useEffect(() => {
    void load();
    if (!live) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!live) return <p className="text-sm text-muted py-6">Start the live dashboard with token-furnace serve to read the reset feed.</p>;
  if (!snapshot) return <p className="text-sm text-muted py-6">{error ?? "Loading resets…"}</p>;

  const feed = snapshot.feed;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Global resets</h1>
        <p className="mt-1 text-sm text-muted">Extra usage from provider-wide resets. Your account limits follow their own schedule.</p>
      </div>
      <p className="text-[11px] text-muted">
        
        <a className="text-accent hover:underline" href={FEED_HOME} target="_blank" rel="noreferrer">Source: AgentResets</a>
        {feed?.generated_at ? ` · built ${stampOf(feed.generated_at)}` : ""}
        {snapshot.stale ? " · stale" : ""}
      </p>
      {error || snapshot.error ? (
        <p role="status" className="text-xs text-warn">{error ?? snapshot.error}</p>
      ) : null}
      {feed?.products.length ? (
        <div className="grid items-start gap-3 md:grid-cols-2">
          {feed.products.map((product) => <ProductCard key={product.id} product={product} now={Date.now()} />)}
        </div>
      ) : <p className="text-sm text-muted">No products in the feed yet.</p>}
      {feed?.attribution?.note ? (
        <p className="text-[11px] text-muted leading-4">
          {feed.attribution.note}
          {feed.attribution.sources.length ? (
            <> Sources: {feed.attribution.sources.flatMap((source, index) => {
              const url = httpUrl(source.url);
              return url ? [(
                <span key={source.url}>
                  {index ? ", " : ""}
                  <a className="text-accent hover:underline" href={url} target="_blank" rel="noreferrer">{source.name}</a>
                </span>
              )] : [];
            })}.</>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function ProductCard({ product, now }: { product: ResetProduct; now: number }) {
  const schedule = product.announced_schedule;
  const announced = schedule?.certainty === "announced";
  const due = announced && schedule ? Date.parse(schedule.scheduled_for) : 0;
  const probabilities = product.forecast?.probabilities ?? null;
  const methodUrl = httpUrl(product.forecast?.method_url);
  const officialUrl = httpUrl(schedule?.source_url);
  return (
    <Card title={product.name} sub={product.vendor} icon="CalendarDays">
      <p className={`text-base font-semibold ${announced ? "text-ok" : "text-ink"}`}>
        {announced && schedule ? `Announced ${stamp(schedule.scheduled_for)} · ${hoursLeft(due, now)}` : "No reset time announced"}
      </p>
      {officialUrl ? (
        <a className="mt-1 text-xs text-accent hover:underline" href={officialUrl} target="_blank" rel="noreferrer">Official announcement</a>
      ) : null}
      <div className="mt-5">
        <h3 className="text-xs text-muted">Estimated chance of a global reset</h3>
        <dl className="mt-2 grid grid-cols-3 gap-3">
          <Horizon label="Next 24 h" value={probabilities?.raw_24h ?? null} />
          <Horizon label="Next 48 h" value={probabilities?.raw_48h ?? null} />
          <Horizon label="Next 7 days" value={probabilities?.raw_7d ?? null} />
        </dl>
        <p className="mt-2 text-[11px] text-muted">
          Historical estimates, not scheduled resets.
          {methodUrl ? <> <a className="text-accent hover:underline" href={methodUrl} target="_blank" rel="noreferrer">How estimates work</a></> : null}
        </p>
      </div>
      <details className="mt-4 border-t border-line pt-3">
        <summary className="cursor-pointer text-xs text-muted hover:text-ink">Recent announcements ({product.events.length})</summary>
        {product.stats?.median_gap != null ? (
          <p className="mt-3 text-[11px] text-muted">Median gap between recorded resets: {product.stats.median_gap} days.</p>
        ) : null}
        <ul className="mt-3 space-y-3">
          {product.events.slice(0, 6).map((event) => (
            <li key={`${event.date}-${event.time ?? ""}-${event.kind}`} className="text-xs leading-5">
              <span className="text-muted">{event.date}{event.time ? ` ${clock(new Date(event.time))}` : ""}</span>
              <span className="mx-1.5 text-chip">·</span>
              <span className={event.kind === "banked" ? "text-bar" : "text-ink"}>{event.kind === "banked" ? "Banked reset" : "Reset"}</span>
              {event.summary ? <p className="mt-1 text-muted">{event.summary}</p> : null}
            </li>
          ))}
          {product.events.length === 0 ? <li className="text-xs text-muted">No announcements recorded.</li> : null}
        </ul>
      </details>
    </Card>
  );
}

function Horizon({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value === null ? "—" : pct(value)}</dd>
    </div>
  );
}

function hoursLeft(at: number, now: number): string {
  const hours = Math.max(0, Math.round((at - now) / 3_600_000));
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`;
}

/** Links render only for http(s) URLs; anything else is dropped, never rendered. */
function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function stampOf(iso: string): string {
  const date = toDate(iso);
  return Number.isNaN(date.getTime()) ? iso : dayTime(date);
}

