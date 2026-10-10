import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { Level, Source } from "../../../src/core/model";
import { Icon } from "./icons";
import { copyText, LEVEL, SOURCE_LABEL, sourceLabel, stamp, toDate } from "./format";

export function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onClick = () => {
    copyText(text || "");
    setDone(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1500);
  };

  return (
    <button type="button" onClick={onClick} className={className}>
      {done ? "Copied" : label}
    </button>
  );
}

export function LevelTag({ level }: { level: Level }) {
  const [dot, text, label] = LEVEL[level] ?? LEVEL.info;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${text}`}>
      <span className={`size-2 shrink-0 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function SourceBadge({ source }: { source: Source | "all" | null | undefined }) {
  const label = source ? SOURCE_LABEL[source] : undefined;
  if (!label) return null;
  const cls =
    source === "claude"
      ? "bg-accent/10 text-accent"
      : source === "codex"
        ? "bg-bar/15 text-bar"
        : "bg-chip text-muted";
  return (
    <span className={`px-1.5 rounded text-[10px] leading-4 whitespace-nowrap ${cls}`}>{label}</span>
  );
}

export function SourceToggle({
  sources,
  value,
  onChange,
}: {
  sources: Source[];
  value: Source;
  onChange: (source: Source) => void;
}) {
  return (
    <div role="group" aria-label="Burn source" className="inline-flex p-0.5 rounded-lg bg-chip border border-line">
      {sources.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={s === value}
          onClick={() => onChange(s)}
          className={`px-2 py-0.5 text-xs rounded-md ${
            s === value ? "bg-card text-ink border border-line" : "text-muted"
          }`}
        >
          {sourceLabel(s)}
        </button>
      ))}
    </div>
  );
}

export function Card({
  title,
  sub,
  icon,
  right,
  className = "",
  children,
}: {
  title?: ReactNode;
  sub?: string;
  icon?: string;
  right?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={`card p-4 min-w-0 flex flex-col ${className}`}>
      {title || right ? (
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-start gap-2 min-w-0">
            {icon ? <Icon name={icon} size={16} className="text-accent shrink-0 mt-0.5" /> : null}
            <div className="min-w-0">
              <h2 className="text-sm font-semibold leading-5">{title}</h2>
              {sub ? <p className="text-[11px] text-muted leading-4 truncate">{sub}</p> : null}
            </div>
          </div>
          {right}
        </div>
      ) : null}
      {children}
    </section>
  );
}

// Small trend line. The dashed line marks the target. Lower is better for every series here.
// Muted unless the tile is over its target.
export function Spark({
  values,
  target,
  over,
}: {
  values: number[];
  target?: number | null;
  over?: boolean;
}) {
  if (values.length < 2) return null;
  const w = 100;
  const h = 20;
  const maxV = Math.max(...values, target ?? 0) || 1;
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => h - 2 - (v / maxV) * (h - 4);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-5 block" aria-hidden="true">
      <path d={`${line} L${w},${h} L0,${h} Z`} fillOpacity="0.14" className={over ? "fill-hot" : "fill-accent"} />
      {target != null ? (
        <line
          x1="0"
          x2={w}
          y1={y(target)}
          y2={y(target)}
          className="stroke-muted"
          strokeDasharray="3 2"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <path
        d={line}
        fill="none"
        className={over ? "stroke-hot" : "stroke-accent"}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// One compact KPI tile. state: 'crit' needs action now, 'over' misses the target, 'ok' meets it, null has no target.
const DOT: Record<string, string> = { crit: "bg-hot", over: "bg-accent", ok: "bg-ok" };

export function Tile({
  label,
  value,
  line,
  tip,
  state,
  icon,
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  line?: ReactNode;
  tip?: string | null;
  state?: "crit" | "over" | "ok" | null;
  icon?: string;
  children?: ReactNode;
}) {
  return (
    <div className="card px-3 py-2.5 flex flex-col min-w-0" title={tip || String(label)}>
      <div className="flex items-center gap-1.5 min-w-0">
        {icon ? <Icon name={icon} size={13} className="text-accent shrink-0" /> : null}
        {state ? <span className={`size-1.5 shrink-0 rounded-full ${DOT[state]}`} /> : null}
        <span className="text-[11px] uppercase tracking-wide text-muted truncate" title={String(label)}>
          {label}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2 min-w-0">
        <span className={`text-lg leading-6 font-semibold shrink-0 ${state === "crit" ? "text-hot" : ""}`}>
          {value}
        </span>
        {line ? (
          <span className="text-[11px] text-muted truncate" title={String(line)}>
            {line}
          </span>
        ) : null}
      </div>
      <div className="mt-auto pt-1 min-h-6 flex flex-col justify-end">{children}</div>
    </div>
  );
}

// Week used against week elapsed: the bar is usage, the tick is where an even pace would be.
export function WeekBar({ used, elapsed }: { used: number; elapsed: number }) {
  return (
    <div
      className="relative h-1.5 rounded bg-line"
      title={"even pace " + Math.round(elapsed) + "%"}
      aria-hidden="true"
    >
      <div
        className={`h-full rounded ${used > elapsed ? "bg-accent" : "bg-ok"}`}
        style={{ width: Math.min(100, used) + "%" }}
      />
      <div className="absolute -top-0.5 h-2.5 w-0.5 bg-ink" style={{ left: Math.min(100, elapsed) + "%" }} />
    </div>
  );
}

export function Bar({ pct, cls }: { pct: number; cls?: string }) {
  return (
    <div className="h-1 rounded bg-line">
      <div className={`h-full rounded ${cls}`} style={{ width: Math.min(100, pct) + "%" }} />
    </div>
  );
}

// Measured pixel size of a box, so an SVG can draw at 1:1 and keep its text undistorted.
export function useSize(): [RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => {
      setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// Age of the report. Ticks every second; the title holds the absolute time.
export function Updated({ iso }: { iso?: string }) {
  const [, tick] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  const d = iso ? toDate(iso) : null;
  if (!d || isNaN(d.getTime())) return <span>no report yet</span>;
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  const age = s < 60 ? s + " s" : s < 3600 ? Math.floor(s / 60) + " min" : Math.floor(s / 3600) + " h";
  return <span title={stamp(iso)}>updated {age} ago</span>;
}
