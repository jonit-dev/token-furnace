import { useEffect, useId, useRef, type ReactNode } from "react";

export function Modal({ open, onClose, title, description, children, footer, busy = false }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  return <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onClose={() => { if (open && !busy) onClose(); }}
    className="w-[calc(100%-2rem)] max-w-lg max-h-[85dvh] overflow-hidden m-auto p-0 rounded-xl border border-line bg-card text-ink backdrop:bg-black/70 open:flex open:flex-col">
    <header className="shrink-0 border-b border-line p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-lg font-heading font-semibold">{title}</h2>
        <button type="button" aria-label="Close modal" disabled={busy} onClick={onClose}
          className="-mt-1 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-2xl text-muted hover:bg-chip hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {description && <div id={descriptionId} className="mt-3 text-sm text-muted space-y-3">{description}</div>}
    </header>
    <div className="min-h-0 overflow-y-auto overscroll-contain p-5">{children}</div>
    <footer className="shrink-0 border-t border-line p-5">{footer}</footer>
  </dialog>;
}
