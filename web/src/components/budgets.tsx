import { useCallback, useEffect, useState } from "react";
import type { BudgetPolicy, BudgetMode, BudgetScope } from "../../../src/core/budgets";
import type { BudgetSnapshot, BudgetSourceStatus, StopPreview, StopOperation } from "../../../src/services/budget-service";
import { useUi } from "../store";
import { Card } from "./ui";
import { Modal } from "./modal";

const live = location.protocol === "http:" || location.protocol === "https:";
const POLL_MS = 60_000;

export function Budgets() {
  const [snapshot, setSnapshot] = useState<BudgetSnapshot & { mutationToken: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, { mode: BudgetMode; limit: string }>>({});
  const [stop, setStop] = useState<{ source: BudgetSourceStatus; model?: string } | null>(null);
  const showToast = useUi((state) => state.showToast);

  const load = useCallback(async () => {
    if (!live) {
      setError("Start the live dashboard with token-furnace serve to edit budgets.");
      setLoading(false);
      return;
    }
    try {
      const response = await fetch("/api/budgets", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as BudgetSnapshot & { mutationToken: string };
      setSnapshot(data);
      setDrafts((current) => Object.fromEntries(data.sources.map((source) => [source.source, current[source.source] ?? draftFor(source)])));
      setError(null);
    } catch {
      setError("Budget settings could not be read from the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (!live) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const canWrite = live && Boolean(snapshot?.mutationToken) && !error && !snapshot?.error;
  const save = async (source: BudgetSourceStatus) => {
    if (!snapshot || !canWrite) return;
    const draft = drafts[source.source] ?? draftFor(source);
    const policy: BudgetPolicy = {
      scope: { kind: "source", source: source.source },
      mode: draft.mode,
      unit: draft.mode === "auto" ? "percentage-per-hour" : "tokens-per-hour",
      limit: draft.mode === "manual" ? Number(draft.limit) : null,
      deadline: null,
    };
    const policies = snapshot.policies.filter((candidate) => sourceKey(candidate) !== `source:${source.source}`);
    policies.push(policy);
    try {
      const response = await fetch("/api/budgets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Token-Furnace-Mutation": snapshot.mutationToken,
        },
        body: JSON.stringify({ expectedRevision: snapshot.revision, policies }),
      });
      const data = await response.json() as { revision?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setSnapshot((current) => current ? { ...current, revision: data.revision ?? current.revision + 1, policies } : current);
      showToast(`${source.label} budget saved.`);
    } catch (saveError) {
      showToast(saveError instanceof Error ? saveError.message : "Budget could not be saved.", "error");
      void load();
    }
  };

  const enable = async () => {
    if (!snapshot || !canWrite) return;
    try {
      const response = await fetch("/api/budgets/enable", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Token-Furnace-Mutation": snapshot.mutationToken },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await response.json() as { output?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Enforcement could not be enabled.");
      showToast(data.output?.includes("Partial") ? "Enforcement enabled with partial source coverage." : "Enforcement enabled.");
      void load();
    } catch (enableError) {
      showToast(enableError instanceof Error ? enableError.message : "Enforcement could not be enabled.", "error");
    }
  };

  const unlock = async (scope: BudgetScope) => {
    if (!snapshot || !canWrite) return;
    try {
      const response = await fetch("/api/budgets/unlock", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Token-Furnace-Mutation": snapshot.mutationToken },
        body: JSON.stringify({ scope }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Budget stop could not be unlocked.");
      showToast(`Unlocked ${scopeLabel(scope)}.`);
      void load();
    } catch (unlockError) {
      showToast(unlockError instanceof Error ? unlockError.message : "Budget stop could not be unlocked.", "error");
    }
  };

  if (!live) return <p className="text-sm text-muted py-6">{error ?? "Budgets require the live dashboard."}</p>;
  if (loading && !snapshot) return <p className="text-sm text-muted py-6">Loading budgets…</p>;
  if (!snapshot) return <p role="status" className="text-sm text-warn py-6">{error ?? "Budget settings are unavailable."}</p>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Budgets</h1>
        <p className="mt-1 text-sm text-muted">Pace new work without changing report calculations. Emergency stops remain available when budgets are Off.</p>
      </div>
      {error ? <p role="status" className="text-xs text-warn">{error}</p> : null}
      {snapshot.error ? <p role="status" className="text-xs text-hot">{snapshot.error}</p> : null}
      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
        {snapshot.sources.map((source) => <BudgetCard key={source.source} source={source} draft={drafts[source.source] ?? draftFor(source)} setDraft={(draft) => setDrafts((current) => ({ ...current, [source.source]: draft }))} onSave={() => save(source)} onEnable={enable} canWrite={canWrite} onStop={() => setStop({ source })} onStopModel={(model) => setStop({ source, model })} />)}
      </div>
      {snapshot.stops.length ? (
        <section aria-labelledby="budget-stop-recovery" className="rounded-md border border-hot/30 bg-hot/5 p-4">
          <h2 id="budget-stop-recovery" className="text-sm font-semibold">Emergency stops</h2>
          <p className="mt-1 text-xs text-muted">Unlock only the exact scope you have reviewed. Existing sessions are not restarted.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {snapshot.stops.map((stop) => <button key={`${stop.operationId}:${scopeLabel(stop.scope)}`} type="button" disabled={!canWrite} onClick={() => void unlock(stop.scope)} className="rounded-md border border-hot/50 px-3 py-2 text-xs text-hot disabled:cursor-not-allowed disabled:opacity-40">Unlock {scopeLabel(stop.scope)}</button>)}
          </div>
        </section>
      ) : null}
      {stop ? <StopDialog snapshot={snapshot} selection={stop} onClose={() => setStop(null)} onDone={() => { setStop(null); void load(); }} /> : null}
    </div>
  );
}

function BudgetCard({ source, draft, setDraft, onSave, onEnable, canWrite, onStop, onStopModel }: {
  source: BudgetSourceStatus;
  draft: { mode: BudgetMode; limit: string };
  setDraft: (draft: { mode: BudgetMode; limit: string }) => void;
  onSave: () => void;
  onEnable: () => void;
  canWrite: boolean;
  onStop: () => void;
  onStopModel: (model: string) => void;
}) {
  const disabled = !canWrite;
  const mode = draft.mode;
  const models = source.models ?? [];
  return (
    <Card title={source.label} sub={source.installed ? "Installed source" : "Not installed"}>
      <div className="flex items-center justify-between gap-2">
        <span className={`rounded px-2 py-0.5 text-xs ${source.status === "Emergency stopped" ? "bg-hot/15 text-hot" : "bg-chip text-muted"}`}>{source.status}</span>
        <span className="text-[11px] text-muted">{source.coverage}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-muted">Current usage</dt><dd className="mt-1 font-medium">{source.meter ? `${source.meter.usedPercentagePoints.toFixed(1)}%` : "Unavailable"}</dd></div>
        <div><dt className="text-muted">Allowed pace</dt><dd className="mt-1 font-medium">{source.allowance == null ? "—" : `${source.allowance.toFixed(2)} ${mode === "auto" ? "%/h" : "tokens/h"}`}</dd></div>
      </dl>
      <label className="mt-4 block text-xs font-medium" htmlFor={`${source.source}-budget-mode`}>Mode</label>
      <select id={`${source.source}-budget-mode`} aria-label={`${source.label} budget mode`} value={mode} disabled={disabled} onChange={(event) => setDraft({ ...draft, mode: event.target.value as BudgetMode })} className="mt-1 w-full rounded-md border border-line bg-chip px-2 py-2 text-sm">
        <option value="off">Off</option>
        <option value="auto">Auto</option>
        <option value="manual">Manual</option>
      </select>
      {mode === "manual" ? (
        <label className="mt-3 block text-xs font-medium" htmlFor={`${source.source}-budget-limit`}>
          Weighted tokens per hour
          <input id={`${source.source}-budget-limit`} aria-label={`${source.label} budget limit`} type="number" min="1" step="1" value={draft.limit} disabled={disabled} onChange={(event) => setDraft({ ...draft, limit: event.target.value })} className="mt-1 w-full rounded-md border border-line bg-chip px-2 py-2 text-sm" />
        </label>
      ) : null}
      <p className="mt-3 min-h-8 text-[11px] leading-4 text-muted">{mode === "auto" ? "Uses a fresh authoritative quota and continuous time until reset." : mode === "manual" ? "New admissions stop when the measured hourly allowance is full." : "Observe only. Existing emergency stops still apply."}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={disabled || (mode === "manual" && !(Number(draft.limit) > 0))} onClick={onSave} aria-label={`Save ${source.label} budget`} className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-black disabled:cursor-not-allowed disabled:opacity-40">Save budget</button>
        {mode !== "off" ? <button type="button" disabled={disabled} onClick={onEnable} aria-label={`Enable ${source.label} enforcement`} className="rounded-md border border-accent/60 px-3 py-2 text-xs text-accent disabled:cursor-not-allowed disabled:opacity-40">Enable enforcement</button> : null}
        <button type="button" disabled={disabled || !source.installed} onClick={onStop} aria-label={`Stop ${source.label} provider`} className="rounded-md border border-hot/50 px-3 py-2 text-xs text-hot disabled:cursor-not-allowed disabled:opacity-40">Stop provider</button>
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <h3 className="text-xs font-medium">Models</h3>
        {models.length ? <ul className="mt-2 space-y-2">{models.map((model) => <li key={model} className="flex items-center justify-between gap-2 text-xs"><span className="truncate" title={model}>{model}</span><button type="button" disabled={disabled || !source.installed} onClick={() => onStopModel(model)} className="shrink-0 rounded border border-hot/50 px-2 py-1 text-[11px] text-hot disabled:cursor-not-allowed disabled:opacity-40">Stop model</button></li>)}</ul> : <p className="mt-2 text-[11px] text-muted">No model identity discovered yet.</p>}
      </div>
    </Card>
  );
}

function StopDialog({ snapshot, selection, onClose, onDone }: { snapshot: BudgetSnapshot & { mutationToken: string }; selection: { source: BudgetSourceStatus; model?: string }; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const scope = selection.model ? modelScope(selection.source.source, selection.model) : { kind: "source", source: selection.source.source };
  const title = selection.model ? `Stop ${selection.source.label} model` : `Stop ${selection.source.label} provider`;
  const confirm = async () => {
    setBusy(true);
    try {
      const headers = { "content-type": "application/json", "X-Token-Furnace-Mutation": snapshot.mutationToken };
      const previewResponse = await fetch("/api/budgets/stop-preview", { method: "POST", headers, body: JSON.stringify({ scope }) });
      const preview = await previewResponse.json() as StopPreview & { error?: string };
      if (!previewResponse.ok) throw new Error(preview.error ?? "Stop preview failed.");
      const response = await fetch("/api/budgets/stop", { method: "POST", headers, body: JSON.stringify({ previewId: preview.id, fingerprint: preview.fingerprint }) });
      const operation = await response.json() as StopOperation & { error?: string };
      if (!response.ok) throw new Error(operation.error ?? "Stop failed.");
      onDone();
    } catch {
      setBusy(false);
    }
  };
  return <Modal open onClose={onClose} title={title} description={<p>Only verified matching sessions are targeted. This does not change your budget policy.</p>} busy={busy} footer={<div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className="rounded-md border border-line px-3 py-2 text-sm">Cancel</button><button type="button" disabled={busy} onClick={confirm} className="rounded-md bg-hot px-3 py-2 text-sm font-medium text-white">Confirm stop</button></div>}><p className="text-sm text-muted">The emergency latch remains active until you explicitly unlock this exact scope. Unverified or collateral work is reported instead of being signalled.</p></Modal>;
}

function draftFor(source: BudgetSourceStatus): { mode: BudgetMode; limit: string } {
  return { mode: source.policy?.mode ?? "off", limit: source.policy?.limit == null ? "" : String(source.policy.limit) };
}

function sourceKey(policy: BudgetPolicy): string {
  return policy.scope.kind === "source" ? `source:${policy.scope.source}` : `${policy.scope.kind}:${policy.scope.kind === "provider" ? policy.scope.provider : `${policy.scope.provider}/${policy.scope.model}`}`;
}

function modelScope(source: BudgetSourceStatus["source"], value: string): { kind: "model"; provider: string; model: string } {
  const slash = value.indexOf("/");
  if (slash > 0 && slash < value.length - 1) return { kind: "model", provider: value.slice(0, slash), model: value.slice(slash + 1) };
  const provider = source === "claude" ? "anthropic" : source === "codex" ? "openai" : "opencode-go";
  return { kind: "model", provider, model: value };
}

function scopeLabel(scope: BudgetScope): string {
  if (scope.kind === "source") return scope.source;
  if (scope.kind === "provider") return `provider ${scope.provider}`;
  return `model ${scope.provider}/${scope.model}`;
}
