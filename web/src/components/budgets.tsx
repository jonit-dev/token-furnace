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
  const [drafts, setDrafts] = useState<Record<string, BudgetDraft>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, BudgetDraft>>({});
  const [stop, setStop] = useState<{ scope: BudgetScope; title: string } | null>(null);
  const [adapterPreview, setAdapterPreview] = useState<{ source: string; output: string } | null>(null);
  const [adapterBusy, setAdapterBusy] = useState(false);
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
  const savePolicy = async (policy: BudgetPolicy, key: string, label: string) => {
    if (!snapshot || !canWrite) return;
    const policies = snapshot.policies.filter((candidate) => sourceKey(candidate) !== key);
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
      showToast(`${label} budget saved.`);
    } catch (saveError) {
      showToast(saveError instanceof Error ? saveError.message : "Budget could not be saved.", "error");
      void load();
    }
  };
  const save = (source: BudgetSourceStatus) => {
    const draft = drafts[source.source] ?? draftFor(source);
    return savePolicy({
      scope: { kind: "source", source: source.source }, mode: draft.mode,
      unit: draft.mode === "auto" ? "percentage-per-hour" : draft.unit,
      limit: draft.mode === "manual" ? Number(draft.limit) : null,
      deadline: draft.mode === "manual" && draft.unit === "tokens-total" && draft.deadline ? new Date(draft.deadline).toISOString() : null,
    }, `source:${source.source}`, source.label);
  };
  const saveModel = (source: BudgetSourceStatus, scope: { kind: "model"; provider: string; model: string }, draft: BudgetDraft) => savePolicy({
    scope, mode: draft.mode, unit: draft.mode === "off" ? "tokens-total" : draft.unit,
    limit: draft.mode === "manual" ? Number(draft.limit) : null,
    deadline: draft.mode === "manual" && draft.unit === "tokens-total" && draft.deadline ? new Date(draft.deadline).toISOString() : null,
  }, `model:${scope.provider}/${scope.model}`, `${source.label} ${scope.model}`);

  const previewEnable = async (source: string) => {
    if (!snapshot || !canWrite) return;
    setAdapterBusy(true);
    try {
      const response = await fetch("/api/budgets/enable-preview", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Token-Furnace-Mutation": snapshot.mutationToken },
        body: JSON.stringify({}),
      });
      const data = await response.json() as { output?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Adapter preview could not be read.");
      setAdapterPreview({ source, output: data.output ?? "No adapter changes are required." });
    } catch (previewError) {
      showToast(previewError instanceof Error ? previewError.message : "Adapter preview could not be read.", "error");
    } finally {
      setAdapterBusy(false);
    }
  };
  const enable = async () => {
    if (!snapshot || !canWrite) return;
    setAdapterBusy(true);
    try {
      const response = await fetch("/api/budgets/enable", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Token-Furnace-Mutation": snapshot.mutationToken },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await response.json() as { output?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Enforcement could not be enabled.");
      setAdapterPreview(null);
      showToast(data.output?.includes("Partial") ? "Enforcement enabled with partial source coverage." : "Enforcement enabled.");
      void load();
    } catch (enableError) {
      showToast(enableError instanceof Error ? enableError.message : "Enforcement could not be enabled.", "error");
    } finally {
      setAdapterBusy(false);
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
      {snapshot.sources.map((source) => <BudgetCard key={source.source} source={source} policies={snapshot.policies} draft={drafts[source.source] ?? draftFor(source)} modelDrafts={modelDrafts} setDraft={(draft) => setDrafts((current) => ({ ...current, [source.source]: draft }))} setModelDraft={(key, draft) => setModelDrafts((current) => ({ ...current, [key]: draft }))} onSave={() => void save(source)} onSaveModel={(scope, draft) => void saveModel(source, scope, draft)} onEnable={() => void previewEnable(source.label)} canWrite={canWrite} onStopSource={() => setStop({ scope: { kind: "source", source: source.source }, title: `Stop all ${source.label}` })} onStopProvider={(provider) => setStop({ scope: { kind: "provider", provider }, title: `Stop provider ${provider}` })} onStopModel={(model) => { const scope = modelScope(source.source, model); if (scope) setStop({ scope, title: `Stop model ${scope.provider}/${scope.model}` }); }} />)}
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
      {adapterPreview ? <Modal open onClose={() => { if (!adapterBusy) setAdapterPreview(null); }} title={`Enable ${adapterPreview.source} enforcement`} description={<p>Review the exact native adapter edits before confirmation. Existing hooks are backed up and unrelated entries are preserved.</p>} busy={adapterBusy} footer={<div className="flex justify-end gap-2"><button type="button" disabled={adapterBusy} onClick={() => setAdapterPreview(null)} className="rounded-md border border-line px-3 py-2 text-sm">Cancel</button><button type="button" disabled={adapterBusy} onClick={() => void enable()} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-black">Confirm and enable</button></div>}><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-chip p-3 text-xs">{adapterPreview.output}</pre><p className="mt-3 text-xs text-muted">Review Codex hook trust in the native client after installation. Coverage remains Partial until real qualification proves each native path.</p></Modal> : null}
    </div>
  );
}

type BudgetDraft = { mode: BudgetMode; limit: string; unit: "tokens-per-hour" | "tokens-total"; deadline: string };

function BudgetCard({ source, policies, draft, modelDrafts, setDraft, setModelDraft, onSave, onSaveModel, onEnable, canWrite, onStopSource, onStopProvider, onStopModel }: {
  source: BudgetSourceStatus;
  policies: BudgetPolicy[];
  draft: BudgetDraft;
  modelDrafts: Record<string, BudgetDraft>;
  setDraft: (draft: BudgetDraft) => void;
  setModelDraft: (key: string, draft: BudgetDraft) => void;
  onSave: () => void;
  onSaveModel: (scope: { kind: "model"; provider: string; model: string }, draft: BudgetDraft) => void;
  onEnable: () => void;
  canWrite: boolean;
  onStopSource: () => void;
  onStopProvider: (provider: string) => void;
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
          {draft.unit === "tokens-total" ? "Weighted token allowance" : "Weighted tokens per hour"}
          <input id={`${source.source}-budget-limit`} aria-label={`${source.label} budget limit`} type="number" min="1" step="1" value={draft.limit} disabled={disabled} onChange={(event) => setDraft({ ...draft, limit: event.target.value })} className="mt-1 w-full rounded-md border border-line bg-chip px-2 py-2 text-sm" />
        </label>
      ) : null}
      {mode === "manual" ? <>
        <label className="mt-3 block text-xs font-medium" htmlFor={`${source.source}-budget-unit`}>Manual budget unit</label>
        <select id={`${source.source}-budget-unit`} aria-label={`${source.label} budget unit`} value={draft.unit} disabled={disabled} onChange={(event) => setDraft({ ...draft, unit: event.target.value as BudgetDraft["unit"] })} className="mt-1 w-full rounded-md border border-line bg-chip px-2 py-2 text-sm">
          <option value="tokens-per-hour">Weighted tokens per hour</option>
          <option value="tokens-total">Fixed allowance until deadline</option>
        </select>
        {draft.unit === "tokens-total" ? <label className="mt-3 block text-xs font-medium" htmlFor={`${source.source}-budget-deadline`}>Deadline
          <input id={`${source.source}-budget-deadline`} aria-label={`${source.label} budget deadline`} type="datetime-local" value={draft.deadline} disabled={disabled} onChange={(event) => setDraft({ ...draft, deadline: event.target.value })} className="mt-1 w-full rounded-md border border-line bg-chip px-2 py-2 text-sm" />
        </label> : null}
      </> : null}
      <p className="mt-3 min-h-8 text-[11px] leading-4 text-muted">{mode === "auto" ? "Uses a fresh authoritative quota and continuous time until reset." : mode === "manual" && draft.unit === "tokens-total" ? "The allowance is cumulative until the explicit deadline; edits do not grant extra credit." : mode === "manual" ? "New admissions stop when the measured hourly allowance is full." : "Observe only. Existing emergency stops still apply."}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={disabled || (mode === "manual" && !(Number(draft.limit) > 0))} onClick={onSave} aria-label={`Save ${source.label} budget`} className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-black disabled:cursor-not-allowed disabled:opacity-40">Save budget</button>
        {mode !== "off" ? <button type="button" disabled={disabled} onClick={onEnable} aria-label={`Enable ${source.label} enforcement`} className="rounded-md border border-accent/60 px-3 py-2 text-xs text-accent disabled:cursor-not-allowed disabled:opacity-40">Enable enforcement</button> : null}
        <button type="button" disabled={disabled || !source.installed} onClick={onStopSource} aria-label={`Stop all ${source.label}`} className="rounded-md border border-hot/50 px-3 py-2 text-xs text-hot disabled:cursor-not-allowed disabled:opacity-40">Stop all {source.label}</button>
      </div>
      {(source.providers ?? []).length ? <div className="mt-4 border-t border-line pt-3"><h3 className="text-xs font-medium">Upstream providers</h3><div className="mt-2 flex flex-wrap gap-2">{(source.providers ?? []).map((provider) => <button key={provider} type="button" disabled={disabled || !source.installed} onClick={() => onStopProvider(provider)} aria-label={`Stop provider ${provider}`} className="rounded border border-hot/50 px-2 py-1 text-[11px] text-hot disabled:cursor-not-allowed disabled:opacity-40">Stop provider {provider}</button>)}</div></div> : null}
      <div className="mt-4 border-t border-line pt-3">
        <h3 className="text-xs font-medium">Models</h3>
        {models.length ? <ul className="mt-2 space-y-3">{models.map((model) => {
          const scope = modelScope(source.source, model);
          const key = scope ? `model:${scope.provider}/${scope.model}` : "";
          const modelDraft = scope ? modelDrafts[key] ?? draftForPolicy(policies, scope) : null;
          return <li key={model} className="text-xs"><div className="flex items-center justify-between gap-2"><span className="truncate" title={model}>{model}</span><button type="button" disabled={disabled || !source.installed || !scope} onClick={() => onStopModel(model)} className="shrink-0 rounded border border-hot/50 px-2 py-1 text-[11px] text-hot disabled:cursor-not-allowed disabled:opacity-40">Stop model</button></div>{scope && modelDraft ? <div className="mt-2 grid gap-2 sm:grid-cols-3"><select aria-label={`${model} budget mode`} value={modelDraft.mode} disabled={disabled} onChange={(event) => setModelDraft(key, { ...modelDraft, mode: event.target.value as BudgetMode })} className="rounded border border-line bg-chip px-2 py-1"><option value="off">Off</option><option value="manual">Manual</option></select>{modelDraft.mode === "manual" ? <input aria-label={`${model} budget limit`} type="number" min="1" value={modelDraft.limit} disabled={disabled} onChange={(event) => setModelDraft(key, { ...modelDraft, limit: event.target.value })} className="rounded border border-line bg-chip px-2 py-1" /> : null}{modelDraft.mode === "manual" ? <><select aria-label={`${model} budget unit`} value={modelDraft.unit} disabled={disabled} onChange={(event) => setModelDraft(key, { ...modelDraft, unit: event.target.value as BudgetDraft["unit"] })} className="rounded border border-line bg-chip px-2 py-1"><option value="tokens-per-hour">Tokens/hour</option><option value="tokens-total">Fixed allowance</option></select>{modelDraft.unit === "tokens-total" ? <input aria-label={`${model} budget deadline`} type="datetime-local" value={modelDraft.deadline} disabled={disabled} onChange={(event) => setModelDraft(key, { ...modelDraft, deadline: event.target.value })} className="rounded border border-line bg-chip px-2 py-1" /> : null}<button type="button" disabled={disabled || !(Number(modelDraft.limit) > 0) || (modelDraft.unit === "tokens-total" && !modelDraft.deadline)} onClick={() => onSaveModel(scope, modelDraft)} className="rounded border border-accent/60 px-2 py-1 text-accent">Save model budget</button></> : null}</div> : null}</li>;
        })}</ul> : <p className="mt-2 text-[11px] text-muted">No model identity discovered yet.</p>}
      </div>
    </Card>
  );
}

function StopDialog({ snapshot, selection, onClose, onDone }: { snapshot: BudgetSnapshot & { mutationToken: string }; selection: { scope: BudgetScope; title: string }; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(true);
  const [forceReady, setForceReady] = useState(false);
  const [forceArmed, setForceArmed] = useState(false);
  const [preview, setPreview] = useState<(StopPreview & { targets?: Array<{ id: string; source: string; provider: string | null; model: string | null; pid: number; executable?: string | null }>; unverified?: Array<{ id: string; detail: string }>; collateral?: Array<{ id: string; detail: string }> }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const headers = { "content-type": "application/json", "X-Token-Furnace-Mutation": snapshot.mutationToken };
    fetch("/api/budgets/stop-preview", { method: "POST", headers, body: JSON.stringify({ scope: selection.scope }) })
      .then(async (response) => {
        const data = await response.json() as StopPreview & { error?: string; targets?: Array<{ id: string; source: string; provider: string | null; model: string | null; pid: number; executable?: string | null }> };
        if (!response.ok) throw new Error(data.error ?? "Stop preview failed.");
        if (active) { setPreview(data as typeof preview); setBusy(false); }
      })
      .catch((cause) => { if (active) { setError(cause instanceof Error ? cause.message : "Stop preview failed."); setBusy(false); } });
    return () => { active = false; };
  }, [selection.scope, snapshot.mutationToken]);
  const confirm = async (force = false) => {
    if (!preview && !force) return;
    setBusy(true);
    try {
      const headers = { "content-type": "application/json", "X-Token-Furnace-Mutation": snapshot.mutationToken };
      let selectedPreview = preview;
      if (force) {
        const freshResponse = await fetch("/api/budgets/stop-preview", { method: "POST", headers, body: JSON.stringify({ scope: selection.scope }) });
        const fresh = await freshResponse.json() as typeof preview & { error?: string };
        if (!freshResponse.ok) throw new Error(fresh.error ?? "Force-stop preview failed.");
        selectedPreview = fresh;
      }
      if (!selectedPreview) return;
      const response = await fetch("/api/budgets/stop", { method: "POST", headers, body: JSON.stringify({ previewId: selectedPreview.id, fingerprint: selectedPreview.fingerprint, ...(force ? { force: true, forceConfirm: true } : {}) }) });
      const operation = await response.json() as StopOperation & { error?: string };
      if (!response.ok) throw new Error(operation.error ?? "Stop failed.");
      if (operation.status === "complete") onDone();
      else {
        setPreview(null);
        setForceReady(operation.outcomes.some((outcome) => outcome.status !== "cancelled" && outcome.status !== "terminated"));
        setForceArmed(false);
        setError("The latch is active, but one or more matching sessions remain unresolved. Force escalation is a separate confirmation and never widens the reviewed scope.");
        setBusy(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Stop failed.");
      setBusy(false);
    }
  };
  return <Modal open onClose={onClose} title={selection.title} description={<p>Only verified matching sessions are targeted. This does not change your budget policy.</p>} busy={busy} footer={<div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className="rounded-md border border-line px-3 py-2 text-sm">Cancel</button>{forceReady ? forceArmed ? <button type="button" disabled={busy} onClick={() => void confirm(true)} className="rounded-md bg-hot px-3 py-2 text-sm font-medium text-white">Confirm force stop</button> : <button type="button" disabled={busy} onClick={() => setForceArmed(true)} className="rounded-md border border-hot px-3 py-2 text-sm text-hot">Arm force stop</button> : <button type="button" disabled={busy || !preview} onClick={() => void confirm()} className="rounded-md bg-hot px-3 py-2 text-sm font-medium text-white">Confirm stop</button>}</div>}><p className="text-sm text-muted">The preview is fetched before confirmation. Saving, previewing, and cancelling never signal a process.</p>{error ? <p role="alert" className="mt-3 text-sm text-hot">{error}</p> : null}{preview ? <div className="mt-3 space-y-2 text-xs"><p><strong>{preview.targets?.length ?? 0}</strong> verified matching session(s).</p>{preview.unverified?.length ? <p className="text-warn"><strong>{preview.unverified.length}</strong> unverified session(s): {preview.unverified.map((item) => item.detail).join("; ")}</p> : null}{preview.collateral?.length ? <p className="text-warn"><strong>{preview.collateral.length}</strong> collateral item(s) require explicit force scope.</p> : null}</div> : <p className="mt-3 text-sm text-muted">{forceReady ? "The first stop left matching work unresolved." : "Loading verified stop preview…"}</p>}</Modal>;
}

function draftFor(source: BudgetSourceStatus): BudgetDraft {
  return { mode: source.policy?.mode ?? "off", limit: source.policy?.limit == null ? "" : String(source.policy.limit), unit: source.policy?.unit === "tokens-total" ? "tokens-total" : "tokens-per-hour", deadline: source.policy?.deadline?.slice(0, 16) ?? "" };
}

function draftForPolicy(policies: BudgetPolicy[], scope: { kind: "model"; provider: string; model: string }): BudgetDraft {
  const policy = policies.find((candidate) => sourceKey(candidate) === `model:${scope.provider}/${scope.model}`);
  return { mode: policy?.mode ?? "off", limit: policy?.limit == null ? "" : String(policy.limit), unit: policy?.unit === "tokens-total" ? "tokens-total" : "tokens-per-hour", deadline: policy?.deadline?.slice(0, 16) ?? "" };
}

function sourceKey(policy: BudgetPolicy): string {
  return policy.scope.kind === "source" ? `source:${policy.scope.source}` : `${policy.scope.kind}:${policy.scope.kind === "provider" ? policy.scope.provider : `${policy.scope.provider}/${policy.scope.model}`}`;
}

function modelScope(source: BudgetSourceStatus["source"], value: string): { kind: "model"; provider: string; model: string } | null {
  const slash = value.indexOf("/");
  if (slash > 0 && slash < value.length - 1) return { kind: "model", provider: value.slice(0, slash), model: value.slice(slash + 1) };
  if (source === "opencode") return null;
  const provider = source === "claude" ? "anthropic" : "openai";
  return { kind: "model", provider, model: value };
}

function scopeLabel(scope: BudgetScope): string {
  if (scope.kind === "source") return scope.source;
  if (scope.kind === "provider") return `provider ${scope.provider}`;
  return `model ${scope.provider}/${scope.model}`;
}
