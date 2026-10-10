// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveSessions } from "./components/panels";
import { Sessions } from "./components/tables";
import type { ActiveSession, Report, SessionRow } from "../../src/core/model";

describe("ActiveSessions and Sessions UI improvements", () => {
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
    expect(within(attentionGroup).getByText("late compaction:")).toBeTruthy();
    expect(within(attentionGroup).getByText("Use a 160000 claude compaction window.")).toBeTruthy();
    expect(within(attentionGroup).getByText("of Claude Code")).toBeTruthy();

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

  it("copies full UUID on active session Copy ID click and reveals full title and Project in details", async () => {
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
      flags: [],
      model: "claude-3-7-sonnet",
      rate: 300000,
      rateShare: 40,
    };

    render(<ActiveSessions sessions={[activeSession]} />);

    const copyBtn = screen.getByRole("button", { name: "Copy ID" });
    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("98765432-1111-2222-3333-444455556666");

    const details = screen.getByText("Details").closest("details")!;
    expect(within(details).getByText("Extremely long title that should not be truncated inside the expandable session details section")).toBeTruthy();
    expect(within(details).getByText("Project:")).toBeTruthy();
    expect(within(details).queryByText(/Project\/cwd:/i)).toBeNull();
    expect(within(details).getByText("my-frontend-service")).toBeTruthy();
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
