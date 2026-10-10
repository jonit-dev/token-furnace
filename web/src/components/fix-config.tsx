import { CONFIG_REPAIRS, type ConfigRepairId } from "../../../src/core/config-repairs";
import { useEffect, useState } from "react";
import { useUi } from "../store";
import { Modal } from "./modal";

export function FixConfig() {
  const open = useUi((state) => state.modal === "auto-fixes");
  const setModal = useUi((state) => state.setModal);
  const [selected, setSelected] = useState<ConfigRepairId[]>(() => CONFIG_REPAIRS.map((repair) => repair.id));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [done, setDone] = useState(false);
  const live = location.protocol === "http:" || location.protocol === "https:";

  useEffect(() => {
    if (open) {
      setDone(false);
      setResult("");
      setSelected(CONFIG_REPAIRS.map((repair) => repair.id));
    }
  }, [open]);

  async function apply() {
    if (!selected.length) return;
    setBusy(true);
    setResult("");
    try {
      const response = await fetch("/api/fix-config", {
        method: "POST",
        headers: { "X-Token-Furnace-Confirm": "true", "X-Token-Furnace-Repairs": selected.join(",") },
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.output || data.error || `HTTP ${response.status}`);
      setDone(true);
      setResult(data.output);
      window.dispatchEvent(new Event("config-fixed"));
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Could not update configuration. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button type="button" disabled={!live} title={live ? undefined : "Open the live dashboard with token-furnace serve"}
      className="text-xs px-2.5 py-1 bg-accent text-bg font-semibold rounded-lg border border-accent hover:brightness-110 disabled:opacity-50"
      onClick={() => setModal("auto-fixes")}>
      Auto Fixes
    </button>
    <Modal open={open} onClose={() => setModal(null)} busy={busy}
      title={done ? "Configuration updated" : "Fix agent configuration?"}
      description={<>
        <p>Choose which settings to repair on the machine running this dashboard. Uncheck anything you want to keep unchanged.</p>
        <p>Existing changed files are backed up before writing. Lower limits, pinned worker models and unrelated settings are preserved. Missing selected config files are created.</p>
      </>}
      footer={<div className="flex justify-end gap-2">
        <button type="button" autoFocus disabled={busy} onClick={() => setModal(null)}
          className="px-3 py-2 text-sm bg-chip border border-line rounded-lg disabled:opacity-50">{done ? "Close" : "Cancel"}</button>
        {!done && <button type="button" disabled={busy || !selected.length} onClick={apply}
          className="px-3 py-2 text-sm bg-accent text-bg font-semibold rounded-lg disabled:opacity-50">{busy ? "Saving backups…" : "Back up and apply"}</button>}
      </div>}>
      {!done && <div className="space-y-4">
        {(["claude", "codex"] as const).map((provider) => <fieldset key={provider} disabled={busy} className="space-y-2">
          <legend className="mb-2 font-heading font-semibold">{provider === "claude" ? "Claude Code" : "Codex"}</legend>
          {CONFIG_REPAIRS.filter((repair) => repair.provider === provider).map((repair) => <label key={repair.id} className="flex items-start gap-3 rounded-lg border border-line p-3 cursor-pointer hover:border-accent">
            <input type="checkbox" checked={selected.includes(repair.id)} onChange={(event) => {
              setSelected((current) => event.target.checked ? [...current, repair.id] : current.filter((id) => id !== repair.id));
            }} className="mt-1 accent-accent" />
            <span className="text-sm">{repair.label}<span className="block text-xs text-muted mt-1">{repair.detail}</span></span>
          </label>)}
        </fieldset>)}
        <p className="text-xs text-muted" aria-live="polite">{selected.length} of {CONFIG_REPAIRS.length} repairs selected. Restart agents after applying. Shell environment overrides must be unset in your shell.</p>
      </div>}
      {result && <pre role={done ? "status" : "alert"} className="mt-4 p-3 text-xs whitespace-pre-wrap break-words rounded-lg bg-bg border border-line max-h-48 overflow-auto">{result}</pre>}
    </Modal>
  </>;
}
