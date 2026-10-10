import type { ReactNode } from "react";
import type { Burn, Report, Source } from "../../../src/core/model";
import { dayTime, fmt, hoursLabel, kpiFmt, quota, sharePct, SHORT, sourceLabel, toDate } from "./format";
import { Bar, Card, CopyButton, SourceToggle, Spark, Tile, WeekBar } from "./ui";
import { Gauge, Hourly, WeeklyQuota, Burndown } from "./charts";
import { Icon } from "./icons";

export function ActNow({ r }: { r: Partial<Report> }) {
  const acts = r.actions ?? [];
  const urgent = (r.issues ?? []).filter((i) => i.priority === 1);
  if (!acts.length && !urgent.length) return <p className="text-sm text-muted">Nothing urgent.</p>;
  return (
    <ul className="divide-y divide-line">
      {acts.map((a) => (
        <li key={a} className="flex gap-2 py-2 text-xs">
          <Icon name="Flame" size={14} className="text-accent shrink-0 mt-0.5" />
          <span className="min-w-0" title={a}>
            {a}
          </span>
        </li>
      ))}
      {urgent.map((i) => (
        <li key={i.title} className="flex items-center gap-2 py-2" title={i.fix}>
          <Icon name="TriangleAlert" size={16} className="text-hot shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{i.title}</div>
          </div>
          <CopyButton
            text={i.prompt}
            label="Copy fix"
            className="shrink-0 w-[4.5rem] text-center text-[11px] px-2 py-0.5 bg-chip rounded border border-line hover:border-accent"
          />
        </li>
      ))}
    </ul>
  );
}

export function ActiveSessions({
  sessions,
  source,
  limit,
}: {
  sessions: Report["active"];
  source?: Source | null;
  limit?: number | null;
}) {
  // With the source toggle on, show only that source's sessions.
  const rows = source ? sessions.filter((s) => s.source === source) : sessions;
  if (!rows.length) {
    const who = source ? sourceLabel(source) + " " : "";
    return <p className="text-sm text-muted">No {who}session had a turn in the last 30 minutes.</p>;
  }
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full min-w-max text-xs">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted font-normal [&_th]:font-normal">
            <th className="px-1 pb-1">Session</th>
            <th className="px-1">Model</th>
            <th className="px-1 text-right">Burn rate</th>
            <th className="px-1">Burn share</th>
            <th className="px-1 text-right">Context</th>
            <th className="px-1 text-right">Age</th>
            <th className="px-1 text-right">Idle</th>
            <th className="px-1">Flags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => {
            const share = Number(s.rateShare) || 0;
            const hot = share >= 50;
            return (
              <tr key={i} className="border-t border-line align-middle">
                <td className="px-1 py-1 max-w-[16rem] min-w-[10rem]">
                  <div className="truncate" title={s.title || "(untitled)"}>
                    {s.title || "(untitled)"}
                  </div>
                  <div className="text-[11px] text-muted truncate">
                    {s.project ?? "?"} · {s.id}
                  </div>
                </td>
                <td className="px-1 py-1 text-muted whitespace-nowrap">
                  {s.model ? s.model.replace(/^claude-/, "") : "—"}
                </td>
                <td className="px-1 py-1 text-right whitespace-nowrap" title={limit ? fmt(s.rate) + "/h" : undefined}>
                  {limit ? quota((100 * s.rate) / limit) : fmt(s.rate) + "/h"}
                </td>
                <td className="px-1 py-1 whitespace-nowrap">
                  <span className={hot ? "text-accent" : ""}>{sharePct(share)}</span>
                  <div className="mt-0.5 h-1 w-14 rounded bg-line overflow-hidden">
                    <div
                      className={`h-full ${hot ? "bg-accent" : "bg-bar"}`}
                      style={{ width: Math.min(100, Math.max(0, share)) + "%" }}
                    />
                  </div>
                </td>
                <td className="px-1 py-1 text-right">{fmt(s.context)}</td>
                <td className="px-1 py-1 text-right whitespace-nowrap">{Number(s.hours || 0).toFixed(1)} h</td>
                <td className="px-1 py-1 text-right whitespace-nowrap">
                  {(s.idle || 0) < 1 ? "now" : Math.round(s.idle) + " m"}
                </td>
                <td className="px-1 py-1">
                  <div className="flex flex-wrap gap-1">
                    {(s.flags ?? []).map((f) => (
                      <span
                        key={f}
                        title={f}
                        className="px-1.5 rounded text-[10px] leading-4 bg-accent/10 text-accent cursor-help whitespace-nowrap"
                      >
                        {f.split(":")[0]}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function KpiStrip({
  r,
  burn,
  source,
}: {
  r: Partial<Report>;
  burn?: Burn;
  source?: Source | null;
}) {
  const rate = Number(burn?.rate) || 0;
  const goal = Number(burn?.goal) || 0;
  const hourly = (r.timeline ?? []).slice(-24).map((t) => (t[1] ?? 0) + (t[2] ?? 0));
  const used = burn?.used ?? null;
  const left = burn?.hoursLeft ?? null;
  const ratePct = burn?.ratePct ?? null;
  const idealPct = burn?.idealPct ?? null;
  const limit = burn?.limit ?? null;
  const overBurn = goal > 0 && rate > goal;
  const inPct = limit != null && ratePct != null;
  const pctLimit = limit ?? 1;
  const ideal = idealPct ?? 0;
  const unit = (v: number) => (inPct ? quota((100 * v) / pctLimit) : fmt(v) + "/h");
  const tiles: ReactNode[] = [];
  tiles.push(
    <Tile
      key="burn"
      label="Burn / hour"
      icon="Flame"
      value={
        inPct ? (
          <>
            {ratePct.toFixed(2)}
            <span className="text-xs font-normal text-muted"> %/h</span>
          </>
        ) : (
          fmt(rate) + "/h"
        )
      }
      line={goal ? `ideal ${inPct ? ideal.toFixed(2) : fmt(goal)}` : "no ideal pace yet"}
      tip={goal ? `${(rate / goal).toFixed(1)}× the ideal pace of ${unit(goal)} · ${fmt(rate)} tokens/h` : "no ideal pace yet"}
      state={goal ? (overBurn ? "over" : "ok") : null}
    >
      <Spark values={inPct ? hourly.map((v) => (100 * v) / pctLimit) : hourly} target={inPct ? idealPct : goal || null} over={overBurn} />
    </Tile>,
  );
  if (used != null && left != null) {
    const elapsed = 100 * (1 - left / 168);
    // Tokens left at reset: goal is the remaining budget spread over the hours left.
    // One run-out for the tile and the chart, from the server: points left at the last-24 h pace.
    const proj = burn?.projection ?? null;
    const dry = proj ? (proj.hoursToEmpty ?? Infinity) : rate > 0 ? (goal * left) / rate : Infinity;
    const crit = proj ? proj.runsOut != null : dry <= left;
    const resetIso = burn?.resets ?? null;
    const reset = resetIso ? toDate(resetIso) : null;
    const g = burn?.gains ?? {};
    // Even pace spends 100/168 pts per hour.
    const gain = (h: number): string | null =>
      g[h] == null
        ? null
        : `+${Number(g[h]).toFixed(g[h] >= 10 ? 0 : 1)} pts in ${h} h (even pace ${((100 * h) / 168).toFixed(1)})`;
    const gains = [1, 6, 24].map(gain).filter((x): x is string => Boolean(x));
    const key = [6, 24, 1].find((h) => g[h] != null);
    tiles.push(
      <Tile
        key="week"
        label="Weekly limit"
        icon="CalendarDays"
        value={Math.round(used) + "%"}
        line={(key ? gain(key)?.replace(/ \(.*/, "") : null) ?? "no recent spend"}
        tip={(gains.join(" · ") || "no recent spend") + ` · even pace ${Math.round(elapsed)}% of the week gone`}
        state={used > elapsed ? "over" : "ok"}
      >
        <WeekBar used={used} elapsed={elapsed} />
      </Tile>,
    );
    const scale = Math.max(isFinite(dry) ? dry : 0, left);
    const empty = crit ? new Date(Date.now() + dry * 3600e3) : null;
    tiles.push(
      <Tile
        key="dry"
        label="Meltdown ETA"
        icon="Clock"
        value={crit ? hoursLabel(dry) : "never"}
        line={crit && empty ? "~" + dayTime(empty) : "no run-out"}
        tip={`At the last-24 h pace: ${crit && empty ? "empty ~" + dayTime(empty) : "budget lasts the week"} · reset in ${hoursLabel(left)}${reset ? " · " + dayTime(reset) : ""}`}
        state={crit ? "crit" : "ok"}
      >
        <div className="space-y-0.5" aria-hidden="true">
          <Bar pct={(100 * Math.min(dry, scale)) / scale} cls={crit ? "bg-hot" : "bg-ok"} />
          <Bar pct={(100 * left) / scale} cls="bg-muted opacity-60" />
        </div>
      </Tile>,
    );
  } else {
    tiles.push(
      <Tile key="week" label="Weekly limit" icon="CalendarDays" value="—" line="no subscription reading yet" state={null} />,
    );
  }
  const over = Number(r.over300k) || 0;
  const overHourly = (r.timeline ?? [])
    .slice(-24)
    .map((t) => (100 * (t[2] ?? 0)) / (((t[1] ?? 0) + (t[2] ?? 0)) || 1));
  tiles.push(
    <Tile
      key="over"
      label={"Spend >300k · " + (r.days ?? 0) + " d"}
      icon="TrendingUp"
      value={Math.round(over) + "%"}
      line={fmt(r.total) + " · " + (r.days ?? 0) + " d"}
      tip={"Spend over 300k context · " + fmt(r.total) + " tokens in " + (r.days ?? 0) + " d"}
      state={over >= 50 ? "over" : "ok"}
    >
      <Spark values={overHourly} target={50} over={over >= 50} />
    </Tile>,
  );
  for (const k of r.kpis ?? []) {
    const vals = k.values ?? [];
    const last = vals[vals.length - 1];
    const isOver = k.target != null && last != null && last > k.target;
    tiles.push(
      <Tile
        key={k.name}
        label={(SHORT[k.name] ?? k.name) + " · 3 h"}
        icon="Activity"
        tip={k.name + " · latest 3 h block" + (k.target != null ? " · target " + kpiFmt(k, k.target) : "")}
        value={last == null ? "—" : kpiFmt(k, last)}
        line={k.target != null ? "target " + kpiFmt(k, k.target) : ""}
        state={k.target == null || last == null ? null : isOver ? "over" : "ok"}
      >
        <Spark values={vals} target={k.target ?? null} over={isOver} />
      </Tile>,
    );
  }
  const active = (r.active ?? []).filter((s) => !source || s.source === source);
  const top = active[0];
  tiles.push(
    <Tile
      key="active"
      label="Active sessions"
      icon="Users"
      value={active.length}
      line={top ? `top ${Math.round(top.rateShare)}%` : "none in 30 min"}
      tip={top ? "Top burner: " + (top.title || top.id) : "No session had a turn in the last 30 minutes"}
      state={top && top.rateShare >= 50 && overBurn ? "over" : null}
    >
      {top ? (
        <div className="text-[11px] truncate" title={top.title || top.id}>
          {top.title || top.id}
        </div>
      ) : null}
    </Tile>,
  );
  return <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">{tiles}</div>;
}

export function Dashboard({
  r,
  burn,
  sources,
  source,
  onSource,
}: {
  r: Partial<Report>;
  burn?: Burn;
  sources: Source[];
  source?: Source;
  onSource: (source: Source) => void;
}) {
  const toggle =
    sources.length > 1 && source ? (
      <SourceToggle sources={sources} value={source} onChange={onSource} />
    ) : null;
  const weekly = burn?.weekBurndown?.length ?? 0;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Combustion rate" sub="Token burn, last hour" icon="Flame" right={toggle}>
          <div className="flex-1 flex items-center justify-center">
            <Gauge burn={burn} />
          </div>
        </Card>
        {weekly > 1 && burn ? (
          <Card title="Weekly quota" sub="Total token burn this week" icon="ChartLine" className="lg:col-span-2">
            <WeeklyQuota burn={burn} benchWindow={r.benchWindow} />
          </Card>
        ) : (
          <Card
            title="Burndown"
            icon="ChartLine"
            right={<span className="text-xs text-muted">no quota reading</span>}
            className="lg:col-span-2"
          >
            <Burndown rows={r.burndown ?? []} budget={r.budget} benchWindow={r.benchWindow} />
          </Card>
        )}
      </div>
      <KpiStrip r={r} burn={burn} source={sources.length > 1 ? source ?? null : null} />
      <Card title="Hourly spend by context" sub="Tokens burned per hour, split by context window" icon="ChartColumn">
        <Hourly rows={r.timeline ?? []} goal={burn?.goal} />
      </Card>
      <div className="grid gap-4 lg:grid-cols-5">
        <Card title="Act now" sub="Quick fixes to keep the furnace under control" icon="TriangleAlert" className="lg:col-span-2">
          <ActNow r={r} />
        </Card>
        <Card title="Active sessions" sub="Sessions currently feeding the furnace" icon="Users" className="lg:col-span-3">
          <ActiveSessions
            sessions={r.active ?? []}
            source={sources.length > 1 ? source ?? null : null}
            limit={burn?.limit}
          />
        </Card>
      </div>
    </div>
  );
}
