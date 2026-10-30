// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Burn } from "../../src/core/model";
import { Gauge, WeeklyQuota } from "./components/charts";
import { ActiveAgents, Dashboard } from "./components/panels";

const hour = 3600000;
const start = Date.parse("2026-10-01T00:00:00Z");
const iso = (h: number) => new Date(start + h * hour).toISOString();
const burn = (offset = 0, used = 50, limit = 1000000): Burn => ({
  rate: 100, goal: 100, basis: "test", resets: iso(offset + 168), start: iso(offset),
  hoursLeft: 96, used, gains: null, limit, ratePct: 1, idealPct: 1,
  weekBurndown: [[iso(offset), 0, 0], [iso(72), used, used / 2]],
  projection: { ratePct: 1, hoursToEmpty: 100 - used, runsOut: iso(72 + 100 - used) },
});
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() { this.cb([{ contentRect: { width: 600, height: 200 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    disconnect() {}
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shares percentage and calendar coordinates despite unequal limits and reset dates", () => {
  const { container } = render(<WeeklyQuota burns={{ claude: burn(), codex: burn(24, 50, 9000000) }} />);
  const groups = container.querySelectorAll("g[data-provider]");
  expect(groups).toHaveLength(2);
  expect(groups[0].querySelector('[data-series="used"]')?.getAttribute("stroke")).toBe("#f97316");
  expect(groups[1].querySelector('[data-series="used"]')?.getAttribute("stroke")).toBe("#4a9eff");
  const all = render(<WeeklyQuota burns={{ claude: burn(), "claude:personal": burn(), codex: burn(), opencode: burn() }} />);
  const strokes = [...all.container.querySelectorAll('[data-series="used"]')].map((p) => p.getAttribute("stroke"));
  expect(new Set(strokes).size).toBe(4);
  all.unmount();
  // Shared range Oct 1–9: 550 pixels wide. Now Oct 4 is 72/192 across it.
  for (const g of groups) {
    expect(Number(g.querySelector("circle")?.getAttribute("cx"))).toBeCloseTo(38 + 550 * 72 / 192);
    expect(Number(g.querySelector("circle")?.getAttribute("cy"))).toBe(94);
    const projection = g.querySelector('[data-series="projection"]')!;
    expect(Number(projection.getAttribute("x2"))).toBeCloseTo(38 + 550 * 122 / 192);
    expect(Number(projection.getAttribute("y2"))).toBe(12);
  }
  expect(groups[0].querySelector('[data-series="used"]')?.getAttribute("d")).toMatch(/^M38.0,176.0/);
  expect(groups[1].querySelector('[data-series="used"]')?.getAttribute("d")).toMatch(/^M106.8,176.0/);
});

it("extends the percentage scale for over-quota history without backward projections", () => {
  const { container } = render(<WeeklyQuota burns={{ claude: burn(0, 125), codex: burn(24, 50) }} />);
  expect(screen.getByText("125%")).toBeTruthy();
  const claude = container.querySelector('[data-provider="claude"]')!;
  expect(Number(claude.querySelector("circle")?.getAttribute("cy"))).toBe(12);
  expect(claude.querySelector('[data-series="projection"]')).toBeNull();
});

it("ends slow projections at their provider reset below 100%", () => {
  const slow = { ...burn(), projection: { ratePct: 0.1, hoursToEmpty: 500, runsOut: null } };
  const { container } = render(<WeeklyQuota burns={{ claude: slow }} />);
  const projection = container.querySelector('[data-series="projection"]')!;
  expect(Number(projection.getAttribute("x2"))).toBe(588);
  expect(Number(projection.getAttribute("y2"))).toBeCloseTo(176 - 59.6 / 100 * 164);
});

it("keeps all available quota series when switching the gauge to a provider without quota", () => {
  const burns = { claude: { ...burn(), weekBurndown: null }, codex: burn(24) };
  const onSource = vi.fn();
  const { container, rerender } = render(<Dashboard r={{ burns }} burn={burns.codex} sources={["claude", "codex"]} source="codex" onSource={onSource} />);
  const before = container.querySelector('[data-series="used"]')?.getAttribute("d");
  fireEvent.change(screen.getByRole("combobox", { name: "Combustion rate provider" }), { target: { value: "claude" } });
  expect(onSource).toHaveBeenCalledWith("claude");
  rerender(<Dashboard r={{ burns }} burn={burns.claude} sources={["claude", "codex"]} source="claude" onSource={onSource} />);
  expect(container.querySelector('[data-provider="codex"]')).not.toBeNull();
  expect(container.querySelector('[data-series="used"]')?.getAttribute("d")).toBe(before);
});

it("draws OpenCode alongside Claude and Codex with a distinct quota color", () => {
  const { container } = render(<WeeklyQuota burns={{ claude: burn(), codex: burn(), opencode: burn(24, 63) }} />);
  expect(container.querySelectorAll("g[data-provider]")).toHaveLength(3);
  expect(container.querySelector('[data-provider="opencode"] [data-series="used"]')?.getAttribute("stroke")).toBe("#a78bfa");
});

it("explains a new quota that reads under 1% behind a warning button", () => {
  render(<Gauge burn={{ ...burn(), ratePct: null, idealPct: null, pending: { used: 0, resets: iso(168) } }} />);
  fireEvent.click(screen.getByRole("button", { name: /Why there is no quota reading/ }));
  expect(screen.getByText(/reports the weekly quota as 0% used/)).toBeTruthy();
});

// A new week has the plan's reading but no local spend, so there is no burndown to draw.
const fresh = (used: number, resetsAtHour = 168): Burn =>
  ({ ...burn(), weekBurndown: null, start: null, resets: null, used: null, limit: null, projection: null,
    pending: { used, resets: iso(resetsAtHour) } });

it("draws a new OpenCode week from the plan reading, on the same scale as the other providers", () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start + 72 * hour);
  try {
    const { container } = render(<WeeklyQuota burns={{ claude: burn(), opencode: fresh(5) }} />);
    expect(container.querySelectorAll("g[data-provider]")).toHaveLength(2);
    const go = container.querySelector('[data-provider="opencode"]')!;
    expect(go.querySelector('[data-series="used"]')?.getAttribute("stroke")).toBe("#a78bfa");
    expect(go.querySelector("title")?.textContent).toContain("5% used");
    // 5% of the 164 px plot: y = 176 - 8.2. Now is 72 h into a 168 h week, on the Oct 1–8 axis.
    expect(Number(go.querySelector("circle")?.getAttribute("cy"))).toBeCloseTo(176 - 5 / 100 * 164);
    expect(Number(go.querySelector("circle")?.getAttribute("cx"))).toBeCloseTo(38 + 550 * 72 / 168);
    expect(go.querySelector('[data-series="projection"]')).toBeNull();
    expect(screen.getByText(/OpenCode 5%/)).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

it("draws a new week even when it is the only provider with a quota reading", () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start + 24 * hour);
  try {
    const { container } = render(<WeeklyQuota burns={{ opencode: fresh(2) }} />);
    expect(container.querySelector('[data-provider="opencode"] [data-series="used"]')).not.toBeNull();
  } finally { vi.useRealTimers(); }
});

it("prefers the local burndown over a pending reading and skips providers with neither", () => {
  const both = { ...burn(), pending: { used: 99, resets: iso(168) } };
  const none = { ...burn(), weekBurndown: null, pending: null };
  const { container } = render(<WeeklyQuota burns={{ claude: both, codex: none }} />);
  expect(container.querySelectorAll("g[data-provider]")).toHaveLength(1);
  expect(container.querySelector("title")?.textContent).toContain("50% used");
});

it("ignores a pending reading with an unusable reset instead of drawing a broken line", () => {
  const { container } = render(<WeeklyQuota burns={{ claude: burn(), opencode: { ...fresh(5), pending: { used: 5, resets: "not-a-date" } } }} />);
  expect(container.querySelector('[data-provider="opencode"]')).toBeNull();
  expect(container.querySelector('[data-provider="claude"]')).not.toBeNull();
});

it("shows the weekly quota card when the only reading is a pending one", () => {
  const burns = { opencode: fresh(5) };
  render(<Dashboard r={{ burns }} burn={burns.opencode} sources={["opencode"]} source="opencode" onSource={vi.fn()} />);
  expect(screen.getByText("Weekly quota")).toBeTruthy();
});

it("shows the plan's reading in the Weekly limit tile instead of a dash while the week is new", () => {
  const burns = { opencode: fresh(5) };
  render(<Dashboard r={{ burns }} burn={burns.opencode} sources={["opencode"]} source="opencode" onSource={vi.fn()} />);
  expect(screen.getByText("5%")).toBeTruthy();
  expect(screen.getByText(/plan reading/)).toBeTruthy();
  expect(screen.queryByText("no subscription reading yet")).toBeNull();
});

it("keeps the dash when a provider has no reading at all", () => {
  const burns = { opencode: { ...fresh(5), pending: null } };
  render(<Dashboard r={{ burns }} burn={burns.opencode} sources={["opencode"]} source="opencode" onSource={vi.fn()} />);
  expect(screen.getByText("no subscription reading yet")).toBeTruthy();
});

it("words the new-quota warning for any provider and any percentage", () => {
  render(<Gauge burn={{ ...burn(), ratePct: null, idealPct: null, pending: { used: 5, resets: iso(168) } }} />);
  fireEvent.click(screen.getByRole("button", { name: /Why there is no quota reading/ }));
  expect(screen.getByText(/Your plan reports the weekly quota as 5% used/)).toBeTruthy();
  expect(screen.queryByText(/Claude plan/)).toBeNull();
  expect(screen.queryByText(/under 1%/)).toBeNull();
});

it("counts running headless agents that leave no transcript in the Active agents panel", () => {
  const session = (source: "claude" | "codex" | "opencode") => ({ source }) as never;
  const r = { burns: { claude: burn(), codex: burn(), opencode: burn() }, active: [session("claude"), session("claude")],
    unseenAgents: { codex: 2, opencode: 1 } };
  render(<ActiveAgents r={r} />);
  expect(screen.getByText("5")).toBeTruthy(); // 2 claude + 2 codex + 1 opencode
  const rows = screen.getByLabelText("Active agents by provider").textContent;
  expect(rows).toMatch(/Claude Code\s*2/); expect(rows).toMatch(/Codex\s*2/); expect(rows).toMatch(/OpenCode\s*1/);
});

it("leaves the Active agents count alone when nothing is unseen", () => {
  const { container } = render(<ActiveAgents r={{ burns: { codex: burn() }, active: [] }} />);
  expect(container.querySelector("strong")?.textContent).toBe("0");
});

it("shows the gauge in %/h from the meter when the plan size in tokens is unknown", () => {
  render(<Gauge burn={{ ...burn(), limit: null, ratePct: 1.2, idealPct: 0.6, pending: null }} />);
  expect(screen.getByText(/1\.2/)).toBeTruthy();
  expect(screen.queryByText("no quota reading")).toBeNull();
});
