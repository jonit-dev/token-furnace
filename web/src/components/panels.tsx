import { CONTEXT_TARGET_LABEL, MAX_OVER_TARGET_SHARE } from "../../../src/core/context";
import { sessionFixPrompt } from "../../../src/core/analyze/issues";
import { isSessionSpike } from "../../../src/core/analyze/burn";
import { useId, useState, type ReactNode } from "react";
import type { Burn, ProviderId, Report } from "../../../src/core/model";
import { dayTime, fmt, hoursLabel, kpiFmt, quota, sharePct, SHORT, sourceLabel, toDate } from "./format";
import { Bar, Card, CopyButton, MetricInfo, SourceBadge, SourceSelect, Spark, Tile, WeekBar } from "./ui";
import { Gauge, Hourly, WeeklyQuota, Burndown } from "./charts";
import { Icon } from "./icons";
import { Modal } from "./modal";
import { sessionKey, useUi } from "../store";

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
  const names = useUi((state) => state.sessionNames);
  return (
    <div className="session-table-container -mx-1">
      <table className="session-table w-full text-xs">
        {head ? (
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted [&_th]:font-normal">
              <th className="px-1">Session</th>
              <th className="px-1">Project</th>
              <th className="px-1">Model</th>
              <th className="px-1 text-right" title="Burn rate">Burn</th>
              <th className="px-1" title="Provider burn share">Share</th>
              <th className="px-1 text-right">Ctx</th>
              <th className="px-1 text-right" title="Weighted tokens the latest turn cost">Turn</th>
              <th className="px-1 text-right">Age</th>
              <th className="px-1 text-right">Idle</th>
              <th className="px-1 text-right">Fixes</th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {sessions.map((s) => {
            const title = names[sessionKey(s)] || s.title || "(untitled)";
            const share = Number(s.rateShare) || 0;
            const hot = share >= 50;
            const limit = burns?.[s.source]?.limit;
            const providerLabel = sourceLabel(s.source);
            const n = s.flags?.length ?? 0;
            return (
              <tr key={sessionKey(s)} onClick={() => onOpen(s)} className="border-t border-line cursor-pointer hover:bg-chip/40">
                <td className="px-1 py-1.5 min-w-0 flex items-center gap-1.5">
                  <SourceBadge source={s.source} />
                  {isSessionSpike(s, burns?.[s.source]) ? <span className="shrink-0 rounded border border-accent px-1 text-[10px] font-semibold text-accent" title="Burn spike: above twice this provider's ideal hourly pace">Critical</span> : null}
                  <span className="truncate font-medium min-w-0" title={title}>
                    {title}
                  </span>
                  <button type="button" aria-label={`Rename ${title}`} title="Rename session"
                    onClick={(e) => { e.stopPropagation(); onOpen(s); }}
                    className="shrink-0 p-1 text-muted hover:text-accent focus-visible:outline focus-visible:outline-accent">
                    <Icon name="Pencil" size={12} />
                  </button>
                </td>
                <td data-label="Project" className="px-1 py-1.5 text-muted">
                  <div className="truncate" title={s.project ?? "?"}>{s.project ?? "?"}</div>
                  <div className="truncate text-[10px] text-muted/70" title={s.fullId || s.id}>{s.id}</div>
                </td>
                <td data-label="Model" className="px-1 py-1.5 min-w-0 text-muted">
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
                <td data-label="Last turn" className="px-1 py-1.5 text-right">{fmt(s.lastTurn)}</td>
                <td data-label="Age" className="px-1 py-1.5 text-right whitespace-nowrap">{Number(s.hours || 0).toFixed(1)} h</td>
                <td data-label="Idle" className="px-1 py-1.5 text-right whitespace-nowrap">
                  {(s.idle || 0) < 1 ? "now" : Math.round(s.idle) + " m"}
                </td>
                <td className="px-1 py-1 text-right">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpen(s); }}
                    aria-label={`${n ? `${n} ${n === 1 ? "fix" : "fixes"}` : "Details"} for ${title}`}
                    title="View session and agents"
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                      n ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-chip text-muted"
                    } hover:border-accent focus-visible:outline focus-visible:outline-accent`}
                  >
                    {n ? <><Icon name="TriangleAlert" size={11} />{n}</> : <Icon name="Eye" size={14} />}
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

function SessionNameEditor({ session, onCancel }: { session: ActiveRow; onCancel: () => void }) {
  const key = sessionKey(session);
  const name = useUi((state) => state.sessionNames[key]);
  const setName = useUi((state) => state.setSessionName);
  const showToast = useUi((state) => state.showToast);
  const [draft, setDraft] = useState(name || session.title || "");
  const inputId = useId();
  return <form onSubmit={(e) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || trimmed.length > 200) return;
    setName(key, trimmed);
    onCancel();
    showToast(`Session renamed to “${trimmed}”.`);
  }} className="space-y-2">
    <label htmlFor={inputId} className="block text-muted">Session name</label>
    <input id={inputId} value={draft} onChange={(e) => setDraft(e.target.value)} required maxLength={200}
      className="w-full rounded border border-line bg-bg px-3 py-2 text-ink focus:border-accent focus:outline-none" />
    <p className="text-muted">Saved in this browser. Original transcript stays unchanged.</p>
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={!draft.trim() || draft.trim().length > 200}
        className="rounded border border-accent px-3 py-1 hover:bg-accent/10 disabled:opacity-40">Save name</button>
      <button type="button" onClick={onCancel} className="rounded border border-line px-3 py-1 hover:border-accent">Cancel</button>
      {name && <button type="button" onClick={() => {
        setName(key, null);
        onCancel();
        showToast("Original session name restored.");
      }}
        className="rounded border border-line px-3 py-1 text-muted hover:border-accent">Reset name</button>}
    </div>
  </form>;
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
  const names = useUi((state) => state.sessionNames);
  const stats: [string, string][] = s
    ? [
        ["Burn rate", burnText(s, burns)],
        ["Provider share", `${sharePct(Number(s.rateShare) || 0)} of ${sourceLabel(s.source)}`],
        ["Context", fmt(s.context)],
        ["Last turn", fmt(s.lastTurn)],
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
      title={(s && (names[sessionKey(s)] || s.title || "(untitled)")) || "(untitled)"}
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
          <section aria-label="Recorded agents" className="space-y-2">
            <h3 className="text-[10px] uppercase tracking-wide text-muted">Agents{s.agents ? ` (${s.agents.members.length} recorded · ${s.agents.activeCount} recently active)` : ""}</h3>
            <p className="text-muted">Activity means recorded assistant usage within 30 minutes, not running processes. Models are the last recorded model for each agent.</p>
            {!s.agents || !s.agents.complete ? <p className="text-muted">Agent relationships are partially unavailable. Counts include only detected agents.</p> : null}
            {s.agents ? <ul className="space-y-2">
              {s.agents.members.map(agent => <li key={agent.id} className="rounded-lg border border-line p-2.5 space-y-1">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{agent.role === "parent" ? "Parent session" : agent.role === "subagent" ? "Subagent" : "Relationship unknown"}{agent.name ? ` · ${agent.name}` : ""}</strong>
                  <span className={agent.active ? "text-accent" : "text-muted"}>{agent.active ? "Active within 30 min" : "No recent recorded usage"}</span>
                </div>
                <div>{agent.model || "Model unknown"}</div>
                <div className="break-all text-muted">ID: {agent.id}</div>
                {agent.parentId ? <div className="break-all text-muted">Parent: {agent.parentId}</div> : null}
                {agent.lastSeen ? <div className="text-muted">Last usage: {dayTime(toDate(agent.lastSeen))}</div> : null}
              </li>)}
            </ul> : null}
            <p className="text-muted">Only available local transcripts are included. Codex descendants follow the selected date range. Deleted transcripts may be missing.</p>
          </section>
          <SessionNameEditor key={sessionKey(s)} session={s} onCancel={onClose} />
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
  const modal = useUi((state) => state.modal);
  const setModal = useUi((state) => state.setModal);
  const selectedKey = typeof modal === "object" && modal?.type === "session" ? modal.key : null;
  const selected = sessions.find((s) => sessionKey(s) === selectedKey) ?? null;
  const select = (s: ActiveRow) => setModal({ type: "session", key: sessionKey(s) });
  if (!sessions.length) {
    return <p className="text-sm text-muted">No session had a turn in the last 30 minutes.</p>;
  }
  const needsAttention = (s: ActiveRow) => (s.flags?.length ?? 0) > 0 || isSessionSpike(s, burns?.[s.source]);
  const attention = sessions.filter(needsAttention);
  const others = sessions.filter((s) => !needsAttention(s));
  const close = () => setModal(null);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-accent mb-1 flex items-center gap-1.5">
          <Icon name="TriangleAlert" size={14} />
          Needs attention ({attention.length})
        </h3>
        {attention.length ? (
          <SessionTable sessions={attention} burns={burns} onOpen={select} />
        ) : (
          <p className="text-xs text-muted py-1">No active sessions have triggered leak flags or burn spikes.</p>
        )}
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">
          Other active sessions ({others.length})
        </h3>
        {others.length ? (
          <SessionTable sessions={others} burns={burns} onOpen={select} head={!attention.length} />
        ) : (
          <p className="text-xs text-muted py-1">No other active sessions.</p>
        )}
      </div>
      <SessionModal session={selected} burns={burns} onClose={close} />
    </div>
  );
}

export function ActiveAgents({ r }: { r: Partial<Report> }) {
  const active = r.active ?? [];
  const counts = new Map<string, number>(Object.keys(r.burns ?? {}).map(provider => [provider, 0]));
  for (const session of active) counts.set(session.source, (counts.get(session.source) ?? 0) + 1);
  // Headless runs (codex exec --ephemeral, opencode run) leave no transcript: the server counts them.
  for (const [source, extra] of Object.entries(r.unseenAgents ?? {})) counts.set(source, (counts.get(source) ?? 0) + (extra ?? 0));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return <Card title="Active agents" sub="Across all providers" icon="Users"
    right={<MetricInfo label="Active agents">
      <p>Sessions with a recorded assistant turn in the last 30 minutes, added across all providers. The provider counts break down that total. The server also counts running headless agent processes that leave no transcript (<code>codex exec --ephemeral</code>, <code>opencode run</code>, <code>claude -p</code>). Headless Claude processes count toward the default install. Their history is not recorded, so the chart and peaks use transcripts only.</p>
      <p>The line reconstructs the last 24 hours, sampled every 30 minutes. A session stays active for 30 minutes after each recorded turn; repeated turns from the same session do not add extra agents.</p>
      <p>7d peak is the highest simultaneous count in the last seven days. Lifetime peak covers all available local transcripts, including activity before Token Furnace started. Peaks use exact activity times, so brief overlaps between chart samples still count. Deleted transcripts are excluded.</p>
    </MetricInfo>}>
    <div className="flex items-baseline gap-2 mb-3">
      <strong className="text-4xl font-heading tabular-nums">{total}</strong>
      <span className="text-xs text-muted">last 30 min</span>
    </div>
    <ul aria-label="Active agents by provider" className="space-y-1 text-xs mb-4">
      {[...counts].map(([provider, count]) => (
        <li key={provider} className="flex justify-between gap-3"><span className="text-muted">{sourceLabel(provider)}</span> <span className="tabular-nums">{count}</span></li>
      ))}
    </ul>
    {r.agentActivity ? <div className="mt-auto">
      <div role="img" aria-label="Active agents over the last 24 hours">
        <Spark values={r.agentActivity.timeline.map(([, count]) => count)} className="h-16" />
      </div>
      <div className="flex justify-between text-[10px] text-muted mt-1"><span>24 h ago</span><span>now</span></div>
      <div className="flex flex-wrap justify-between gap-x-2 text-xs text-muted mt-3 pt-3 border-t border-line">
        <span>7d peak <strong className="text-ink tabular-nums">{r.agentActivity.peak7d}</strong></span>
        <span title="Peak across available local transcripts">Lifetime peak <strong className="text-ink tabular-nums">{r.agentActivity.peakLifetime}</strong></span>
      </div>
    </div> : <span className="text-xs text-muted mt-auto">History unavailable</span>}
  </Card>;
}

// Chart height inside a KPI tile: shorter in the one-column phone rows.
const TILE_SPARK = "h-7 sm:h-9";

export function KpiStrip({
  r,
  burn,
  source,
}: {
  r: Partial<Report>;
  burn?: Burn;
  source?: ProviderId;
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
      help={<>
        <p>How fast {source ? sourceLabel(source) : "the selected provider"} used tokens during the last hour. With a quota reading, the number is percentage points of the weekly quota used per hour; otherwise it is weighted tokens per hour.</p>
        <p>Ideal pace spreads the remaining budget over the time until reset. Above that pace, you are spending faster than the remaining budget can sustain.</p>
        <p>The line shows recent hourly spend. The dashed line marks the ideal pace. Weighted tokens adjust usage for model cost, caching, and generated output; they are an estimate of relative cost.</p>
      </>}
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
      <Spark values={inPct ? hourly.map((v) => (100 * v) / pctLimit) : hourly} target={inPct ? idealPct : goal || null} over={overBurn} className={TILE_SPARK} />
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
        help={<>
          <p>The percentage of the selected provider’s weekly quota already used, from its latest subscription reading or local usage estimate.</p>
          <p>The smaller number shows the estimated percentage-point increase over the named period. The bar shows quota used; the marker shows how far through the week you are. Spending ahead of that marker means you are ahead of an even weekly pace.</p>
        </>}
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
        help={<>
          <p>Estimated time until the selected provider’s weekly quota runs out if the recent pace continues. The forecast uses the last 24 hours when a projection is available, otherwise the last hour.</p>
          <p>“Never” means this forecast lasts until the next reset. It is a pace estimate: changing your usage changes the prediction.</p>
          <p>The upper bar compares time until the quota runs out with the lower bar’s time until reset. Red means the quota is expected to run out before reset.</p>
        </>}
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
      <Tile key="week" label="Weekly limit" value={burn?.pending ? `${burn.pending.used}%` : "—"}
        line={burn?.pending ? "plan reading · size unknown until this week has spend" : "no subscription reading yet"} state={null}
        help={<p>This card shows the percentage of the selected provider’s weekly quota already used. There is no subscription reading yet, so usage against the weekly limit is unknown. A dash means unavailable data.</p>} />,
    );
  }
  const days = r.days ?? 0;
  // One "spend over the context target" tile; the all-provider tile and each provider tile share it.
  const overTile = (key: string, label: string, rows: Report["timeline"], over: number, total: number, tip: string, provider?: ProviderId) => {
    const max = MAX_OVER_TARGET_SHARE * 100;
    return (
      <Tile
        key={key}
        label={label}
        help={<>
          <p>{Math.round(over)}% of {provider ? `${sourceLabel(provider)}’s` : "all providers’"} weighted token spend in the last {days} days came from turns whose context was above the recommended target.</p>
          <p>Context is the input the model sees for a turn: instructions, conversation, and tool results, including cached input. {provider ? `The ${sourceLabel(provider)} target is ${fmt(r.contextTargets?.[provider])} tokens.` : `Each provider uses its own target: ${Object.entries(r.contextTargets ?? {}).map(([id, target]) => `${sourceLabel(id)} ${fmt(target)}`).join("; ")}.`} These are recommended working sizes, not the models’ maximum context limits.</p>
          <p>The whole turn’s spend counts toward this percentage, including output; it does not count only the input beyond the target. Weighted tokens adjust usage for model cost and caching. The smaller {fmt(total)} number is total weighted spend over {days} days.</p>
          <p>The line shows the above-target spend share for each of the last 24 recorded hourly buckets. The dashed line marks the {max}% goal. Lower is better: compact a long conversation or start a fresh session when its accumulated context is no longer useful.</p>
        </>}
        value={Math.round(over) + "%"}
        line={fmt(total) + " · " + days + " d"}
        tip={tip}
        state={over > max ? "over" : "ok"}
      >
        <Spark
          values={rows.slice(-24).map((t) => (100 * (t[2] ?? 0)) / (((t[1] ?? 0) + (t[2] ?? 0)) || 1))}
          target={max}
          over={over > max}
          className={TILE_SPARK}
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
        help={<>
          <p>{k.unit === "k"
            ? `${k.name}: the middle context size among this provider’s turns in the latest recorded three-hour block. Half the turns had a context at or below this size. Context includes instructions, conversation, tool results, and cached input.`
            : k.name === "Caller reads per tool call"
              ? "The percentage of tool calls that read files or logs into the main agent’s own context in the latest recorded three-hour block. For example, 46% means about 46 out of every 100 tool calls were these reads."
              : "The percentage of turns whose context exceeded their own provider’s recommended context target in the latest recorded three-hour block. Every turn counts equally here, regardless of its token spend."}</p>
          <p>{k.unit === "k"
            ? `The recommended target is ${kpiFmt(k, k.target)} tokens. It is a working-size recommendation, not the model’s maximum capacity.`
            : `The goal is at most ${kpiFmt(k, k.target)}. ${k.name === "Caller reads per tool call" ? "Delegate bounded file-reading tasks when their results can be summarized, to reduce context accumulated by the main agent." : "Compact long conversations or start fresh sessions to reduce large-context turns."}`}</p>
          <p>The line shows successive recorded three-hour blocks; gaps without recorded activity are omitted. The dashed line marks the target. Lower is better. A red dot means the latest value exceeds the target.</p>
        </>}
        tip={k.name + " · latest 3 h block" + (k.target != null ? " · target " + kpiFmt(k, k.target) : "")}
        value={last == null ? "—" : kpiFmt(k, last)}
        line={k.target != null ? "target " + kpiFmt(k, k.target) : ""}
        state={k.target == null || last == null ? null : isOver ? "over" : "ok"}
      >
        <Spark values={vals} target={k.target ?? null} over={isOver} className={TILE_SPARK} />
      </Tile>,
    );
  }
  for (const provider of Object.keys(r.timelines ?? {}) as ProviderId[]) {
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
        provider,
      ),
    );
  }
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">{tiles}</div>;
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
  sources: ProviderId[];
  source?: ProviderId;
  onSource: (source: ProviderId) => void;
}) {
  const hourlySource = useUi((state) => state.hourlySource);
  const setHourlySource = useUi((state) => state.setHourlySource);
  const pins = useUi((state) => state.pins);
  const togglePin = useUi((state) => state.togglePin);
  const hourlySources = r.providers?.map((provider) => provider.id) ?? Object.keys(r.timelines ?? {});
  const hourlyCurrent = hourlySources.includes(hourlySource) ? hourlySource : "all";
  const hourlyRows = hourlyCurrent === "all" ? r.timeline ?? [] : r.timelines?.[hourlyCurrent] ?? [];
  const hourlyGoal = hourlyCurrent === "all" ? undefined : r.burns?.[hourlyCurrent]?.goal;
  const toggle = source ? <SourceSelect sources={sources} value={source}
    onChange={(value) => { if (value !== "all") onSource(value); }} label="Combustion rate"
    pinned={pins.source === source} onPin={() => togglePin("source", source)} /> : null;
  const weeklyBurns = r.burns ?? (r.burn ? { claude: r.burn } : {});
  const weekly = Object.values(weeklyBurns).some(b => (b?.weekBurndown?.length ?? 0) > 1 || b?.pending);
  return (
    <div className="space-y-4">
      {source && r.providers && !(r.timelines?.[source]?.length) ? <p className="text-muted">No sessions in range</p> : null}
      <div className="grid gap-4 lg:grid-cols-4">
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
        <ActiveAgents r={r} />
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
