// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./App";
import { useUi } from "./store";
import { KpiStrip } from "./components/panels";
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
  localStorage.clear();
  useUi.setState({ tab: "dashboard", source: "claude", hourlySource: "all", pins: {}, online: true, modal: null, doneTips: [] });
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
  it("judges the top active session against its own provider's budget", () => {
    const report: Report = { ...fixtureReport, active: [{
      source: "codex", project: "api", id: "codex001", title: "Top Codex session",
      share: 50, turns: 10, peak: 100_000, hours: 1, context: 100_000,
      idle: 1, flags: [], model: "gpt-5.5", rate: 1_000, rateShare: 100,
    }], burns: {
      claude: { ...fixtureReport.burns.claude!, rate: 10_000, goal: 1_000 },
      codex: { ...fixtureReport.burns.codex!, rate: 1_000, goal: 2_000 },
    } };
    render(<KpiStrip r={report} burn={report.burns.claude} />);
    const tile = screen.getByText("Active sessions").closest(".card")!;
    expect(tile.querySelector("span.rounded-full.bg-ok")).not.toBeNull();
    expect(tile.querySelector("span.rounded-full.bg-hot")).toBeNull();
  });

  it("marks a missed target with a red dot and a met target with a green dot", () => {
    render(<KpiStrip r={{ ...fixtureReport, overTarget: 40 }} burn={fixtureReport.burns.claude} />);
    const dot = (label: string) => screen.getByText(label).closest(".card")!.querySelector("span.rounded-full")!;
    expect(dot("Spend >target · 7 d").className).toContain("bg-hot");
    const met = render(<KpiStrip r={{ ...fixtureReport, overTarget: 0 }} burn={fixtureReport.burns.claude} />);
    expect(met.getAllByText("Spend >target · 7 d").at(-1)!.closest(".card")!.querySelector("span.rounded-full")!.className).toContain("bg-ok");
  });

  it("shows every provider's active sessions independently of the burn selector", () => {
    const session: Report["active"][number] = {
      source: "claude", project: "demo", id: "session1", title: null,
      share: 50, turns: 10, peak: 100_000, hours: 1, context: 100_000,
      idle: 1, flags: [], model: "test-model", rate: 1_000, rateShare: 50,
    };
    const report: Report = { ...fixtureReport, active: [
      { ...session, source: "claude", id: "claude01", title: "Claude active" },
      { ...session, source: "codex", id: "codex001", title: "Codex active" },
    ], burns: {
      claude: { ...fixtureReport.burns.claude!, limit: 10_000 },
      codex: { ...fixtureReport.burns.codex!, limit: 20_000 },
    } };
    window.__REPORT__ = report;
    vi.stubGlobal("fetch", okFetch(report));
    render(<App />);
    const table = screen.getByRole("table");
    // The title shows twice per row (cell and the Details block), so count, not getByText.
    const present = (text: string) => within(table).getAllByText(text).length;
    expect(present("Claude active")).toBeGreaterThan(0);
    expect(present("Codex active")).toBeGreaterThan(0);
    expect(within(table).getByText("10.00 %/h")).toBeTruthy();
    expect(within(table).getByText("5.00 %/h")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Combustion rate provider" }), { target: { value: "codex" } });
    expect(present("Claude active")).toBeGreaterThan(0);
    expect(present("Codex active")).toBeGreaterThan(0);
    expect(within(table).getByText("10.00 %/h")).toBeTruthy();
    expect(within(table).getByText("5.00 %/h")).toBeTruthy();
  });

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
      "Spend >target · 7 d",
      "Claude median ctx · 3 h",
      "Turns >target · 3 h",
      "Caller reads · 3 h",
    ]) {
      hasText(label);
    }
    expect(container.querySelector('[aria-label="Burn rate against ideal pace"]'), "gauge").not.toBeNull();
    expect(container.querySelector('[aria-label="Weekly quota used"]'), "weekly quota chart").not.toBeNull();
    expect(container.querySelector('[aria-label="Hourly spend"]'), "hourly chart").not.toBeNull();

    act(() => useUi.getState().setTab("checkup"));
    for (const label of ["Checks", "Leaks", "Copy all fixes"]) {
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
    const selector = screen.getByRole("combobox", { name: "Combustion rate provider" }) as HTMLSelectElement;
    expect(selector.value).toBe("claude");
    fireEvent.change(selector, { target: { value: "codex" } });
    expect(useUi.getState().source).toBe("codex");
    expect(selector.value).toBe("codex");
  });

  it("filters hourly bars independently and only draws the selected provider's goal", () => {
    render(<App />);
    const hourly = screen.getByRole("combobox", { name: "Hourly spend provider" });
    const card = hourly.closest("section")!;
    expect(card.querySelector(".stroke-ok")).toBeNull();
    fireEvent.change(hourly, { target: { value: "codex" } });
    expect(useUi.getState().source).toBe("claude");
    expect(card.querySelectorAll("g")).toHaveLength(fixtureReport.timelines!.codex!.length);
    expect(card.querySelector(".stroke-ok") !== null).toBe(Boolean(fixtureReport.burns.codex?.goal));
    const bars = card.querySelector('svg[aria-label="Hourly spend"]')!.innerHTML;
    fireEvent.change(screen.getByRole("combobox", { name: "Combustion rate provider" }), { target: { value: "codex" } });
    expect(card.querySelector('svg[aria-label="Hourly spend"]')!.innerHTML).toBe(bars);
    fireEvent.change(hourly, { target: { value: "claude" } });
    expect(card.querySelector('svg[aria-label="Hourly spend"]')!.innerHTML).not.toBe(bars);
  });

  it("restores pinned providers after hydration and forgets unpinned selections", async () => {
    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: "Combustion rate provider" }), { target: { value: "codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin combustion rate provider" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Hourly spend provider" }), { target: { value: "claude" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin hourly spend provider" }));
    const saved = localStorage.getItem("token-furnace-provider-pins")!;
    useUi.setState({ source: "claude", hourlySource: "all", pins: {} });
    localStorage.setItem("token-furnace-provider-pins", saved);
    await act(async () => { await useUi.persist.rehydrate(); });
    expect(useUi.getState().source).toBe("codex");
    expect(useUi.getState().hourlySource).toBe("claude");
    fireEvent.click(screen.getByRole("button", { name: "Pin hourly spend provider" }));
    expect(JSON.parse(localStorage.getItem("token-furnace-provider-pins")!).state.pins).toEqual({ source: "codex" });
  });

  it("keeps controls usable when storage is unavailable and falls back for old snapshots", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    window.__REPORT__ = { ...fixtureReport, timelines: undefined };
    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: "Combustion rate provider" }), { target: { value: "codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin combustion rate provider" }));
    expect(useUi.getState().source).toBe("codex");
    expect(screen.getByRole("combobox", { name: "Hourly spend provider" }).querySelectorAll("option")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Hourly spend" })).toBeTruthy();
  });

  it("shows each provider's spend over target with a target dot, and folds the counters into one tip", () => {
    render(<App />);
    for (const label of ["Claude Code >target", "Codex >target"]) {
      const card = screen.getByText(label).closest(".card")!;
      expect(card.textContent).toContain("7 d");
      expect(card.querySelector("span.rounded-full")).not.toBeNull();
    }
    const tip = screen.getByText("Spend >target · 7 d").closest(".card")!.getAttribute("title")!;
    expect(tip).toContain("projects");
    expect(tip).toContain("tool calls");
    expect(screen.queryByText("Tokens / turn")).toBeNull();
  });

  it("falls back from a missing pinned provider and lets the visible provider be pinned", () => {
    useUi.setState({ source: "codex", hourlySource: "codex", pins: { source: "codex", hourlySource: "codex" } });
    window.__REPORT__ = { ...fixtureReport, burns: { claude: fixtureReport.burns.claude },
      timelines: { claude: fixtureReport.timelines!.claude } };
    render(<App />);
    expect((screen.getByRole("combobox", { name: "Combustion rate provider" }) as HTMLSelectElement).value).toBe("claude");
    expect((screen.getByRole("combobox", { name: "Hourly spend provider" }) as HTMLSelectElement).value).toBe("all");
    fireEvent.click(screen.getByRole("button", { name: "Pin combustion rate provider" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin hourly spend provider" }));
    expect(useUi.getState().pins).toEqual({ source: "claude", hourlySource: "all" });
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

describe("tips", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  });

  it("lists the setup tips and hides each one when marked done", () => {
    render(<App />);
    act(() => useUi.getState().setTab("tips"));
    for (const title of ["Run the auto fix", "Add an OpenCode Go plan", "Create a save-tokens plan"]) {
      hasText(title);
    }
    hasText("3 left");
    fireEvent.click(screen.getAllByRole("button", { name: /Done/ })[0]);
    expect(useUi.getState().doneTips).toEqual(["auto-fix"]);
    expect(screen.queryByText("Run the auto fix")).toBeNull();
    hasText("2 left");
  });

  it("completes the auto-fix tip when the fixes are applied", () => {
    render(<App />);
    act(() => useUi.getState().setTab("tips"));
    act(() => { window.dispatchEvent(new Event("config-fixed")); });
    expect(useUi.getState().doneTips).toContain("auto-fix");
    expect(screen.queryByText("Run the auto fix")).toBeNull();
  });

  it("copies the full skill and its setup steps for another agent", () => {
    render(<App />);
    act(() => useUi.getState().setTab("tips"));
    fireEvent.click(screen.getByRole("button", { name: "Copy skill" }));
    const copied = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(copied).toContain("~/.claude/skills/save-tokens-creator/SKILL.md");
    expect(copied).toContain("npx -y token-furnace setup --apply");
    expect(copied).toContain("name: save-tokens-creator");
  });

  it("opens the auto-fix dialog from the first tip and shows an all-set state", () => {
    render(<App />);
    act(() => useUi.getState().setTab("tips"));
    fireEvent.click(screen.getByRole("button", { name: "Open Auto Fixes" }));
    expect(useUi.getState().modal).toBe("auto-fixes");
    act(() => useUi.setState({ modal: null, doneTips: ["auto-fix", "opencode-go", "save-tokens-creator"] }));
    hasText("You are all set. No tips left.");
  });
});

describe("context configuration repair", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  });

  it("shows the repair button on Dashboard even when Checkup has no rows", () => {
    window.__REPORT__ = { ...fixtureReport, baseline: [] };
    render(<App />);
    expect(screen.getByRole("button", { name: "Auto Fixes" }).classList.contains("bg-accent")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Auto Fixes" }));
    expect(screen.getByRole("dialog").textContent).toContain("400,000 tokens");
  });

  it("explains changes, cancels without writing, and applies only after confirmation", async () => {
    const fetcher = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => url === "/api/fix-config" ? { ok: true, output: "Backup: saved\nUpdated: config" } : fixtureReport,
    }));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    act(() => useUi.getState().setTab("checkup"));
    fireEvent.click(screen.getByRole("button", { name: "Auto Fixes" }));
    expect(screen.getByRole("dialog").textContent).toContain("400,000 tokens");
    expect(screen.getByRole("dialog").textContent).toContain("300,000 tokens");
    expect(screen.getByRole("dialog").textContent).toContain("Sonnet");
    expect(screen.getAllByRole("checkbox")).toHaveLength(9);
    expect(screen.getAllByRole("checkbox").every((input) => (input as HTMLInputElement).checked)).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => url === "/api/fix-config")).toBe(false);
    expect(useUi.getState().modal).toBe("auto-fixes");
    fireEvent.click(screen.getByRole("button", { name: "Close modal" }));
    expect(useUi.getState().modal).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Auto Fixes" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Back up and apply" })); });
    expect(fetcher).toHaveBeenCalledWith("/api/fix-config", { method: "POST", headers: { "X-Token-Furnace-Confirm": "true", "X-Token-Furnace-Repairs": "claude-context,claude-workers,claude-tools,claude-model,claude-depth,codex-context,codex-workers,codex-effort,codex-depth" } });
    expect(screen.getByRole("status").textContent).toContain("Backup: saved");
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/report").length).toBeGreaterThan(1);
  });

  it("omits unchecked repairs and disables applying an empty selection", async () => {
    const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/fix-config" ? { ok: true, output: "Updated" } : fixtureReport }));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Auto Fixes" }));
    for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
    expect(screen.getByRole("button", { name: "Back up and apply" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getAllByRole("checkbox")[5]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Back up and apply" })); });
    expect(fetcher).toHaveBeenCalledWith("/api/fix-config", { method: "POST", headers: { "X-Token-Furnace-Confirm": "true", "X-Token-Furnace-Repairs": "codex-context" } });
  });

  it("shows repair errors and allows retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: url !== "/api/fix-config", status: url === "/api/fix-config" ? 500 : 200,
      json: async () => url === "/api/fix-config" ? { ok: false, output: "Invalid TOML; left unchanged" } : fixtureReport })));
    render(<App />);
    act(() => useUi.getState().setTab("checkup"));
    fireEvent.click(screen.getByRole("button", { name: "Auto Fixes" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Back up and apply" })); });
    expect(screen.getByRole("alert").textContent).toContain("Invalid TOML");
    expect(screen.getByRole("button", { name: "Back up and apply" }).hasAttribute("disabled")).toBe(false);
  });
});

it("selects and persists OpenCode independently for both dashboard charts", () => {
  const report = { ...fixtureReport,
    burns: { ...fixtureReport.burns, opencode: { ...fixtureReport.burns.claude!, used: 63 } },
    timelines: { ...fixtureReport.timelines, opencode: fixtureReport.timelines!.claude },
  };
  window.__REPORT__ = report; vi.stubGlobal("fetch", okFetch(report));
  render(<App />);
  fireEvent.change(screen.getByRole("combobox", { name: "Combustion rate provider" }), { target: { value: "opencode" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Hourly spend provider" }), { target: { value: "opencode" } });
  expect(useUi.getState().source).toBe("opencode"); expect(useUi.getState().hourlySource).toBe("opencode");
  act(() => useUi.getState().togglePin("source", "opencode"));
  act(() => useUi.getState().togglePin("hourlySource", "opencode"));
  act(() => useUi.setState({ source: "claude", hourlySource: "all" }));
  act(() => useUi.persist.rehydrate());
  expect(useUi.getState().source).toBe("opencode"); expect(useUi.getState().hourlySource).toBe("opencode");
});
