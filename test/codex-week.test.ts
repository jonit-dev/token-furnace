import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexSource } from "../src/sources/codex";

// A rollout logs rate_limits many times; the week is the NEWEST reading, not the first one.
it("CodexSource.week reads the newest rate_limits line in a file", () => {
  const home = mkdtempSync(join(tmpdir(), "tf-week-"));
  const dir = join(home, "sessions", "2026", "10");
  mkdirSync(dir, { recursive: true });
  const now = new Date("2026-10-10T00:00:00Z");
  const resets = Math.floor(now.getTime() / 1000) + 3 * 86_400;
  const reading = (used: number) =>
    JSON.stringify({
      payload: { rate_limits: { primary: { window_minutes: 10080, used_percent: used, resets_at: resets } } },
    });
  writeFileSync(join(dir, "rollout-a.jsonl"), [reading(22), reading(23)].join("\n") + "\n");
  const week = new CodexSource({ CODEX_HOME: home }).week(now);
  expect(week?.used).toBe(23);
});
