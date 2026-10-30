import { providerLabel, PROVIDERS } from "../../../src/core/providers";

// Formatting helpers, ported from web/legacy/dashboard.html. Each one accepts missing values.

export function fmt(n: number | null | undefined): string {
  const value = Number(n);
  if (!isFinite(value)) return "—";
  const a = Math.abs(value);
  if (a >= 1e9) return (value / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (value / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return (value / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(value));
}

export function pct(x: number | null | undefined): string {
  const v = (Number(x) || 0) * 100;
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + "%";
}

export function sharePct(s: number | null | undefined): string {
  return (Number(s) || 0).toFixed(1) + "%";
}

export function plural(n: number, word: string): string {
  return n + " " + word + (n === 1 ? "" : "s");
}

export function toDate(iso: string | null | undefined): Date {
  return new Date(String(iso ?? "").replace(/(\.\d{3})\d+/, "$1"));
}

export function clock(d: Date): string {
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

export function dayLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function stamp(iso: string | null | undefined): string {
  return iso && !isNaN(toDate(iso).getTime()) ? toDate(iso).toLocaleString() : "—";
}

export function sourceLabel(s: string): string {
  try {
    return providerLabel(s);
  } catch {
    return s;
  }
}

export const SHORT: Record<string, string> = {
  "Claude Code median context per turn": "Claude median ctx",
  "Codex median context per turn": "Codex median ctx",
  "Turns over provider context target": "Turns >target",
  "Caller reads per tool call": "Caller reads",
};

export function quota(v: number | null | undefined): string {
  return (Number(v) || 0).toFixed(2) + " %/h";
}

export function kpiFmt(kpi: { unit: string }, v: number): string {
  return kpi.unit === "%" ? pct(v) : fmt(v);
}

export function hoursLabel(h: number): string {
  return h >= 48 ? (h / 24).toFixed(1) + " d" : Math.round(h) + " h";
}

export function dayTime(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short" }) + " " + clock(d);
}

// Severity word and dot. Critical is filled coral, warn an outline, ok green, info grey.
export const LEVEL: Record<string, [string, string, string]> = {
  critical: ["bg-accent", "text-accent", "Critical"],
  warn: ["border border-accent", "text-muted", "Warn"],
  ok: ["bg-ok", "text-muted", "OK"],
  info: ["bg-muted", "text-muted", "Info"],
};

export const LEVEL_ORDER = ["critical", "warn", "ok", "info"];

// Which agent a check or leak belongs to.
export const SOURCE_LABEL: Record<string, string> = {
  ...Object.fromEntries(Object.entries(PROVIDERS).map(([id, provider]) => [id, provider.label])),
  all: "All providers",
};

// Shared table header style.
export const TH =
  "text-[11px] uppercase tracking-wide text-muted font-normal [&_th]:font-normal";

// Clipboard API first. A hidden textarea and execCommand are the fallback.
export function copyText(text: string): void {
  const fallback = () => {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    try {
      document.execCommand("copy");
    } catch {
      // ignore: the copy simply does not happen
    }
    document.body.removeChild(el);
  };
  if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
}
