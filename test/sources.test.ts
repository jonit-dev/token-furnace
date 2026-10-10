import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Turn } from "../src/core/model";
import { ClaudeSource } from "../src/sources/claude";
import { CodexSource } from "../src/sources/codex";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CLAUDE_HOME = join(FIXTURES, "claude");
const CODEX_HOME = join(FIXTURES, "codex");
const CLAUDE_FILE = join(CLAUDE_HOME, "projects/demo/alpha-session.jsonl");
const CODEX_FILE = join(CODEX_HOME, "sessions/2026/10/rollout-demo.jsonl");

// Recorded from scripts/burn.py on these fixtures (claude_turns, claude_title, codex_turns).
const CLAUDE_TURNS = [
  {
    source: "claude",
    project: "demo",
    session: "alpha-session",
    model: "claude-opus-5-5",
    when: "2026-10-01T09:01:00.000Z",
    baseIn: 10,
    cacheRead: 400_000,
    cacheWrite: 20_000,
    output: 50,
    tools: ["Bash", "Read"],
    reads: 2,
    wakes: ["human", "teammate", "task", "peer"],
  },
  {
    source: "claude",
    project: "demo",
    session: "alpha-session",
    model: "claude-sonnet-5",
    when: "2026-10-01T09:01:20.000Z",
    baseIn: 7,
    cacheRead: 250_000,
    cacheWrite: 0,
    output: 900,
    tools: ["Edit"],
    reads: 0,
    wakes: [],
  },
];

const CODEX_TURNS = [
  {
    source: "codex",
    project: "api",
    session: "0a1b2c3d",
    model: "gpt-5.5",
    when: "2026-10-01T09:00:30.000Z",
    baseIn: 600,
    cacheRead: 400,
    cacheWrite: 0,
    output: 300,
    tools: ["shell", "apply_patch"],
    reads: 1,
    wakes: ["human"],
  },
  {
    source: "codex",
    project: "api",
    session: "0a1b2c3d",
    model: "gpt-5.5",
    when: "2026-10-01T09:00:45.000Z",
    baseIn: 400,
    cacheRead: 100,
    cacheWrite: 0,
    output: 50,
    tools: [],
    reads: 0,
    wakes: ["teammate"],
  },
];

const plain = (turns: Turn[]) => turns.map((turn) => ({ ...turn, when: turn.when.toISOString() }));

describe("ClaudeSource", () => {
  const source = new ClaudeSource({ CLAUDE_CONFIG_DIR: CLAUDE_HOME });

  it("parses the fixture like claude_turns and claude_title", () => {
    const parsed = source.parse(CLAUDE_FILE);
    expect(plain(parsed.turns)).toEqual(CLAUDE_TURNS);
    expect(parsed.title).toBe("Leak hunt");
  });

  it("counts a malformed line and keeps every other turn", () => {
    const parsed = source.parse(CLAUDE_FILE);
    expect(parsed.badLines).toBe(1);
    expect(parsed.turns).toHaveLength(CLAUDE_TURNS.length);
  });

  it("lists only .jsonl transcripts under projects/", () => {
    expect(source.root()).toBe(join(CLAUDE_HOME, "projects"));
    const files = source.files();
    expect(files.map((file) => file.path)).toEqual([CLAUDE_FILE]);
    expect(files[0].size).toBeGreaterThan(0);
  });

  it("defaults to ~/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    expect(new ClaudeSource({ HOME: "/home/dev" }).root()).toBe("/home/dev/.claude/projects");
  });

  it("treats a missing agent directory as not installed", () => {
    expect(new ClaudeSource({ CLAUDE_CONFIG_DIR: join(FIXTURES, "gone") }).files()).toEqual([]);
    expect(new CodexSource({ CODEX_HOME: join(FIXTURES, "gone") }).files()).toEqual([]);
  });
});

describe("CodexSource", () => {
  const source = new CodexSource({ CODEX_HOME });

  it("parses the fixture like codex_turns", () => {
    const parsed = source.parse(CODEX_FILE);
    expect(plain(parsed.turns)).toEqual(CODEX_TURNS);
    expect(parsed.title).toBeNull();
    expect(parsed.badLines).toBe(1);
  });

  it("walks sessions/** for rollout files", () => {
    expect(source.root()).toBe(join(CODEX_HOME, "sessions"));
    expect(source.files().map((file) => file.path)).toEqual([CODEX_FILE]);
  });

  it("defaults to ~/.codex when CODEX_HOME is unset", () => {
    expect(new CodexSource({ HOME: "/home/dev" }).root()).toBe("/home/dev/.codex/sessions");
  });
});