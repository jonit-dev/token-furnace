import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runChurnHook } from "../src/setup/churn-hook";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tf-churn-"));
  vi.stubEnv("TMPDIR", root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it("emits escalation only at edits 4, 7 and 10 and exits zero", () => {
  const input = Array.from({ length: 10 }, () => JSON.stringify({
    tool_name: "Edit", tool_input: { file_path: "/project/example.ts" }, session_id: "fixture",
  })).join("\n");
  const output: string[] = [];
  expect(runChurnHook(input, {}, { write: (text) => output.push(text) })).toBe(0);
  const frames = output.map((line) => JSON.parse(line).hookSpecificOutput);
  expect(frames).toHaveLength(3);
  expect(frames.map((frame) => Number(frame.additionalContext.match(/(\d+) times/)?.[1]))).toEqual([4, 7, 10]);
  for (const frame of frames) {
    expect(frame.hookEventName).toBe("PostToolUse");
    expect(frame.additionalContext).toContain("Keep working the task");
  }
});

it("ignores malformed input and non-string paths without writing state", () => {
  const input = ["{broken", "null", ...[null, {}, [], 42, ""].map((path) => JSON.stringify({
    tool_name: "Edit", tool_input: { file_path: path }, session_id: "fixture",
  }))].join("\n");
  const output: string[] = [];
  expect(runChurnHook(input, { CHURN_FIRST: "1" }, { write: (text) => output.push(text) })).toBe(0);
  expect(output).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});

it("accepts one pretty-printed hook payload per invocation", () => {
  const input = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/project/pretty.ts" }, session_id: "pretty" }, null, 2);
  const output: string[] = [];
  for (let i = 0; i < 10; i++) expect(runChurnHook(input, {}, { write: (text) => output.push(text) })).toBe(0);
  expect(output.map((text) => Number(JSON.parse(text).hookSpecificOutput.additionalContext.match(/(\d+) times/)?.[1]))).toEqual([4, 7, 10]);
});
