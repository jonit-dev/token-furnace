import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { loadingPage } from "../src/render/loading";

it("shows task status from live progress and opens the dashboard when ready", async () => {
  const page = loadingPage();
  expect(page).toContain("<h1>Measuring performance</h1>");
  expect(page).toContain("analyzes local Claude Code and Codex usage");
  expect(page).not.toMatch(/scanning|transcripts/i);
  expect(page).toContain('id="status" role="status"');

  const bar = { setAttribute: vi.fn() };
  const elements = Object.fromEntries(["fill", "text", "time", "status"].map((id) => [id, {
    textContent: "", style: { width: "" }, parentElement: bar,
  }]));
  let progress = { phase: "idle", filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0 };
  let next: () => Promise<void>;
  const reload = vi.fn();
  const script = page.match(/<script>([\s\S]*?)<\/script>/)![1];
  await runInNewContext(script, {
    document: { getElementById: (id: string) => elements[id] },
    fetch: async () => ({ json: async () => progress }),
    location: { reload },
    setTimeout: (callback: () => Promise<void>) => { next = callback; },
  });
  expect(elements.status.textContent).toBe("Preparing usage analysis...");

  progress = { phase: "scanning", filesTotal: 4, filesDone: 1, bytesTotal: 100, bytesDone: 25 };
  await next!();
  expect(elements.status.textContent).toBe("Measuring token usage...");
  expect(elements.text.textContent).toBe("1 of 4 files (25%)");
  expect(elements.fill.style.width).toBe("25%");
  expect(bar.setAttribute).toHaveBeenLastCalledWith("aria-valuenow", "25");

  progress.filesDone = 4;
  await next!();
  expect(elements.status.textContent).toBe("Preparing your dashboard...");

  progress.filesTotal = 0;
  await next!();
  expect(elements.status.textContent).toBe("Preparing your dashboard...");

  progress.phase = "ready";
  await next!();
  expect(elements.status.textContent).toBe("Opening your dashboard...");
  expect(reload).toHaveBeenCalledOnce();
});
