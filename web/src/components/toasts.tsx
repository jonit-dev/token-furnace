import { useEffect, useState } from "react";
import { useUi } from "../store";
import { Icon } from "./icons";

/** Mount once in App; any component can call useUi.getState().showToast(). */
export function Toasts() {
  const toast = useUi((state) => state.toast);
  const dismiss = useUi((state) => state.dismissToast);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!toast) {
      setHovered(false);
      setFocused(false);
      return;
    }
    if (toast.tone === "error" || hovered || focused) return;
    const timer = setTimeout(dismiss, 6000);
    return () => clearTimeout(timer);
  }, [toast, hovered, focused, dismiss]);

  const error = toast?.tone === "error";
  return <div role={toast ? (error ? "alert" : "status") : undefined} aria-live={error ? "assertive" : "polite"} aria-atomic="true"
    className="pointer-events-none fixed bottom-5 left-4 right-4 z-50 flex justify-center">
    {toast && <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
      className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm text-ink shadow-xl ${error ? "border-hot/60" : "border-ok/50"}`}>
      <span aria-hidden="true" className={error ? "text-hot" : "text-ok"}>
        <Icon name={error ? "TriangleAlert" : "Check"} size={18} />
      </span>
      <span className="min-w-0 flex-1 break-words">{toast.message}</span>
      <button type="button" aria-label="Dismiss notification" onClick={dismiss}
        className="flex size-8 shrink-0 items-center justify-center rounded text-xl text-muted hover:bg-chip hover:text-ink focus-visible:outline focus-visible:outline-accent">
        <span aria-hidden="true">×</span>
      </button>
    </div>}
  </div>;
}
