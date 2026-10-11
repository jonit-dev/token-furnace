import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isRead } from "../src/sources/agent-source";
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
    output: 200,
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
    expect(new ClaudeSource({ HOME: "/home/dev" }).root()).toBe(join("/home/dev", ".claude", "projects"));
  });

  it("treats a missing agent directory as not installed", () => {
    expect(new ClaudeSource({ CLAUDE_CONFIG_DIR: join(FIXTURES, "gone") }).files()).toEqual([]);
    expect(new CodexSource({ CODEX_HOME: join(FIXTURES, "gone") }).files()).toEqual([]);
  });

  it("names a handoff first prompt but keeps an explicit native title", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-claude-handoff-"));
    try {
      const handoff = join(root, "handoff.jsonl");
      writeFileSync(handoff, [
        JSON.stringify({ type: "user", timestamp: "2026-10-01T09:00:00+00:00", message: { content: "Read /tmp/spellbook-sonnet-brief.md and execute" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-10-01T09:01:00+00:00", cwd: "/x", message: { model: "claude", usage: { input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 1 }, content: [] } }),
      ].join("\n"));
      expect(new ClaudeSource({}).parse(handoff).title).toBe("Spellbook sonnet brief");

      const titled = join(root, "titled.jsonl");
      writeFileSync(titled, [
        JSON.stringify({ type: "summary", aiTitle: "Native name" }),
        JSON.stringify({ type: "user", timestamp: "2026-10-01T09:00:00+00:00", message: { content: "Read /tmp/another-brief.md" } }),
      ].join("\n"));
      expect(new ClaudeSource({}).parse(titled).title).toBe("Native name");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("CodexSource", () => {
  const source = new CodexSource({ CODEX_HOME });

  it("parses the fixture like codex_turns", () => {
    const parsed = source.parse(CODEX_FILE);
    expect(plain(parsed.turns)).toEqual(CODEX_TURNS);
    expect(parsed.title).toBe("write the parser");
    expect(parsed.badLines).toBe(1);
  });

  it("walks sessions/** for rollout files", () => {
    expect(source.root()).toBe(join(CODEX_HOME, "sessions"));
    expect(source.files().map((file) => file.path)).toEqual([CODEX_FILE]);
  });

  it("defaults to ~/.codex when CODEX_HOME is unset", () => {
    expect(new CodexSource({ HOME: "/home/dev" }).root()).toBe(join("/home/dev", ".codex", "sessions"));
  });
});


describe("Windows shell reads", () => {
  it.each(["Get-Content src/main.ts", "get-content src/main.ts", "gc src/main.ts", "type src\\main.ts", "Select-String TODO src/main.ts", "Set-Location src; Get-Content main.ts", "echo ready | Get-Content src/main.ts"])("counts %s", (command) => {
    expect(isRead("PowerShell", command)).toBe(true);
  });
  it.each(["Set-Content src/main.ts hello", "Get-Contentment src/main.ts", "typewriter src/main.ts", 'echo "Get-Content src/main.ts"'])("does not count %s", (command) => {
    expect(isRead("PowerShell", command)).toBe(false);
  });
  it("counts reads in Codex PowerShell command arrays", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-powershell-array-"));
    try {
      const path = join(root, "rollout-windows.jsonl");
      const records = readFileSync(CODEX_FILE, "utf8").trim().split("\n");
      records[3] = JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: {
        type: "CommandExecution", id: "windows-read", command: ["powershell.exe", "-NoProfile", "-Command", "Get-Content src/main.ts"] } } });
      writeFileSync(path, records.join("\n"));
      expect(new CodexSource({}).parse(path).turns[0].reads).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("counts PowerShell reads through both transcript parsers with CRLF", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-windows-reads-"));
    try {
      for (const [source, original] of [[new ClaudeSource({}), CLAUDE_FILE], [new CodexSource({}), CODEX_FILE]] as const) {
        const path = join(root, source.name + ".jsonl");
        const text = readFileSync(original, "utf8").replace(/sed -n 1,9p f/g, "Get-Content f").replace(/sed -n 1,20p x/g, "Get-Content x");
        writeFileSync(path, text.replaceAll("\n", "\r\n"));
        expect(source.parse(path).turns.map((turn) => turn.reads)).toEqual(source.parse(original).turns.map((turn) => turn.reads));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
