// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budgets } from "./components/budgets";
import { useUi } from "./store";

const snapshot = {
  revision: 0,
  mutationToken: "budget-test-token-1234567890",
  policies: [],
  stops: [],
  error: null,
  sources: [
    { source: "claude", label: "Claude Code", installed: true, providers: ["anthropic"], models: ["claude-opus"], policy: null, meter: null, pace: null, allowance: null, blockedWork: 0, coverage: "Watching", status: "Watching" },
    { source: "codex", label: "Codex", installed: true, providers: ["openai"], models: ["gpt-5"], policy: null, meter: null, pace: null, allowance: null, blockedWork: 0, coverage: "Watching", status: "Watching" },
    { source: "opencode", label: "OpenCode", installed: false, models: [], policy: null, meter: null, pace: null, allowance: null, blockedWork: 0, coverage: "Watching", status: "Watching" },
  ],
};

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  useUi.setState({ toast: null, modal: null, online: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => snapshot }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Budgets", () => {
  it("renders every source with Off selected and discovered models", async () => {
    render(<Budgets />);
    expect(await screen.findByRole("heading", { name: "Budgets" })).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("OpenCode")).toBeTruthy();
    expect(screen.getByText("claude-opus")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Claude Code budget mode" }) as HTMLSelectElement).value).toBe("off");
    expect((screen.getByRole("button", { name: "Save Claude Code budget" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves Manual without allowing an old revision to overwrite newer settings", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<Budgets />);
    const card = (await screen.findByText("Claude Code")).closest("section")!;
    fireEvent.change(within(card).getByRole("combobox", { name: "Claude Code budget mode" }), { target: { value: "manual" } });
    fireEvent.change(within(card).getByRole("spinbutton", { name: "Claude Code budget limit" }), { target: { value: "1200" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save Claude Code budget" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/budgets", expect.objectContaining({ method: "POST" })));
    const [, request] = fetchMock.mock.calls.find(([url, options]) => url === "/api/budgets" && (options as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String(request?.body))).toMatchObject({ expectedRevision: 0 });
    expect((request?.headers as Record<string, string>)["X-Token-Furnace-Mutation"]).toBe(snapshot.mutationToken);
  });

  it("opens a separate provider stop confirmation", async () => {
    render(<Budgets />);
    const card = (await screen.findByText("Claude Code")).closest("section")!;
    fireEvent.click(within(card).getByRole("button", { name: "Stop all Claude Code" }));
    expect(screen.getByRole("dialog", { name: "Stop all Claude Code" })).toBeTruthy();
    expect(screen.getByText(/does not change your budget policy/i)).toBeTruthy();
  });

  it("uses the upstream provider when stopping a discovered model", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/budgets/stop-preview") return { ok: true, status: 200, json: async () => ({ id: "preview-1", fingerprint: "fingerprint-1" }) } as Response;
      if (String(input) === "/api/budgets/stop") return { ok: true, status: 200, json: async () => ({ id: "operation-1" }) } as Response;
      return { ok: true, status: 200, json: async () => snapshot } as Response;
    });
    render(<Budgets />);
    const card = (await screen.findByText("Claude Code")).closest("section")!;
    fireEvent.click(within(card).getByRole("button", { name: "Stop model" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/budgets/stop-preview", expect.objectContaining({ method: "POST" })));
    const [, request] = fetchMock.mock.calls.find(([url]) => url === "/api/budgets/stop-preview")!;
    expect(JSON.parse(String(request?.body))).toMatchObject({ scope: { kind: "model", provider: "anthropic", model: "claude-opus" } });
  });

  it("exposes an explicit unlock for persisted emergency latches", async () => {
    const fetchMock = vi.mocked(fetch);
    const stopped = { ...snapshot, stops: [{ scope: { kind: "provider", provider: "anthropic" }, operationId: "operation-1", createdAt: "2026-10-11T00:00:00.000Z" }] };
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/budgets") return { ok: true, status: 200, json: async () => stopped } as Response;
      if (String(input) === "/api/budgets/unlock") return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      return { ok: true, status: 200, json: async () => stopped } as Response;
    });
    render(<Budgets />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock provider anthropic" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/budgets/unlock", expect.objectContaining({ method: "POST" })));
    const [, request] = fetchMock.mock.calls.find(([url]) => url === "/api/budgets/unlock")!;
    expect(JSON.parse(String(request?.body))).toEqual({ scope: { kind: "provider", provider: "anthropic" } });
  });
});
