// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Burn } from "../../src/core/model";
import { WeeklyQuota } from "./components/charts";
import { Dashboard } from "./components/panels";

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
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shares percentage and calendar coordinates despite unequal limits and reset dates", () => {
  const { container } = render(<WeeklyQuota burns={{ claude: burn(), codex: burn(24, 50, 9000000) }} />);
  const groups = container.querySelectorAll("g[data-provider]");
  expect(groups).toHaveLength(2);
  expect(groups[0].querySelector('[data-series="used"]')?.getAttribute("stroke")).toBe("#f97316");
  expect(groups[1].querySelector('[data-series="used"]')?.getAttribute("stroke")).toBe("#4a9eff");
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
