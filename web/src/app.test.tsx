// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./App";
import { useUi } from "./store";
import type { Report } from "../../src/core/model";
import { buildFull, saveUsageReading } from "../../test/fixtures/build";
import { fixedNow, harnessEnv, tsReport } from "../../test/harness";

// The fixture Report the analysis tests use, built once from the shared harness.
const root = mkdtempSync(join(tmpdir(), "tf-web-"));
const now = fixedNow();
buildFull(root, now);
saveUsageReading(root, now);
const fixtureReport = tsReport(harnessEnv(root, now), now, 7, null, "all") as Report;

// jsdom has no ResizeObserver. Hand the measured size back at once, so charts draw.
class ResizeObserverMock {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb(
      [{ contentRect: { width: 600, height: 200 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

const okFetch = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  window.__REPORT__ = fixtureReport;
  useUi.setState({ tab: "dashboard", source: "claude", online: true });
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("fetch", okFetch(fixtureReport));
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hasText = (label: string) => expect(screen.queryAllByText(label).length, label).toBeGreaterThan(0);

describe("App", () => {
  it("renders every legacy panel for the fixture report", () => {
    const { container } = render(<App />);

    for (const label of [
      "Combustion rate",
      "Weekly quota",
      "Act now",
      "Active sessions",
      "Hourly spend by context",
      "Burn / hour",
      "Weekly limit",
      "Meltdown ETA",
      "Spend >300k · 7 d",
      "Median ctx · 3 h",
      "Turns >300k · 3 h",
      "Caller reads · 3 h",
    ]) {
      hasText(label);
    }
    expect(container.querySelector('[aria-label="Burn rate against ideal pace"]'), "gauge").not.toBeNull();
    expect(container.querySelector('[aria-label="Weekly quota used"]'), "weekly quota chart").not.toBeNull();
    expect(container.querySelector('[aria-label="Hourly spend"]'), "hourly chart").not.toBeNull();

    act(() => useUi.getState().setTab("checkup"));
    for (const label of ["Checks", "Leaks", "Copy all fixes", "Sessions compact too late"]) {
      hasText(label);
    }

    act(() => useUi.getState().setTab("sessions"));
    for (const label of [
      "Top sessions",
      "Context size buckets",
      "Projects",
      "Tools",
      "Config checks",
    ]) {
      hasText(label);
    }
  });

  it("switches the burn source when both sources are present", () => {
    render(<App />);
    const codex = screen.getByRole("button", { name: "Codex" });
    expect(codex.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(codex);
    expect(useUi.getState().source).toBe("codex");
    expect(screen.getByRole("button", { name: "Codex" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("copies the issue prompt to the clipboard", () => {
    render(<App />);
    act(() => useUi.getState().setTab("checkup"));
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(fixtureReport.issues[0].prompt);
  });

  it("shows snapshot and does not fetch for a file URL", () => {
    vi.stubGlobal("location", { protocol: "file:", hash: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(screen.getByText("snapshot")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the fixture totals and shows offline after a rejected refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    render(<App />);
    expect(await screen.findByText("offline")).toBeTruthy();
    expect(useUi.getState().online).toBe(false);
    hasText("16M · 7 d");
    hasText("Combustion rate");
  });

  it("refreshes every 60 s and ignores a 202 scanning payload", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => fixtureReport })
      .mockResolvedValue({ ok: true, status: 202, json: async () => ({ scanning: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useUi.getState().online).toBe(true);
    hasText("16M · 7 d");
  });
});
