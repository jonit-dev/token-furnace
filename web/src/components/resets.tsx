import { useCallback, useEffect, useState } from "react";
import type { ResetProduct, ResetsSnapshot } from "../../../src/services/resets-client";
import type { BankedResetGrant, BankedResetsSnapshot, ProviderBankedResets, Source } from "../../../src/core/model";
import { Card } from "./ui";
import { clock, dayTime, pct, stamp, toDate } from "./format";

const POLL_MS = 300_000;
const FEED_HOME = "https://agentresets.com";
/** A credit this close to lapsing is worth a warning. */
const SOON_MS = 7 * 86_400_000;
/** A served page may talk to its server; a file: snapshot carries what it was built with. */
const isLive = (): boolean => location.protocol === "http:" || location.protocol === "https:";

/** The providers that hold personal credits, in the order the page shows them. */
const BANKED: Source[] = ["claude", "codex"];

/** The provider's own words for a credit's scope, where the server passes them through. */
const SCOPE_LABEL = new Map([["codexRateLimits", "Weekly limits"]]);

/** A credit the page can still spend: the provider called it available and its own expiry has not passed. */
function spendable(grant: BankedResetGrant, now: number): boolean {
  return grant.status === "available" && (!grant.expiresAt || Date.parse(grant.expiresAt) > now);
}

/** What a provider still holds, read off its rows when it has them: a saved snapshot can outlive a credit. */
export function held(provider: ProviderBankedResets | undefined, now = Date.now()): { count: number; nextExpiresAt: string | null } {
  if (!provider || provider.state !== "ok") return { count: 0, nextExpiresAt: null };
  if (!provider.grants.length) return { count: provider.availableCount, nextExpiresAt: provider.nextExpiresAt };
  const live = provider.grants.filter((grant) => spendable(grant, now))
    .sort((a, b) => Date.parse(a.expiresAt ?? "") - Date.parse(b.expiresAt ?? ""));
  // A grant can carry more than one reset (Claude's `resets_left`), so count what it still holds.
  return { count: live.reduce((sum, grant) => sum + grant.remaining, 0), nextExpiresAt: live[0]?.expiresAt ?? null };
}

/** The credits the account can spend, and whether the first of them lapses within a week. */
export function bankedTotals(snapshot: BankedResetsSnapshot | null | undefined, now = Date.now()): { count: number; nextExpiresAt: string | null; soon: boolean } {
  let count = 0;
  let nextExpiresAt: string | null = null;
  for (const source of BANKED) {
    const provider = held(snapshot?.providers?.[source], now);
    count += provider.count;
    if (provider.nextExpiresAt && (!nextExpiresAt || Date.parse(provider.nextExpiresAt) < Date.parse(nextExpiresAt))) {
      nextExpiresAt = provider.nextExpiresAt;
    }
  }
  return { count, nextExpiresAt, soon: Boolean(nextExpiresAt) && Date.parse(nextExpiresAt!) - now <= SOON_MS };
}

/**
 * Personal banked resets, above the public feed: how many reset credits this account still holds
 * and when each one lapses. Read-only: redeeming one is the provider's own job.
 */
export function Resets({ banked }: { banked?: BankedResetsSnapshot | null }) {
  return (
    <div className="space-y-6">
      <Banked initial={banked ?? null} />
      <GlobalResets />
    </div>
  );
}

function Banked({ initial }: { initial: BankedResetsSnapshot | null }) {
  const [latest, setLatest] = useState<BankedResetsSnapshot | null>(null);

  const load = useCallback(async () => {
    if (!isLive()) return;
    try {
      const response = await fetch("/api/banked-resets", { cache: "no-store" });
      if (response.ok) setLatest((await response.json()) as BankedResetsSnapshot);
    } catch {
      // The snapshot the page loaded with stays on screen.
    }
  }, []);

  useEffect(() => {
    void load();
    if (!isLive()) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const snapshot = latest ?? initial;
  return (
    <div>
      <h1 className="text-lg font-semibold">Your banked resets</h1>
      <p className="mt-1 text-sm text-muted">Reset credits this account still holds. Redeem one in the provider itself; this page only reads them.</p>
      {snapshot ? (
        <div className="grid items-start gap-3 md:grid-cols-2 mt-3">
          {BANKED.map((source) => (
            <BankedCard key={source} source={source} provider={snapshot.providers?.[source]} then={snapshot.fetchedAt} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted py-4">No banked-reset reading yet. Start the live dashboard with token-furnace serve.</p>
      )}
    </div>
  );
}

function BankedCard({ source, provider, then }: { source: Source; provider?: ProviderBankedResets; then: string | null }) {
  const label = source === "claude" ? "Claude Code" : "Codex";
  if (!provider) return <Card title={label} sub="no reading" icon="Check" />;
  const now = Date.now();
  // Count what is still spendable, not what the reading said when it was written.
  const { count, nextExpiresAt } = held(provider, now);
  const soon = nextExpiresAt ? Date.parse(nextExpiresAt) - now <= SOON_MS : false;
  return (
    <Card title={label} sub={provider.state === "ok" ? `${count} available` : undefined} icon="Check">
      <p className={`text-base font-semibold ${soon ? "text-accent" : "text-ink"}`}>
        {provider.state === "ok"
          ? count === 0
            ? "No credits left"
            : `${count} reset credit${count === 1 ? "" : "s"}`
          : stateWord(provider.state)}
      </p>
      {provider.state === "ok" && nextExpiresAt ? (
        <p className={`mt-1 text-xs ${soon ? "text-accent" : "text-muted"}`}>
          Next expires {stamp(nextExpiresAt)} · {hoursLeft(Date.parse(nextExpiresAt), now)}
        </p>
      ) : null}
      {provider.note ? <p className="mt-1 text-xs text-muted">{provider.note}</p> : null}
      {provider.grants.length ? (
        <ul className="mt-4 divide-y divide-line">
          {provider.grants.map((grant) => <Grant key={grant.id} grant={grant} now={now} />)}
        </ul>
      ) : null}
      <p className="mt-3 text-[11px] text-muted leading-4">
        {provider.stale ? "This reading is stale. " : ""}
        {then ? `Read ${stamp(then)}. ` : ""}Read-only: redeem a credit in {label} itself.
      </p>
    </Card>
  );
}

function Grant({ grant, now }: { grant: BankedResetGrant; now: number }) {
  // The reading can be older than the credit: a saved snapshot must not show a lapsed one as spendable.
  const expired = grant.status === "expired" || (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now);
  const soon = !expired && grant.expiresAt ? Date.parse(grant.expiresAt) - now <= SOON_MS : false;
  const scope = SCOPE_LABEL.get(grant.scope) ?? grant.scope;
  return (
    <li className="py-2 text-xs leading-5">
      <div className="flex items-start gap-2">
        <span className={`min-w-0 flex-1 ${expired ? "text-muted line-through" : "text-ink"}`} title={grant.description || grant.title}>
          {grant.title}
        </span>
        {grant.next && !expired ? <span className="shrink-0 rounded border border-accent px-1 text-[10px] font-semibold text-accent">Next</span> : null}
        {scope ? <span className="shrink-0 rounded bg-chip px-1 text-[10px] text-muted">{scope}</span> : null}
      </div>
      <div className={`mt-0.5 ${soon ? "text-accent" : "text-muted"}`}>
        {grant.total > 1 ? `${grant.remaining}/${grant.total} left · ` : ""}
        {expired ? `Expired ${stamp(grant.expiresAt)}` : grant.expiresAt ? `Expires ${stamp(grant.expiresAt)} · ${hoursLeft(Date.parse(grant.expiresAt), now)}` : "No expiry"}
      </div>
      {grant.grantedAt ? <div className="text-[11px] text-muted">Granted {stamp(grant.grantedAt)}</div> : null}
    </li>
  );
}

/** What a provider with no credits to show says instead of a count. */
function stateWord(state: ProviderBankedResets["state"]): string {
  return state === "no_login" ? "No login" : state === "unsupported" ? "Not offered" : "Not available";
}

/** Public reset announcements for the providers this report tracks. Nothing personal, no secrets. */
function GlobalResets() {
  const [snapshot, setSnapshot] = useState<ResetsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isLive()) return;
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
    if (!isLive()) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!isLive()) return <p className="text-sm text-muted py-6">Start the live dashboard with token-furnace serve to read the reset feed.</p>;
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
  if (at <= now) return "expired";
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

