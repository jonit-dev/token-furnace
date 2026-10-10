import { useState, type ReactNode } from "react";
import type { BaselineRow, Issue, Report } from "../../../src/core/model";
import { fmt, LEVEL, LEVEL_ORDER, plural, sharePct, SOURCE_LABEL, TH } from "./format";
import { Card, CopyButton, LevelTag, SourceBadge } from "./ui";

// One row per leak. The row opens in place; the prompt holds the why text and the evidence lines.
function LeakRow({ i, open, onToggle }: { i: Issue; open: boolean; onToggle: () => void }) {
  const meta = i.share == null ? "config check" : `${Math.round(i.share)}% · ${plural(i.sessions ?? 0, "session")}`;
  const why = (String(i.prompt ?? "").match(/Why it costs tokens: (.*)/) ?? [])[1];
  const evidence = String(i.prompt ?? "")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    // "- title (session id, 20.4% of spend, ...): label: measure. advice" -> "title · id · 20.4% · measure"
    .map((l) => {
      const m = l.match(/^- (.*) \(session (\w+), ([\d.]+)% of spend[^)]*\): [^:]+: (.*?)(?:\. |\.$|$)/);
      return m ? [m[1], m[2], m[3] + "%", m[4].replace(" in this session", "")].join(" · ") : l.slice(2);
    });
  return (
    <li className="border-t border-line first:border-t-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex-1 min-w-0 text-left grid items-center gap-x-3 gap-y-0.5 py-2 grid-cols-[4.5rem_minmax(0,1fr)] md:grid-cols-[4.5rem_19rem_15.5rem_minmax(0,1fr)]"
        >
          <LevelTag level={i.level ?? "info"} />
          <span className="text-sm font-medium truncate" title={i.title}>
            {i.title}
          </span>
          <span className="col-start-2 md:col-start-auto flex items-center gap-2 text-xs text-muted">
            <span className="w-20 h-1.5 rounded bg-line overflow-hidden shrink-0">
              {i.share == null ? null : (
                <span
                  className="block h-full bg-ink opacity-60"
                  style={{ width: Math.min(100, Math.max(0, i.share)) + "%" }}
                />
              )}
            </span>
            <span className="whitespace-nowrap">{meta}</span>
          </span>
          <span className="hidden md:flex items-center gap-2 text-xs text-muted truncate" title={i.fix}>
            <SourceBadge source={i.source} />
            <span className="truncate">{i.fix}</span>
          </span>
        </button>
        <CopyButton
          text={i.prompt}
          label="Copy"
          className="shrink-0 w-14 text-center text-[11px] px-2 py-0.5 bg-chip rounded border border-line hover:border-accent"
        />
      </div>
      {open ? (
        <div className="pl-[5.25rem] pb-3 space-y-2 text-xs">
          {why ? <p className="text-muted">{why}</p> : null}
          {evidence.length ? (
            <ul className="space-y-0.5 text-muted list-disc pl-4">
              {evidence.map((e, n) => (
                <li key={n}>{e}</li>
              ))}
            </ul>
          ) : null}
          <pre className="p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words bg-bg rounded border border-line">
            {i.prompt}
          </pre>
        </div>
      ) : null}
    </li>
  );
}

export function Leaks({ issues, hours }: { issues: Report["issues"]; hours: number }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!issues.length)
    return (
      <Card title="Leaks" icon="TriangleAlert">
        <p className="text-sm text-muted">No leaks in the last {hours} h.</p>
      </Card>
    );
  const all = issues.map((i) => i.prompt).filter(Boolean).join("\n\n");
  const keyOf = (i: Issue) => i.title + "|" + (i.source ?? "");
  const copyAll = (
    <CopyButton
      text={all}
      label="Copy all fixes"
      className="text-xs px-2.5 py-1 bg-chip rounded-lg border border-line hover:border-accent"
    />
  );
  return (
    <Card title="Leaks" icon="TriangleAlert" right={copyAll}>
      <p className="text-xs text-muted mb-2">
        From sessions active in the last {hours} h. One session can trigger several leaks, so the shares overlap.
      </p>
      <ul>
        {issues.map((i) => (
          <LeakRow
            key={keyOf(i)}
            i={i}
            open={open === keyOf(i)}
            onToggle={() => setOpen(open === keyOf(i) ? null : keyOf(i))}
          />
        ))}
      </ul>
    </Card>
  );
}

// Worst level first, then the biggest miss. A green arrow marks a 24 h value that beats the whole-window value (lower is better).
export function Checks({ rows, hours, days }: { rows: Report["baseline"]; hours: number; days: number }) {
  if (!rows.length) return null;
  // Evaluate per provider: group each agent's rows together, worst level first.
  const srcOrder: Record<string, number> = { claude: 0, codex: 1, all: 2 };
  const sorted = [...rows].sort(
    (a, b) =>
      (srcOrder[a.source] ?? 3) - (srcOrder[b.source] ?? 3) ||
      LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) ||
      (b.ratio ?? 0) - (a.ratio ?? 0),
  );
  const better = (row: BaselineRow) => parseFloat(row.now_24h) < parseFloat(row.value_7d ?? "");
  const summary = LEVEL_ORDER.map((l) => [l, rows.filter((r) => r.level === l).length] as [string, number])
    .filter(([, n]) => n)
    .map(([l, n]) => n + " " + LEVEL[l][2].toLowerCase())
    .join(" · ");
  const bySource = ["claude", "codex"]
    .map((s) => [s, rows.filter((r) => r.source === s).length] as [string, number])
    .filter(([, n]) => n)
    .map(([s, n]) => n + " " + SOURCE_LABEL[s])
    .join(" · ");
  return (
    <Card title="Checks" icon="ListChecks" right={<span className="text-xs text-muted">{summary}</span>}>
      <p className="text-xs text-muted mb-1">
        Judged per provider ({bySource}). Checks and leaks use the last {hours} h; the {days}-day value is in grey.
      </p>
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className={`text-left whitespace-nowrap ${TH}`}>
              <th className="px-2 py-1">Check</th>
              <th className="px-2">Last {hours} h</th>
              <th className="px-2">{days} d</th>
              <th className="px-2 hidden sm:table-cell">Target</th>
              <th className="px-2">Level</th>
              <th className="px-2">Source</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.name + "|" + row.source} className="border-t border-line">
                <td className="px-2 py-1">
                  {row.name}
                  {row.advisory ? (
                    <span className="text-[11px] text-muted" title="Advisory: a hint, never a leak">
                      {" "}
                      advisory
                    </span>
                  ) : null}
                  <div className="sm:hidden text-[11px] text-muted">{row.target}</div>
                </td>
                <td className="px-2 py-1 whitespace-nowrap">
                  {row.now_24h}
                  {better(row) ? (
                    <span className="text-ok" title={"Better than the " + days + "-day value"}>
                      {" "}
                      ↓
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-1 text-muted whitespace-nowrap">{row.value_7d ?? ""}</td>
                <td className="px-2 py-1 text-muted whitespace-nowrap hidden sm:table-cell">{row.target}</td>
                <td className="px-2 py-1 whitespace-nowrap">
                  <LevelTag level={row.level} />
                </td>
                <td className="px-2 py-1 whitespace-nowrap">
                  <SourceBadge source={row.source} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto -mx-2">
      <table className="w-full text-sm">
        <thead>
          <tr className={TH}>
            {headers.map((h) => (
              <th key={h} className="px-2 py-1.5 text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-line align-top">
              {row.map((c, j) => (
                <td key={j} className="px-2 py-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ title, headers, rows }: { title: string; headers: string[]; rows: ReactNode[][] }) {
  return rows.length ? (
    <Card title={title}>
      <SimpleTable headers={headers} rows={rows} />
    </Card>
  ) : null;
}

export function Sessions({ r }: { r: Partial<Report> }) {
  const unpriced = r.unpriced ?? null;
  const blocks: { title: string; headers: string[]; rows: ReactNode[][] }[] = [
    {
      title: "Top sessions",
      headers: ["Project", "ID", "Title", "Share", "Turns", "Peak", "Hours"],
      rows: (r.topSessions ?? []).map((s) => [
        s.project ?? "?",
        s.id ?? "",
        <div key="title" className="truncate max-w-[22rem]" title={s.title || s.id}>
          {s.title || s.id}
        </div>,
        sharePct(s.share),
        s.turns ?? 0,
        fmt(s.peak),
        Number(s.hours || 0).toFixed(1) + "h",
      ]),
    },
    {
      title: "Context size buckets",
      headers: ["Bucket", "Above provider target", "Share", "Turns"],
      rows: (r.buckets ?? []).map((b) => [b.label, sharePct(b.aboveTargetShare), sharePct(b.share), b.turns ?? 0]),
    },
    {
      title: "Projects",
      headers: ["Project", "Share"],
      rows: (r.projects ?? []).map(([n, s]) => [n, sharePct(s)]),
    },
    {
      title: "Tools",
      headers: ["Tool", "Calls"],
      rows: (r.tools ?? []).map(([n, c]) => [n, c]),
    },
    {
      title: "Config checks",
      headers: ["Check"],
      rows: (r.config ?? []).filter((c) => c !== "none").map((c) => [c]),
    },
    {
      title: unpriced ? `Unpriced models (${sharePct(unpriced[0])} of spend)` : "Unpriced models",
      headers: ["Model", "Turns"],
      rows: (unpriced?.[1] ?? []).map(([m, c]) => [m, c]),
    },
  ];
  if (!blocks.some((b) => b.rows.length))
    return (
      <Card>
        <p className="text-sm text-muted">No detail data.</p>
      </Card>
    );
  return (
    <div className="space-y-4">
      {blocks.map((b) => (
        <Block key={b.title} title={b.title} headers={b.headers} rows={b.rows} />
      ))}
    </div>
  );
}
