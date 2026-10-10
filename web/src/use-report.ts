import { useEffect, useState } from "react";
import type { Report } from "../../src/core/model";
import { useUi } from "./store";

declare global {
  interface Window {
    /** Report JSON that the server inlines, or null when no report is embedded. */
    __REPORT__: Report | null;
  }
}

const REFRESH_MS = 60_000;

/** Report data. Starts from window.__REPORT__ and refreshes over http(s) only. */
export function useReport(): Report | null {
  const [report, setReport] = useState<Report | null>(window.__REPORT__);
  const setOnline = useUi((state) => state.setOnline);

  useEffect(() => {
    // A file: page keeps the report it embeds.
    if (location.protocol !== "http:" && location.protocol !== "https:") return undefined;

    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/report", { cache: "no-store" });
        // 202 means the server is still scanning: keep the last report and stay online.
        if (response.status === 202) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: unknown = await response.json();
        if (!active) return;
        // shortcut: trusts the server to send a Report. Add a runtime check if that stops being true.
        if (data) setReport(data as Report);
        setOnline(true);
      } catch {
        // A failed refresh keeps the last report and marks the page offline.
        if (active) setOnline(false);
      }
    };

    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      // A late response after unmount must not touch state.
      active = false;
      clearInterval(timer);
    };
  }, [setOnline]);

  return report;
}
