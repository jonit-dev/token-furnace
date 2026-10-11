// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveSessions } from "./components/panels";
import { Sessions } from "./components/tables";
import type { ActiveSession, Report, SessionRow } from "../../src/core/model";

describe("ActiveSessions and Sessions UI improvements", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  });

  afterEach(() => {
    cleanup();
  });

  it("groups active sessions into Needs attention and Other active sessions", () => {
    const sessions: ActiveSession[] = [
      {
        source: "codex",
        project: "api-backend",
        id: "abcdef01",
        fullId: "abcdef01-2345-6789-abcd-ef0123456789",
        title: "Add endpoint",
        share: 5,
        turns: 2,
        peak: 50000,
        hours: 0.5,
        context: 50000,
        idle: 5,
        flags: [],
        model: "gpt-5.5",
        rate: 100000,
        rateShare: 70,
      },
      {
        source: "claude",
        project: "my-app",
        id: "12345678",
        fullId: "12345678-abcd-ef01-2345-6789abcdef01",
        title: "Fix bug",
        share: 10,
        turns: 5,
        peak: 250000,
        hours: 1,
        context: 250000,
        idle: 2,
        flags: ["late compaction: peak 250k. Use a 160000 claude compaction window."],
        model: "claude-3-7-sonnet",
        rate: 500000,
        rateShare: 60,
      },
    ];

    render(<ActiveSessions sessions={sessions} />);

    const attentionHeading = screen.getByRole("heading", { name: /needs attention/i });
    const attentionGroup = attentionHeading.parentElement!;
    const otherHeading = screen.getByRole("heading", { name: /other active sessions/i });
    const otherGroup = otherHeading.parentElement!;

    expect(within(attentionGroup).getByText(/Needs attention \(1\)/i)).toBeTruthy();
    expect(within(attentionGroup).getAllByText("Fix bug").length).toBeGreaterThanOrEqual(1);
    expect(within(attentionGroup).queryByText("Add endpoint")).toBeNull();
    expect(within(attentionGroup).getByText("of Claude Code")).toBeTruthy();
    // Issues live in the session modal, opened from the Fixes column.
    expect(screen.queryByText("late compaction:")).toBeNull();
    fireEvent.click(within(attentionGroup).getByRole("button", { name: "1 fix for Fix bug" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("late compaction:")).toBeTruthy();
    expect(within(dialog).getByText("Use a 160000 claude compaction window.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close modal" }));

    expect(within(otherGroup).getByText(/Other active sessions \(1\)/i)).toBeTruthy();
    expect(within(otherGroup).getAllByText("Add endpoint").length).toBeGreaterThanOrEqual(1);
    expect(within(otherGroup).queryByText("Fix bug")).toBeNull();
    expect(within(otherGroup).getByText("of Codex")).toBeTruthy();
  });

  it("shows empty state when no active sessions have flags", () => {
    const sessions: ActiveSession[] = [
      {
        source: "codex",
        project: "api-backend",
        id: "abcdef01",
        fullId: "abcdef01-2345-6789-abcd-ef0123456789",
        title: "Clean build",
        share: 5,
        turns: 2,
        peak: 50000,
        hours: 0.5,
        context: 50000,
        idle: 5,
        flags: [],
        model: "gpt-5.5",
        rate: 100000,
        rateShare: 20,
      },
    ];

    render(<ActiveSessions sessions={sessions} />);
    expect(screen.getByText(/No active sessions have triggered leak flags/i)).toBeTruthy();
    expect(screen.getByText(/Other active sessions \(1\)/i)).toBeTruthy();
  });

  it("shows existing empty message when active sessions array is empty", () => {
    render(<ActiveSessions sessions={[]} />);
    expect(screen.getByText("No session had a turn in the last 30 minutes.")).toBeTruthy();
  });

  it("opens a session modal with full title, stats, Copy ID and Copy fix", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    const activeSession: ActiveSession = {
      source: "claude",
      project: "my-frontend-service",
      id: "98765432",
      fullId: "98765432-1111-2222-3333-444455556666",
      title: "Extremely long title that should not be truncated inside the expandable session details section",
      share: 15,
      turns: 8,
      peak: 120000,
      hours: 1.2,
      context: 120000,
      idle: 1,
      flags: ["caller reads: 519 file/log reads. Send them to a cheap read-only agent."],
      model: "opencode-go/deepseek-v4.1-flash",
      rate: 300000,
      rateShare: 40,
    };

    render(<ActiveSessions sessions={[activeSession]} />);

    expect(screen.getByTitle("opencode-go/deepseek-v4.1-flash").textContent).toBe("opencode-go/deepseek-v4.1-flash");
    expect(screen.queryByRole("button", { name: "Copy ID" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^1 fix for / }));

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy fix" }));
    const prompt = writeText.mock.calls[0][0] as string;
    // The copied fix must let another agent find the session and choose a session fix or a rules file.
    expect(prompt).toContain("98765432-1111-2222-3333-444455556666");
    expect(prompt).toContain("my-frontend-service");
    expect(prompt).toContain("caller reads: 519 file/log reads");
    expect(prompt).toContain("add a short rule to CLAUDE.md");
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy ID" }));
    expect(writeText).toHaveBeenCalledWith("98765432-1111-2222-3333-444455556666");
    expect(within(dialog).getByText("Extremely long title that should not be truncated inside the expandable session details section")).toBeTruthy();
    expect(within(dialog).getByText("my-frontend-service")).toBeTruthy();
    expect(within(dialog).getByText("8")).toBeTruthy();
  });

  it("renders CopyButton with fullId in Top sessions table", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    const topSession: SessionRow = {
      source: "codex",
      project: "my-service",
      id: "fedcba98",
      fullId: "fedcba98-7654-3210-fedc-ba9876543210",
      title: "Refactor router",
      path: "/sessions/fedcba98.jsonl",
      share: 25,
      turns: 12,
      peak: 80000,
      hours: 2,
      flags: [],
    };

    const report: Partial<Report> = {
      topSessions: [topSession],
    };

    render(<Sessions r={report} />);
    const copyBtn = screen.getByRole("button", { name: "Copy ID" });
    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("fedcba98-7654-3210-fedc-ba9876543210");
  });
});
