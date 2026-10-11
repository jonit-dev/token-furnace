import { CONTEXT_TARGET_LABEL, MAX_OVER_TARGET_SHARE } from "../../../src/core/context";
import { sessionFixPrompt } from "../../../src/core/analyze/issues";
import { useState, type ReactNode } from "react";
import type { Burn, Report, Source } from "../../../src/core/model";
import { dayTime, fmt, hoursLabel, kpiFmt, quota, sharePct, SHORT, sourceLabel, toDate } from "./format";
import { Bar, Card, CopyButton, SourceBadge, SourceSelect, Spark, Tile, WeekBar } from "./ui";
import { Gauge, Hourly, WeeklyQuota, Burndown } from "./charts";
import { Icon } from "./icons";
import { Modal } from "./modal";
import { useUi } from "../store";

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
        <li key={i.source + "|" + i.title} className="flex items-center gap-2 py-2" title={i.fix}>
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

function parseFlag(f: string): { label: string; reason: string; fix: string } {
  const idx = f.indexOf(": ");
  const label = idx !== -1 ? f.slice(0, idx) : f;
  const rest = idx !== -1 ? f.slice(idx + 2) : "";
  const period = rest.indexOf(". ");
  const reason = period !== -1 ? rest.slice(0, period) : rest;
  const fix = period !== -1 ? rest.slice(period + 2) : "";
  return { label, reason, fix };
}

type ActiveRow = Report["active"][number];

function burnText(s: ActiveRow, burns?: Report["burns"]): string {
  const limit = burns?.[s.source]?.limit;
  return limit ? quota((100 * s.rate) / limit) : fmt(s.rate) + "/h";
}

function SessionTable({
  sessions,
  burns,
  onOpen,
  head = true,
}: {
  sessions: Report["active"];
  burns?: Report["burns"];
  onOpen: (s: ActiveRow) => void;
  head?: boolean;
}) {
  return (
    <div className="session-table-container -mx-1">
      <table className="session-table w-full text-xs">
        {head ? (
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted [&_th]:font-normal">
              <th className="px-1">Session</th>
              <th className="px-1">Model</th>
              <th className="px-1 text-right" title="Burn rate">Burn</th>
              <th className="px-1" title="Provider burn share">Share</th>
              <th className="px-1 text-right">Ctx</th>
              <th className="px-1 text-right">Age</th>
              <th className="px-1 text-right">Idle</th>
              <th className="px-1 text-right">Fixes</th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {sessions.map((s, i) => {
            const share = Number(s.rateShare) || 0;
            const hot = share >= 50;
            const limit = burns?.[s.source]?.limit;
            const providerLabel = sourceLabel(s.source);
            const n = s.flags?.length ?? 0;
            return (
              <tr key={i} onClick={() => onOpen(s)} className="border-t border-line cursor-pointer hover:bg-chip/40">
                <td className="px-1 py-1.5 min-w-0 flex items-center gap-1.5">
                  <SourceBadge source={s.source} />
                  <span className="truncate font-medium min-w-0" title={s.title || "(untitled)"}>
                    {s.title || "(untitled)"}
                  </span>
                  <span className="shrink-0 max-w-[7rem] truncate text-muted" title={s.project ?? "?"}>
                    {s.project ?? "?"}
                  </span>
                </td>
                <td className="px-1 py-1.5 min-w-0 text-muted">
                  <div className="truncate" title={s.model || undefined}>
                    {s.model ? s.model.replace(/^claude-/, "") : "—"}
                  </div>
                </td>
                <td data-label="Burn rate" className="px-1 py-1.5 text-right whitespace-nowrap" title={limit ? fmt(s.rate) + "/h" : undefined}>
                  {burnText(s, burns)}
                </td>
                <td data-label="Provider burn share" className="px-1 py-1.5 flex items-center gap-1.5" title={`${sharePct(share)} of ${providerLabel}`}>
                  <span className={`shrink-0 ${hot ? "text-accent font-medium" : ""}`}>{sharePct(share)}</span>
                  <span className="sr-only"> of {providerLabel}</span>
                  <div className="h-1 min-w-0 flex-1 rounded bg-line overflow-hidden">
                    <div
                      className={`h-full ${hot ? "bg-accent" : "bg-bar"}`}
                      style={{ width: Math.min(100, Math.max(0, share)) + "%" }}
                    />
                  </div>
                </td>
                <td data-label="Context" className="px-1 py-1.5 text-right">{fmt(s.context)}</td>
                <td data-label="Age" className="px-1 py-1.5 text-right whitespace-nowrap">{Number(s.hours || 0).toFixed(1)} h</td>
                <td data-label="Idle" className="px-1 py-1.5 text-right whitespace-nowrap">
                  {(s.idle || 0) < 1 ? "now" : Math.round(s.idle) + " m"}
                </td>
                <td className="px-1 py-1 text-right">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpen(s); }}
                    aria-label={`${n ? `${n} ${n === 1 ? "fix" : "fixes"}` : "Details"} for ${s.title || "(untitled)"}`}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                      n ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-chip text-muted"
                    } hover:border-accent`}
                  >
                    {n ? <Icon name="TriangleAlert" size={11} /> : null}
                    {n ? n : "View"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SessionModal({
  session: s,
  burns,
  onClose,
}: {
  session: ActiveRow | null;
  burns?: Report["burns"];
  onClose: () => void;
}) {
  const stats: [string, string][] = s
    ? [
        ["Burn rate", burnText(s, burns)],
        ["Provider share", `${sharePct(Number(s.rateShare) || 0)} of ${sourceLabel(s.source)}`],
        ["Context", fmt(s.context)],
        ["Peak", fmt(s.peak)],
        ["Turns", String(s.turns)],
        ["Age", `${Number(s.hours || 0).toFixed(1)} h`],
        ["Idle", (s.idle || 0) < 1 ? "now" : Math.round(s.idle) + " m"],
      ]
    : [];
  return (
    <Modal
      open={s != null}
      onClose={onClose}
      title={s?.title || "(untitled)"}
      description={
        s ? (
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={s.source} />
            <span>{s.project ?? "?"}</span>
            <span>·</span>
            <span>{s.model || "—"}</span>
          </div>
        ) : null
      }
      footer={
        s ? (
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 break-all text-muted">{s.fullId || s.id}</span>
            <CopyButton
              text={s.fullId || s.id}
              label="Copy ID"
              className="shrink-0 px-3 py-1 bg-chip rounded border border-line hover:border-accent"
            />
          </div>
        ) : null
      }
    >
      {s ? (
        <div className="space-y-4 text-xs">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
            {stats.map(([k, v]) => (
              <div key={k}>
                <dt className="text-[10px] uppercase tracking-wide text-muted">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <div>
            <h3 className="mb-1.5 text-[10px] uppercase tracking-wide text-muted">Issues ({s.flags?.length ?? 0})</h3>
            {s.flags?.length ? (
              <ul className="space-y-2">
                {s.flags.map((f) => {
                  const { label, reason, fix } = parseFlag(f);
                  return (
                    <li key={f} className="flex items-start justify-between gap-3 rounded-lg bg-accent/10 p-2.5">
                      <div className="min-w-0">
                        <div className="text-accent"><span className="font-semibold">{label}:</span> <span>{reason}</span></div>
                        {fix ? <div className="mt-0.5 text-muted">{fix}</div> : null}
                      </div>
                      <CopyButton
                        text={sessionFixPrompt(s, f)}
                        label="Copy fix"
                        className="shrink-0 px-2.5 py-1 bg-chip text-ink rounded-full border border-line hover:border-accent"
                      />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-muted">No issues flagged for this session.</p>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

export function ActiveSessions({
  sessions,
  burns,
}: {
  sessions: Report["active"];
  burns?: Report["burns"];
}) {
  const [selected, setSelected] = useState<ActiveRow | null>(null);
  if (!sessions.length) {
    return <p className="text-sm text-muted">No session had a turn in the last 30 minutes.</p>;
  }
  const attention = sessions.filter((s) => (s.flags?.length ?? 0) > 0);
  const others = sessions.filter((s) => !s.flags || s.flags.length === 0);
  const close = () => setSelected(null);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-accent mb-1 flex items-center gap-1.5">
          <Icon name="TriangleAlert" size={14} />
          Needs attention ({attention.length})
        </h3>
        {attention.length ? (
          <SessionTable sessions={attention} burns={burns} onOpen={setSelected} />
        ) : (
          <p className="text-xs text-muted py-1">No active sessions have triggered leak flags.</p>
        )}
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">
          Other active sessions ({others.length})
        </h3>
        {others.length ? (
          <SessionTable sessions={others} burns={burns} onOpen={setSelected} head={!attention.length} />
        ) : (
          <p className="text-xs text-muted py-1">No other active sessions.</p>
        )}
      </div>
      <SessionModal session={selected} burns={burns} onClose={close} />
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
  source?: Source;
}) {
  const rate = Number(burn?.rate) || 0;
  const goal = Number(burn?.goal) || 0;
  const hourly = (source ? r.timelines?.[source] ?? [] : r.timeline ?? []).slice(-24).map((t) => (t[1] ?? 0) + (t[2] ?? 0));
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
  const days = r.days ?? 0;
  // One "spend over the context target" tile; the all-provider tile and each provider tile share it.
  const overTile = (key: string, label: string, rows: Report["timeline"], over: number, total: number, tip: string) => {
    const max = MAX_OVER_TARGET_SHARE * 100;
    return (
      <Tile
        key={key}
        label={label}
        icon="TrendingUp"
        value={Math.round(over) + "%"}
        line={fmt(total) + " · " + days + " d"}
        tip={tip}
        state={over > max ? "over" : "ok"}
      >
        <Spark
          values={rows.slice(-24).map((t) => (100 * (t[2] ?? 0)) / (((t[1] ?? 0) + (t[2] ?? 0)) || 1))}
          target={max}
          over={over > max}
        />
      </Tile>
    );
  };
  const counts = [
    [r.sessions, "sessions"],
    [r.turns, "turns"],
    [r.projectCount, "projects"],
    [r.toolCalls, "tool calls"],
  ]
    .filter(([n]) => n != null)
    .map(([n, name]) => fmt(Number(n)) + " " + name)
    .join(" · ");
  tiles.push(
    overTile(
      "over",
      "Spend >target · " + days + " d",
      r.timeline ?? [],
      Number(r.overTarget) || 0,
      r.total ?? 0,
      "Spend over provider context target (" + CONTEXT_TARGET_LABEL + ") · " + fmt(r.total) + " tokens in " + days + " d" + (counts ? " · " + counts : ""),
    ),
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
  const active = r.active ?? [];
  const top = active[0];
  const topBurn = top ? r.burns?.[top.source] : undefined;
  // The benchmark is the top burner's own provider goal: red when that provider runs over it, green when under.
  const topOver = top && topBurn?.goal ? topBurn.rate > topBurn.goal && top.rateShare >= 50 : null;
  tiles.push(
    <Tile
      key="active"
      label="Active sessions"
      icon="Users"
      value={active.length}
      line={top ? `top ${Math.round(top.rateShare)}%` : "none in 30 min"}
      tip={top ? "Top burner: " + (top.title || top.id) : "No session had a turn in the last 30 minutes"}
      state={topOver == null ? null : topOver ? "over" : "ok"}
    >
      {top ? <Bar pct={top.rateShare} cls={topOver == null ? "bg-muted" : topOver ? "bg-hot" : "bg-ok"} /> : null}
    </Tile>,
  );
  for (const provider of Object.keys(r.timelines ?? {}) as Source[]) {
    const rows = r.timelines?.[provider] ?? [];
    const [cool, hot] = rows.reduce<[number, number]>((sum, row) => [sum[0] + row[1], sum[1] + row[2]], [0, 0]);
    tiles.push(
      overTile(
        `spend-${provider}`,
        `${sourceLabel(provider)} >target`,
        rows,
        (100 * hot) / (cool + hot || 1),
        cool + hot,
        `${sourceLabel(provider)} spend over its context target · ${fmt(cool + hot)} weighted tokens in ${days} d`,
      ),
    );
  }
  return <div className="grid gap-3 grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">{tiles}</div>;
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
  const hourlySource = useUi((state) => state.hourlySource);
  const setHourlySource = useUi((state) => state.setHourlySource);
  const pins = useUi((state) => state.pins);
  const togglePin = useUi((state) => state.togglePin);
  const hourlySources = Object.keys(r.timelines ?? {}) as Source[];
  const hourlyCurrent = hourlySources.includes(hourlySource as Source) ? hourlySource : "all";
  const hourlyRows = hourlyCurrent === "all" ? r.timeline ?? [] : r.timelines?.[hourlyCurrent] ?? [];
  const hourlyGoal = hourlyCurrent === "all" ? undefined : r.burns?.[hourlyCurrent]?.goal;
  const toggle = source ? <SourceSelect sources={sources} value={source}
    onChange={(value) => { if (value !== "all") onSource(value); }} label="Combustion rate"
    pinned={pins.source === source} onPin={() => togglePin("source", source)} /> : null;
  const weeklyBurns = r.burns ?? (r.burn ? { claude: r.burn } : {});
  const weekly = Object.values(weeklyBurns).some(b => (b?.weekBurndown?.length ?? 0) > 1);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Combustion rate" sub="Token burn, last hour" icon="Flame" right={toggle}>
          <div className="flex-1 flex items-center justify-center">
            <Gauge burn={burn} />
          </div>
        </Card>
        {weekly ? (
          <Card title="Weekly quota" sub="Each provider’s weekly quota · shared calendar and percentage scale" icon="ChartLine" className="lg:col-span-2">
            <WeeklyQuota burns={weeklyBurns} />
          </Card>
        ) : (
          <Card
            title="Burndown"
            icon="ChartLine"
            right={<span className="text-xs text-muted">no quota reading</span>}
            className="lg:col-span-2"
          >
            <Burndown rows={r.burndown ?? []} budget={r.budget}  />
          </Card>
        )}
      </div>
      <KpiStrip r={r} burn={burn} source={source} />
      <Card title="Hourly spend by context" sub="Tokens burned per hour, split by context window" icon="ChartColumn"
        right={<SourceSelect sources={["all", ...hourlySources]} value={hourlyCurrent} onChange={setHourlySource}
          label="Hourly spend" pinned={pins.hourlySource === hourlyCurrent}
          onPin={() => togglePin("hourlySource", hourlyCurrent)} />}>
        <Hourly rows={hourlyRows} goal={hourlyGoal} />
      </Card>
      <div className="grid gap-4 lg:grid-cols-5">
        <Card title="Act now" sub="Quick fixes to keep the furnace under control" icon="TriangleAlert" className="lg:col-span-2">
          <ActNow r={r} />
        </Card>
        <Card title="Active sessions" sub="Sessions currently feeding the furnace" icon="Users" className="lg:col-span-3">
          <ActiveSessions
            sessions={r.active ?? []}
            burns={r.burns}
          />
        </Card>
      </div>
    </div>
  );
}
