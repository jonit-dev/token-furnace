import { create } from "zustand";
import type { Source } from "../../src/core/model";

export type Tab = "dashboard" | "checkup" | "sessions";

interface UiState {
  /** Active tab id. */
  tab: Tab;
  modal: "auto-fixes" | null;
  setModal: (modal: UiState["modal"]) => void;
  /** Burn source shown on the dashboard. */
  source: Source;
  /** False after a failed refresh. */
  online: boolean;
  setTab: (tab: Tab) => void;
  setSource: (source: Source) => void;
  setOnline: (online: boolean) => void;
}

// UI state only. Report data stays in useReport().
export const useUi = create<UiState>()((set) => ({
  tab: "dashboard",
  modal: null,
  setModal: (modal) => set({ modal }),
  source: "claude",
  online: true,
  setTab: (tab) => set({ tab }),
  setSource: (source) => set({ source }),
  setOnline: (online) => set({ online }),
}));
