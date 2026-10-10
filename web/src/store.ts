import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Source } from "../../src/core/model";

export type Tab = "dashboard" | "checkup" | "sessions";

interface UiState {
  /** Active tab id. */
  tab: Tab;
  modal: "auto-fixes" | null;
  setModal: (modal: UiState["modal"]) => void;
  /** Burn source shown on the dashboard. */
  source: Source;
  hourlySource: Source | "all";
  pins: Partial<Record<"source" | "hourlySource", Source | "all">>;
  setHourlySource: (source: Source | "all") => void;
  togglePin: (chart: "source" | "hourlySource", value: Source | "all") => void;
  /** False after a failed refresh. */
  online: boolean;
  setTab: (tab: Tab) => void;
  setSource: (source: Source) => void;
  setOnline: (online: boolean) => void;
}

// UI state only. Report data stays in useReport().
export const useUi = create<UiState>()(persist((set) => ({
  tab: "dashboard",
  modal: null,
  setModal: (modal) => set({ modal }),
  source: "claude",
  hourlySource: "all",
  pins: {},
  setHourlySource: (hourlySource) => set((state) => ({ hourlySource,
    pins: state.pins.hourlySource ? { ...state.pins, hourlySource } : state.pins,
  })),
  togglePin: (chart, value) => set((state) => {
    const pins = { ...state.pins };
    if (pins[chart] === value) delete pins[chart];
    else pins[chart] = value;
    return { pins, ...(chart === "source" && value !== "all" ? { source: value } : { hourlySource: value }) };
  }),
  online: true,
  setTab: (tab) => set({ tab }),
  setSource: (source) => set((state) => ({ source,
    pins: state.pins.source ? { ...state.pins, source } : state.pins,
  })),
  setOnline: (online) => set({ online }),
}), {
  name: "token-furnace-provider-pins",
  storage: createJSONStorage(() => ({
    getItem: (name) => { try { return localStorage.getItem(name); } catch { return null; } },
    setItem: (name, value) => { try { localStorage.setItem(name, value); } catch { /* Storage is optional. */ } },
    removeItem: (name) => { try { localStorage.removeItem(name); } catch { /* Storage is optional. */ } },
  })),
  partialize: (state) => ({ pins: state.pins }),
  merge: (saved, current) => {
    const pins = (saved as { pins?: UiState["pins"] } | undefined)?.pins;
    const valid = (value: unknown): value is Source => value === "claude" || value === "codex" || value === "opencode";
    const source = valid(pins?.source) ? pins.source : undefined;
    const hourlySource = valid(pins?.hourlySource) || pins?.hourlySource === "all" ? pins.hourlySource : undefined;
    return { ...current, source: source ?? current.source, hourlySource: hourlySource ?? current.hourlySource,
      pins: { ...(source ? { source } : {}), ...(hourlySource ? { hourlySource } : {}) },
    };
  },
}));
