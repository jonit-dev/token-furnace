import { CONTEXT_TARGET, CONTEXT_TARGET_LABEL } from "../../../src/core/context";
import type { Burn, Report, Source } from "../../../src/core/model";
import { clock, dayLabel, fmt, quota, sourceLabel, toDate } from "./format";
import { useSize } from "./ui";

const WEEK_MS = 7 * 24 * 3600e3;

// Burn gauge. The dial runs from 0 to max(2x goal, 1.25x rate). Green up to the goal, coral past it.
const GAUGE_TIP =
  "Quota points per hour, calibrated each time the weekly reading refreshes (every 5 min while the status line runs).";

export function Gauge({ burn }: { burn?: Burn }) {
  if (!burn?.goal) {
    return (
      <div className="py-6 text-center">
        <p className="text-muted">No hourly goal yet</p>
        <p className="text-xs text-muted mt-1">Set --weekly-budget or sign in to Claude Code.</p>
      </div>
    );
  }
  const pctMode = burn.ratePct != null && burn.idealPct != null;
  const rate = Number(pctMode ? burn.ratePct : burn.rate) || 0;
  const goal = Number(pctMode ? burn.idealPct : burn.goal);
  const over = rate > goal;
  const max = Math.max(2 * goal, 1.25 * rate);
  const fr = Math.min(1, rate / max);
  const fg = goal / max;
  const r = 76;
  const cx = 100;
  const cy = 100;
  const at = (f: number, rad = r): [number, number] => [
    cx - rad * Math.cos(Math.PI * f),
    cy - rad * Math.sin(Math.PI * f),
  ];
  const arc = (f0: number, f1: number, cls: string) => {
    if (f1 - f0 < 0.002) return null;
    const [xa, ya] = at(f0);
    const [xb, yb] = at(f1);
    return (
      <path
        d={`M${xa} ${ya} A${r} ${r} 0 0 1 ${xb} ${yb}`}
        fill="none"
        className={cls}
        strokeWidth="12"
        strokeLinecap="round"
      />
    );
  };
  const [t0x, t0y] = at(fg, r - 8);
  const [t1x, t1y] = at(fg, r + 6);
  const [lx, ly] = at(fg, r + 15);
  const th = Math.PI * fr;
  const [tx, ty] = at(fr, r - 12);
  const px = Math.sin(th) * 3.5;
  const py = -Math.cos(th) * 3.5;
  const ratio = rate / goal;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1" title={pctMode ? GAUGE_TIP : undefined}>
      <svg viewBox="0 0 200 112" className="w-[210px] h-auto shrink-0" role="img" aria-label="Burn rate against ideal pace">
        <path
          d={`M${at(0)[0]} ${at(0)[1]} A${r} ${r} 0 0 1 ${at(1)[0]} ${at(1)[1]}`}
          fill="none"
          className="stroke-line"
          strokeWidth="12"
          strokeLinecap="round"
        />
        {arc(0, Math.min(fr, fg), "stroke-ok glow")}
        {arc(fg, fr, "stroke-accent glow")}
        <line x1={t0x} y1={t0y} x2={t1x} y2={t1y} className="stroke-ink" strokeWidth="1.5" />
        <text x={lx} y={ly + 3} textAnchor="middle" fontSize="10" className="fill-muted">
          ideal
        </text>
        <polygon points={`${cx + px},${cy + py} ${cx - px},${cy - py} ${tx},${ty}`} className="fill-ink" />
        <circle cx={cx} cy={cy} r="5" className="fill-ink" />
      </svg>
      <div className="text-center">
        <div className="text-3xl font-semibold leading-8">{pctMode ? quota(rate) : fmt(rate) + "/h"}</div>
        <div className="text-xs text-muted">ideal {pctMode ? quota(goal) : fmt(goal) + "/h"}</div>
        <div className="text-[11px] text-muted">{pctMode ? fmt(burn.rate) + " tokens/h" : "no quota reading"}</div>
        <div
          className={`mt-2 text-xs font-medium px-2.5 py-1 rounded-full inline-block ${
            over ? "bg-accent/10 text-accent" : "bg-ok/10 text-ok"
          }`}
        >
          {over ? ratio.toFixed(1) + "× the sustainable pace" : "On pace"}
        </div>
      </div>
      {burn.basis ? <p className="basis-full text-center text-[11px] text-muted">{burn.basis}</p> : null}
    </div>
  );
}

// Cumulative burn over time. Dashed: the same turns with context capped at each provider target.
// Dotted: a straight line that spends the weekly budget at a steady pace.
export function Burndown({
  rows,
  budget,
}: {
  rows: Report["burndown"];
  budget?: number | null;
}) {
  const [ref, { w, h }] = useSize();
  if (!rows.length) return <p className="text-sm text-muted">No burndown data.</p>;
  const t = rows.map((d) => toDate(d[0]).getTime());
  const t0 = t[0];
  const n = rows.length - 1;
  const span = Math.max(t[n] - t0, 1);
  const paceEnd = budget ? (budget * span) / WEEK_MS : 0;
  const peak = Math.max(paceEnd, ...rows.map((d) => Math.max(d[1] ?? 0, d[2] ?? 0))) || 1;
  // Round step (1, 2 or 5 x 10^k) giving at most 4 gridlines; the axis tops out on a round value.
  const mag = 10 ** Math.floor(Math.log10(peak / 4));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((v) => peak / v <= 4) ?? 1;
  const maxV = Math.ceil(peak / step - 1e-9) * step;
  const l = 44;
  const rt = 10;
  const tp = 8;
  const b = 20;
  const x = (i: number) => l + ((t[i] - t0) / span) * (w - l - rt);
  const y = (v: number) => h - b - (v / maxV) * (h - b - tp);
  const path = (k: 1 | 2) =>
    rows.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[k] ?? 0).toFixed(1)}`).join(" ");
  const last = rows[n];
  const ticks = Array.from({ length: Math.round(maxV / step) }, (_, i) => ((i + 1) * step) / maxV);
  const mid = new Date(t0 + span / 2);
  return (
    <div className="flex-1 flex flex-col">
      <div ref={ref} className="relative flex-1 min-h-[8rem]">
        {w > 0 ? (
          <svg
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full"
            role="img"
            aria-label="Cumulative burn"
          >
            {ticks.map((f) => (
              <g key={f}>
                <line x1={l} x2={w - rt} y1={y(maxV * f)} y2={y(maxV * f)} className="stroke-line" />
                <text x={l - 6} y={y(maxV * f) + 4} textAnchor="end" fontSize="10" className="fill-muted">
                  {fmt(maxV * f).replace(/\.0(?=[a-zA-Z])/, "")}
                </text>
              </g>
            ))}
            <line x1={l} y1={h - b} x2={w - rt} y2={h - b} className="stroke-muted" />
            <text x={l - 6} y={h - b + 4} textAnchor="end" fontSize="10" className="fill-muted">
              0
            </text>
            <text x={l} y={h - 6} fontSize="10" className="fill-muted">
              {dayLabel(new Date(t0))}
            </text>
            <text x={(l + w - rt) / 2} y={h - 6} textAnchor="middle" fontSize="10" className="fill-muted">
              {dayLabel(mid)}
            </text>
            <text x={w - rt} y={h - 6} textAnchor="end" fontSize="10" className="fill-muted">
              {dayLabel(new Date(t[n]))}
            </text>
            {budget ? (
              <line
                x1={x(0)}
                y1={y(0)}
                x2={x(n)}
                y2={y(paceEnd)}
                className="stroke-muted"
                strokeDasharray="1 3"
                strokeWidth="1.5"
              />
            ) : null}
            <path d={path(2)} fill="none" className="stroke-muted" strokeWidth="1.5" strokeDasharray="4 3" />
            <path d={path(1)} fill="none" className="stroke-accent" strokeWidth="2" />
          </svg>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted mt-1">
        <span>
          <span className="inline-block w-4 border-t-2 border-accent align-middle" /> actual {fmt(last[1])}
        </span>
        <span>
          <span className="inline-block w-4 border-t-2 border-dashed border-muted align-middle" /> benchmark{" "}
          {fmt(last[2])} (context capped at {CONTEXT_TARGET_LABEL})
        </span>
        {budget ? (
          <span>
            <span className="inline-block w-4 border-t-2 border-dotted border-muted align-middle" /> weekly budget pace
          </span>
        ) : null}
      </div>
    </div>
  );
}

// Both providers use their own quota percentage, plotted against the same calendar time.
export function WeeklyQuota({ burns }: { burns: Partial<Record<Source, Burn>> }) {
  const [ref, { w, h }] = useSize();
  const series = (Object.entries(burns) as [Source, Burn][]).flatMap(([source, burn]) => {
    if (!burn.weekBurndown || burn.weekBurndown.length < 2) return [];
    const start = toDate(burn.start).getTime();
    const reset = toDate(burn.resets).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(reset) || reset <= start) return [];
    const pts = burn.weekBurndown.map(([t, used, capped]) => [toDate(t).getTime(), used, capped] as const);
    const [now, used] = pts[pts.length - 1];
    const rate = burn.projection?.ratePct ?? 0;
    const end = rate > 0 && used < 100 ? Math.max(now, Math.min(reset, now + (100 - used) / rate * 3600000)) : now;
    const endV = used + rate * (end - now) / 3600000;
    return [{ source, start, reset, pts, now, used, rate, end, endV,
      color: source === "claude" ? "#f97316" : "#4a9eff" }];
  });
  if (!series.length) return null;
  const t0 = Math.min(...series.map(s => s.start));
  const t1 = Math.max(...series.map(s => s.reset));
  const maxPct = Math.ceil(Math.max(100, ...series.flatMap(s => s.pts.flatMap(p => [p[1], p[2]]))) / 25) * 25;
  const l = 38, rt = 12, tp = 12, b = 24;
  const x = (t: number) => l + (t - t0) / (t1 - t0) * (w - l - rt);
  const y = (v: number) => h - b - v / maxPct * (h - b - tp);
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + i * (t1 - t0) / 4);
  const when = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: "short" }) + " " + clock(new Date(t));
  return (
    <div className="flex-1 flex flex-col">
      <div ref={ref} className="relative flex-1 min-h-[10rem]">
        {w > 0 ? (
          <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full" role="img" aria-label="Weekly quota used">
            {Array.from({ length: maxPct / 25 + 1 }, (_, i) => i * 25).map(v => (
              <g key={v}>
                <line x1={l} x2={w - rt} y1={y(v)} y2={y(v)} className="stroke-line" />
                <text x={l - 6} y={y(v) + 4} textAnchor="end" fontSize="10" className="fill-muted">{v}%</text>
              </g>
            ))}
            {ticks.map((t, i) => (
              <text key={t} x={x(t)} y={h - 6} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
                fontSize="10" className="fill-muted">{dayLabel(new Date(t))}</text>
            ))}
            {series.map(s => {
              const path = (k: 1 | 2) => s.pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
              return (
                <g key={s.source} data-provider={s.source}>
                  <line x1={x(s.start)} y1={y(0)} x2={x(s.reset)} y2={y(100)} stroke={s.color} strokeWidth="1" opacity="0.3" />
                  <path d={path(2)} fill="none" stroke={s.color} strokeWidth="1.5" strokeDasharray="1 3" opacity="0.6" />
                  {s.end > s.now ? <line data-series="projection" x1={x(s.now)} y1={y(s.used)} x2={x(s.end)} y2={y(s.endV)}
                    stroke={s.color} strokeWidth="1.5" strokeDasharray="4 3" /> : null}
                  <path data-series="used" d={path(1)} fill="none" stroke={s.color} strokeWidth="2">
                    <title>{sourceLabel(s.source)}: {s.used.toFixed(0)}% used</title>
                  </path>
                  <line x1={x(s.reset)} x2={x(s.reset)} y1={y(100) - 4} y2={y(100) + 4} stroke={s.color} />
                  <circle cx={x(s.now)} cy={y(s.used)} r="3.5" fill={s.color} />
                </g>
              );
            })}
          </svg>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted mt-1">
        {series.map(s => (
          <span key={s.source}>
            <span className="inline-block w-4 border-t-2 align-middle" style={{ borderColor: s.color }} />{" "}
            <span className="text-ink">{sourceLabel(s.source)} {s.used.toFixed(0)}%</span>
            {" · cap "}{fmt(CONTEXT_TARGET[s.source])}
            {s.end > s.now && s.end < s.reset ? ` · runs out ${when(s.end)}` : ` · resets ${when(s.reset)}`}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted mt-1">
        <span><span className="inline-block w-4 border-t border-muted align-middle opacity-50" /> even pace</span>
        <span><span className="inline-block w-4 border-t-2 border-dashed border-muted align-middle" /> projection</span>
        <span><span className="inline-block w-4 border-t-2 border-dotted border-muted align-middle" /> if context capped</span>
      </div>
    </div>
  );
}

// Hourly spend. Within provider target at the bottom, above target on top.
export function Hourly({ rows, goal }: { rows: Report["timeline"]; goal?: number | null }) {
  if (!rows.length) return <p className="text-sm text-muted">No timeline data.</p>;
  const step = 7;
  const bw = 5;
  const h = 100;
  const base = 100;
  const top = 4;
  const n = rows.length;
  const w = n * step;
  const max = Math.max(goal || 0, ...rows.map((t) => (t[1] ?? 0) + (t[2] ?? 0))) || 1;
  const scale = (v: number) => (v / max) * (base - top);
  const hourLabel = (iso: string) => dayLabel(toDate(iso)) + " " + clock(toDate(iso));
  // One tick per local midnight, away from the end labels.
  const days = rows
    .map((t, i) => [toDate(t[0]), i] as [Date, number])
    .filter(([d, i]) => d.getHours() === 0 && i > n * 0.08 && i < n * 0.92);
  return (
    <div className="flex flex-col">
      <div className="relative min-h-[7.5rem] h-[7.5rem] sm:h-[9rem]">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
          role="img"
          aria-label="Hourly spend"
        >
          {[0.5, 1].map((f) => (
            <line
              key={f}
              x1="0"
              x2={w}
              y1={base - scale(max * f)}
              y2={base - scale(max * f)}
              className="stroke-line"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {rows.map((t, i) => {
            const cool = scale(t[1] ?? 0);
            const hot = scale(t[2] ?? 0);
            const x = i * step + 1;
            return (
              <g key={t[0]}>
                <rect x={x} y={base - cool} width={bw} height={cool} className="fill-bar" fillOpacity="0.85" rx="1" />
                <rect
                  x={x}
                  y={base - cool - hot}
                  width={bw}
                  height={hot}
                  className="fill-accent"
                  fillOpacity="0.85"
                  rx="1"
                />
              </g>
            );
          })}
          {goal ? (
            <line
              x1="0"
              x2={w}
              y1={base - scale(goal)}
              y2={base - scale(goal)}
              className="stroke-ok"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        <span className="absolute left-1 top-0 text-[11px] text-muted bg-card/80 px-1 rounded">{fmt(max)}/h</span>
        <span
          className="absolute left-1 text-[11px] text-muted bg-card/80 px-1 rounded"
          style={{ top: "calc(50% - 0.5rem)" }}
        >
          {fmt(max / 2)}/h
        </span>
      </div>
      <div className="relative h-5 border-t border-line text-[11px] text-muted">
        <span className="absolute left-0 top-0.5">{hourLabel(rows[0][0])}</span>
        {days.map(([d, i]) => (
          <span
            key={i}
            className="absolute top-0.5 -translate-x-1/2 hidden sm:block"
            style={{ left: (100 * (i + 0.5)) / n + "%" }}
          >
            {dayLabel(d)}
          </span>
        ))}
        <span className="absolute right-0 top-0.5">{hourLabel(rows[n - 1][0])}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted mt-1">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm bg-bar" />within provider target
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm bg-accent opacity-85" />above provider target
        </span>
        {goal ? (
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t-2 border-dashed border-ok" />ideal {fmt(goal)}/h
          </span>
        ) : null}
      </div>
    </div>
  );
}
