import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

// Lane and eval runs log no rate_limits; hundreds of them must not hide the real session's reading.
it("CodexSource.week finds a reading older than 200 newer rollouts without one", () => {
  const home = mkdtempSync(join(tmpdir(), "tf-week-many-"));
  const dir = join(home, "sessions", "2026", "10");
  mkdirSync(dir, { recursive: true });
  const now = new Date("2026-10-10T00:00:00Z");
  const resets = Math.floor(now.getTime() / 1000) + 3 * 86_400;
  const real = join(dir, "rollout-real.jsonl");
  writeFileSync(real, JSON.stringify({
    payload: { rate_limits: { primary: { window_minutes: 10080, used_percent: 49, resets_at: resets } } },
  }) + "\n");
  utimesSync(real, 1_000, 1_000);
  for (let i = 0; i < 250; i++) writeFileSync(join(dir, `rollout-eval-${i}.jsonl`), "{}\n");
  expect(new CodexSource({ CODEX_HOME: home }).week(now)?.used).toBe(49);
});

// Helpers for the cases below: one rollout per call, newest mtime wins.
const t0 = new Date("2026-10-10T00:00:00Z");
function rollouts() {
  const home = mkdtempSync(join(tmpdir(), "tf-week-"));
  const dir = join(home, "sessions", "2026", "10");
  mkdirSync(dir, { recursive: true });
  const week = (used: number, resets: number, minutes = 10080) => JSON.stringify({
    payload: { rate_limits: { primary: { window_minutes: minutes, used_percent: used, resets_at: resets } } },
  });
  const write = (name: string, body: string, mtimeSec: number) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    utimesSync(path, mtimeSec, mtimeSec);
    return path;
  };
  return { home, dir, week, write, source: () => new CodexSource({ CODEX_HOME: home }) };
}
const secs = (offsetDays: number) => Math.floor(t0.getTime() / 1000) + offsetDays * 86_400;

it("CodexSource.week skips a newer file whose week already ended and uses an older live one", () => {
  const { week, write, source } = rollouts();
  write("rollout-live.jsonl", week(40, secs(3)) + "\n", 1_000);
  write("rollout-ended.jsonl", week(90, secs(-1)) + "\n", 2_000);
  expect(source().week(t0)?.used).toBe(40);
});

it("CodexSource.week returns null when there are no rollouts, no readings, or only ended weeks", () => {
  const { week, write, source } = rollouts();
  expect(source().week(t0)).toBeNull();
  write("rollout-none.jsonl", "{}\n", 1_000);
  expect(source().week(t0)).toBeNull();
  write("rollout-ended.jsonl", week(90, secs(-1)) + "\n", 2_000);
  expect(source().week(t0)).toBeNull();
});

it("CodexSource.week ignores non-weekly windows and reads the weekly one from the secondary slot", () => {
  const { write, source } = rollouts();
  const body = JSON.stringify({ payload: { rate_limits: {
    primary: { window_minutes: 300, used_percent: 80, resets_at: secs(0.1) },
    secondary: { window_minutes: 10080, used_percent: 12, resets_at: secs(5) },
  } } });
  write("rollout-a.jsonl", body + "\n", 1_000);
  const got = source().week(t0)!;
  expect(got.used).toBe(12);
  expect(got.resets.getTime()).toBe(secs(5) * 1000);
  expect(got.start.getTime()).toBe(secs(5) * 1000 - 7 * 86_400_000);
});

it("CodexSource.week picks up a changed rollout and a new newer one on the next call", () => {
  const { week, write, source } = rollouts();
  const codex = source();
  const a = write("rollout-a.jsonl", week(10, secs(3)) + "\n", 1_000);
  expect(codex.week(t0)?.used).toBe(10);
  writeFileSync(a, week(10, secs(3)) + "\n" + week(20, secs(3)) + "\n"); // grows, so the cache key changes
  utimesSync(a, 1_500, 1_500);
  expect(codex.week(t0)?.used).toBe(20);
  write("rollout-b.jsonl", week(30, secs(3)) + "\n", 2_000);
  expect(codex.week(t0)?.used).toBe(30);
});

it("CodexSource.week stops using a cached reading once its week ends", () => {
  const { week, write, source } = rollouts();
  const codex = source();
  write("rollout-a.jsonl", week(10, secs(3)) + "\n", 1_000);
  expect(codex.week(t0)?.used).toBe(10);
  expect(codex.week(new Date(t0.getTime() + 4 * 86_400_000))).toBeNull();
});

it("CodexSource.week survives a rollout that vanishes or is unreadable between scans", () => {
  const { week, write, source } = rollouts();
  const codex = source();
  const a = write("rollout-a.jsonl", week(10, secs(3)) + "\n", 1_000);
  expect(codex.week(t0)?.used).toBe(10);
  rmSync(a);
  expect(codex.week(t0)).toBeNull();
});

it("CodexSource.week keeps working on a large tree without re-reading unchanged files", () => {
  const { week, write, dir, source } = rollouts();
  write("rollout-real.jsonl", week(49, secs(3)) + "\n", 1_000);
  for (let i = 0; i < 600; i++) write(`rollout-eval-${i}.jsonl`, "{}\n", 2_000 + i);
  const codex = source();
  expect(codex.week(t0)?.used).toBe(49);
  // Second scan must not need the eval files' bodies: remove their read permission.
  for (let i = 0; i < 600; i++) chmodSync(join(dir, `rollout-eval-${i}.jsonl`), 0o000);
  try { expect(codex.week(t0)?.used).toBe(49); }
  finally { for (let i = 0; i < 600; i++) chmodSync(join(dir, `rollout-eval-${i}.jsonl`), 0o644); }
});
