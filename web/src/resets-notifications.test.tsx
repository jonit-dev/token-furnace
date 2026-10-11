// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { useUi } from "./store";
import { Notifications } from "./components/notifications";
import { Resets } from "./components/resets";

const SNAPSHOT = {
  feed: {
    schema_version: 1,
    generated_at: "2026-10-10T12:00:00Z",
    source: "https://agentresets.com",
    attribution: { note: "Seeded history.", cutoff_date: "2026-09-10", sources: [{ name: "Codex Resets", url: "https://codex-resets.com" }] },
    products: [{
      id: "codex",
      name: "Codex",
      vendor: "OpenAI",
      events: [{ date: "2026-10-07", time: "2026-10-07T03:35:09Z", kind: "banked", summary: "A reset was announced." }],
      stats: { total: 52, last_date: "2026-10-07", last30d: 7, median_gap: 3, max_gap: 68, banked_total: 7, unavailable: false },
      forecast: { probabilities: { raw_24h: 0.15, raw_48h: 0.35, raw_7d: 0.68 }, hours_since_last: 68, model: "climatology", method_url: null, unavailable: false },
      announced_schedule: null,
    }],
  },
  fetchedAt: "2026-10-10T12:00:00Z",
  stale: false,
  error: null,
  source: "https://agentresets.com",
};

const SETTINGS = {
  enabled: false,
  ntfy: { enabled: false, server: "https://ntfy.sh", topic: "", token: "", hasToken: false },
  telegram: { enabled: false, chatId: "", botToken: "", hasToken: false },
  conditions: { newReset: true, upcoming: true, leadMinutes: 60, usage: { enabled: false, percent: 80, provider: "any" } },
};

/** The live-page protocols are what the components use to decide they may talk to the server. */
const liveOrigin = Object.getOwnPropertyDescriptor(window, "location");
void liveOrigin;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  }
  localStorage.clear();
  useUi.setState({ tab: "dashboard", modal: null, toast: null });
  window.__REPORT__ = null;
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/resets")) return { ok: true, status: 200, json: async () => SNAPSHOT };
    if (url.endsWith("/api/notifications/test")) {
      return { ok: false, status: 502, json: async () => ({ ok: false, skipped: false, results: [
        { channel: "ntfy", ok: true, error: null },
        { channel: "telegram", ok: false, error: "telegram answered HTTP 500." },
      ] }) };
    }
    if (init?.method === "POST" && url.endsWith("/api/notifications")) return { ok: true, status: 200, json: async () => SETTINGS };
    if (url.endsWith("/api/notifications")) return { ok: true, status: 200, json: async () => SETTINGS };
    return { ok: true, status: 200, json: async () => null };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Resets tab", () => {
  it("shows the announced times, the labelled probabilities, and the source link", async () => {
    render(<Resets />);
    expect(await screen.findByText("No reset time announced")).not.toBeNull();
    expect(screen.getByText("15%")).not.toBeNull(); // the 24 h horizon, as a fraction
    expect(screen.getByText("68%")).not.toBeNull(); // the 7 day horizon
    const history = screen.getByText("Recent announcements (1)");
    const details = history.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(history);
    expect(details.open).toBe(true);
    expect(screen.getByText("Banked reset")).not.toBeNull();
    expect(screen.getByText("A reset was announced.")).not.toBeNull();
    const link = screen.getByRole("link", { name: "Source: AgentResets" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://agentresets.com/");
    expect(screen.getByText(/Seeded history/)).not.toBeNull();
  });

  it("shows a confirmed schedule and unknown estimates without suggesting zero chance", async () => {
    const product = SNAPSHOT.feed.products[0];
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({
      ...SNAPSHOT,
      feed: { ...SNAPSHOT.feed, products: [{ ...product, forecast: null,
        announced_schedule: { certainty: "announced", scheduled_for: "2026-10-12T12:00:00Z", source_url: "https://openai.com/" },
      }] },
    }) });
    render(<Resets />);
    expect(await screen.findByText(/^Announced /)).not.toBeNull();
    expect(screen.queryByText("No reset time announced")).toBeNull();
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Official announcement" }).getAttribute("href")).toBe("https://openai.com/");
  });

  it("says so when the feed could not be read, and keeps the last feed on screen", async () => {
    fetchMock.mockImplementation(async () => {
      return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => SETTINGS };
    });
    render(<Resets />);
    expect(await screen.findByText("The reset feed could not be read from the server.")).not.toBeNull();
  });

  it("is reachable as a tab in the app", async () => {
    useUi.setState({ tab: "resets" });
    render(<App />);
    await waitFor(() => expect(screen.getAllByText("Resets").length).toBeGreaterThan(0));
    expect(screen.getByRole("link", { name: "Notifications" })).not.toBeNull();
  });
});

describe("the Notifications tab", () => {
  it("saves the settings and reports the result", async () => {
    render(<Notifications />);
    await waitFor(() => expect(screen.getByLabelText("Topic")).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "token-furnace" } });
    fireEvent.click(screen.getByLabelText(/Send notifications from this server/));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Saved/));
    const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/api/notifications") && init?.method === "POST");
    expect(call).toBeTruthy();
    expect(JSON.parse(String((call as any)[1].body))).toMatchObject({ enabled: true, ntfy: { topic: "token-furnace" } });
  });

  it("opens and closes each channel setup modal", async () => {
    render(<Notifications />);
    await waitFor(() => expect(screen.getByLabelText("Topic")).not.toBeNull());
    const buttons = screen.getAllByRole("button", { name: "Setup instructions" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(useUi.getState().modal).toBe("ntfy-setup");
    expect(await screen.findByText("Get phone alerts from your own private topic.")).not.toBeNull();
    expect(screen.getByRole("link", { name: "ntfy.sh" }).getAttribute("href")).toBe("https://ntfy.sh");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector("dialog[open]")).toBeNull());
    expect(useUi.getState().modal).toBeNull();
    fireEvent.click(buttons[1]);
    expect(useUi.getState().modal).toBe("telegram-setup");
    expect(await screen.findByText("Get alerts from a bot you own.")).not.toBeNull();
    expect(screen.getByRole("link", { name: "@BotFather" }).getAttribute("href")).toBe("https://t.me/BotFather");
    fireEvent.keyDown(screen.getByText("Get alerts from a bot you own."), { key: "Escape" });
  });

  it("reports the channels the test send used", async () => {
    render(<Notifications />);
    await waitFor(() => expect(screen.getByLabelText("Chat id")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Send a test notification" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("ntfy: sent · telegram: telegram answered HTTP 500."));
  });

  it("shows why a save was refused", async () => {
    fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: false, status: 400, json: async () => ({ error: "The ntfy topic needs 1-64 letters, digits, - or _." }) };
      return { ok: true, status: 200, json: async () => SETTINGS };
    });
    render(<Notifications />);
    await waitFor(() => expect((screen.getByLabelText("Send this many minutes before (1 to 1440)") as HTMLInputElement).value).toBe("60"));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/topic needs/));
  });
});
