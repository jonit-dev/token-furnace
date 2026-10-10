import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { main } from "../src/cli";
import { compose } from "../src/compose";

describe("token-furnace setup", () => {
  let testHome: string;
  let out: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "tf-setup-test-"));
    out = "";
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  function appFor(env: Record<string, string | undefined> = {}) {
    return compose({
      HOME: testHome,
      ...env,
    }, { noCache: true });
  }

  it("AC-1: dry-run changes no files and prints planned actions", async () => {
    const app = appFor();
    const code = await main(["setup"], app);
    expect(code).toBe(0);

    // Verify no files created in temp HOME
    expect(existsSync(join(testHome, ".agents"))).toBe(false);
    expect(existsSync(join(testHome, ".claude"))).toBe(false);
    expect(existsSync(join(testHome, ".codex"))).toBe(false);
  });

  it("AC-2: setup --apply is idempotent and creates backup", async () => {
    const app = appFor();

    // Pre-create initial files to test backup and preserving existing keys
    const claudeSettings = join(testHome, ".claude", "settings.json");
    mkdirSync(join(testHome, ".claude"), { recursive: true });
    writeFileSync(
      claudeSettings,
      JSON.stringify({ userKey: "keep-me", env: { CUSTOM_VAR: "custom" } }, null, 2),
    );

    const codexConfig = join(testHome, ".codex", "config.toml");
    mkdirSync(join(testHome, ".codex"), { recursive: true });
    writeFileSync(codexConfig, 'user_setting = "keep"\n');

    // Run 1: apply
    const code1 = await main(["setup", "--apply"], app);
    expect(code1).toBe(0);

    // Backup directory should exist
    const backupRoot = join(testHome, ".agents", "token-furnace-backups");
    expect(existsSync(backupRoot)).toBe(true);

    // Read state after first apply
    const claudeContent1 = readFileSync(claudeSettings, "utf8");
    const codexContent1 = readFileSync(codexConfig, "utf8");
    const agentsMd1 = readFileSync(join(testHome, ".codex", "AGENTS.md"), "utf8");

    // Preserved custom keys
    const parsedClaude1 = JSON.parse(claudeContent1);
    expect(parsedClaude1.userKey).toBe("keep-me");
    expect(parsedClaude1.env.CUSTOM_VAR).toBe("custom");
    expect(parsedClaude1.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("3");
    expect(codexContent1).toContain('user_setting = "keep"');
    expect(codexContent1).toContain('model_verbosity = "low"');
    expect(agentsMd1).toContain("<!-- token-furnace:begin -->");

    // Run 2: idempotent apply
    const code2 = await main(["setup", "--apply"], app);
    expect(code2).toBe(0);

    const claudeContent2 = readFileSync(claudeSettings, "utf8");
    const codexContent2 = readFileSync(codexConfig, "utf8");
    const agentsMd2 = readFileSync(join(testHome, ".codex", "AGENTS.md"), "utf8");

    expect(claudeContent2).toBe(claudeContent1);
    expect(codexContent2).toBe(codexContent1);
    expect(agentsMd2).toBe(agentsMd1);
  });

  it("AC-3: setup --rollback restores files byte for byte", async () => {
    const app = appFor();

    const claudeSettings = join(testHome, ".claude", "settings.json");
    mkdirSync(join(testHome, ".claude"), { recursive: true });
    const initialClaudeBytes = JSON.stringify({ custom: "data-123" }, null, 2) + "\n";
    writeFileSync(claudeSettings, initialClaudeBytes);

    const codexConfig = join(testHome, ".codex", "config.toml");
    mkdirSync(join(testHome, ".codex"), { recursive: true });
    const initialCodexBytes = "original_key = true\n";
    writeFileSync(codexConfig, initialCodexBytes);

    // Apply changes
    const applyCode = await main(["setup", "--apply"], app);
    expect(applyCode).toBe(0);

    // Confirm modified
    expect(readFileSync(claudeSettings, "utf8")).not.toBe(initialClaudeBytes);
    expect(readFileSync(codexConfig, "utf8")).not.toBe(initialCodexBytes);

    // Rollback
    const rollbackCode = await main(["setup", "--rollback"], app);
    expect(rollbackCode).toBe(0);

    // Restored byte for byte
    expect(readFileSync(claudeSettings, "utf8")).toBe(initialClaudeBytes);
    expect(readFileSync(codexConfig, "utf8")).toBe(initialCodexBytes);
  });

  it("Defect 1: apply twice then rollback restores initial bytes including same-second and missing files", async () => {
    const app = appFor();

    const claudeSettings = join(testHome, ".claude", "settings.json");
    mkdirSync(join(testHome, ".claude"), { recursive: true });
    const initialClaudeBytes = JSON.stringify({ marker: "initial-claude" }, null, 2) + "\n";
    writeFileSync(claudeSettings, initialClaudeBytes);

    // codex AGENTS.md does not exist initially
    const agentsMd = join(testHome, ".codex", "AGENTS.md");
    expect(existsSync(agentsMd)).toBe(false);

    // Apply run 1
    const code1 = await main(["setup", "--apply"], app);
    expect(code1).toBe(0);
    expect(existsSync(agentsMd)).toBe(true);

    // Apply run 2 immediately (same second, no-op or collision-safe snapshot)
    const code2 = await main(["setup", "--apply"], app);
    expect(code2).toBe(0);

    // Rollback must restore original initial bytes and move aside newly created file
    const rbCode = await main(["setup", "--rollback"], app);
    expect(rbCode).toBe(0);

    expect(readFileSync(claudeSettings, "utf8")).toBe(initialClaudeBytes);
    expect(existsSync(agentsMd)).toBe(false);
    expect(existsSync(`${agentsMd}.token-furnace-removed`)).toBe(true);
  });

  it("Defect 1 legacy: native TS rollback restores legacy shell-created backup without executing shell", async () => {
    const app = appFor();
    const backupDir = join(testHome, ".agents", "token-furnace-backups", "20250101-120000");
    mkdirSync(backupDir, { recursive: true });

    const legacyClaudeSettings = JSON.stringify({ legacy: true });
    writeFileSync(join(backupDir, "claude-settings.json"), legacyClaudeSettings);
    // legacy restore.sh exists
    writeFileSync(join(backupDir, "restore.sh"), "#!/usr/bin/env bash\necho 'shell should not run'\n");

    const claudeSettings = join(testHome, ".claude", "settings.json");
    mkdirSync(join(testHome, ".claude"), { recursive: true });
    writeFileSync(claudeSettings, JSON.stringify({ current: true }));

    const rbCode = await main(["setup", "--rollback"], app);
    expect(rbCode).toBe(0);
    expect(readFileSync(claudeSettings, "utf8")).toBe(legacyClaudeSettings);
    // The customized live file is preserved beside the backup before being overwritten.
    expect(readFileSync(join(backupDir, "claude-settings.json.pre-rollback"), "utf8")).toBe(
      JSON.stringify({ current: true }),
    );
  });

  it("Defect 2: restores cleanly with hostile HOME containing spaces, apostrophe, $(), and backticks", async () => {
    const hostileRoot = mkdtempSync(join(tmpdir(), "tf-test 'with space' $(echo evil) `touch marker`-"));
    try {
      const app = compose({ HOME: hostileRoot });
      const claudeSettings = join(hostileRoot, ".claude", "settings.json");
      mkdirSync(join(hostileRoot, ".claude"), { recursive: true });
      const initialClaudeBytes = JSON.stringify({ safe: true });
      writeFileSync(claudeSettings, initialClaudeBytes);

      const code = await main(["setup", "--apply"], app);
      expect(code).toBe(0);

      // Check restore.sh single-quote escaping: no unquoted $ or backticks
      const backupRoot = join(hostileRoot, ".agents", "token-furnace-backups");
      const subdirs = existsSync(backupRoot) ? (await import("node:fs")).readdirSync(backupRoot) as string[] : [];
      expect(subdirs.length).toBeGreaterThan(0);
      const restoreScriptContent = readFileSync(join(backupRoot, subdirs[0], "restore.sh"), "utf8");
      // Single quotes surround path, so $() and `touch` inside quotes won't execute
      expect(restoreScriptContent).toContain(`'${hostileRoot.replace(/'/g, "'\\''")}`);

      const rbCode = await main(["setup", "--rollback"], app);
      expect(rbCode).toBe(0);
      expect(readFileSync(claudeSettings, "utf8")).toBe(initialClaudeBytes);
    } finally {
      rmSync(hostileRoot, { recursive: true, force: true });
    }
  });

  it("Defect 3: replaces ONLY legacy escalate-on-churn.py hook, preserving unrelated hooks", async () => {
    const app = appFor();
    const claudeSettings = join(testHome, ".claude", "settings.json");
    mkdirSync(join(testHome, ".claude"), { recursive: true });
    writeFileSync(
      claudeSettings,
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "python3 /path/to/unrelated-linter.py" }],
              },
              {
                matcher: "Edit|Write|NotebookEdit",
                hooks: [{ type: "command", command: "python3 ~/.agents/escalate-on-churn.py" }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const code = await main(["setup", "--apply"], app);
    expect(code).toBe(0);

    const updated = JSON.parse(readFileSync(claudeSettings, "utf8"));
    const postToolUse = updated.hooks.PostToolUse;
    // Unrelated hook preserved
    expect(postToolUse[0].hooks[0].command).toBe("python3 /path/to/unrelated-linter.py");
    // Legacy churn hook replaced with npx -y token-furnace hook churn
    expect(postToolUse[1].hooks[0].command).toBe("npx -y token-furnace hook churn");
  });

  it("Defect 4: updating outdated BEGIN/END block preserves END marker and trailing user prose across multiple applies", async () => {
    const app = appFor();
    const claudeMd = join(testHome, ".claude", "CLAUDE.md");
    mkdirSync(join(testHome, ".claude"), { recursive: true });
    const outdatedDoc = [
      "# My Project Instructions",
      "",
      "<!-- token-furnace:begin -->",
      "Old outdated instruction line here.",
      "<!-- token-furnace:end -->",
      "",
      "## Trailing Section",
      "Keep this user prose intact forever.",
    ].join("\n");
    writeFileSync(claudeMd, outdatedDoc);

    // Apply 1: update instruction line
    const code1 = await main(["setup", "--apply"], app);
    expect(code1).toBe(0);

    const content1 = readFileSync(claudeMd, "utf8");
    expect(content1).toContain("<!-- token-furnace:begin -->");
    expect(content1).toContain("<!-- token-furnace:end -->");
    expect(content1).toContain("## Trailing Section\nKeep this user prose intact forever.");
    expect(content1).toContain("Full policy: `~/.agents/skills/token-furnace/SKILL.md`.");

    // Apply 2: should be no-op and preserve exact file
    const code2 = await main(["setup", "--apply"], app);
    expect(code2).toBe(0);

    const content2 = readFileSync(claudeMd, "utf8");
    expect(content2).toBe(content1);
  });

  it("preserves malformed JSON without destroying data", async () => {
    const app = appFor();
    const claudeSettings = join(testHome, ".claude", "settings.json");
    mkdirSync(join(testHome, ".claude"), { recursive: true });
    const badJson = "{\ninvalid json here\n";
    writeFileSync(claudeSettings, badJson);

    // Neither dry run nor apply should destroy the malformed file
    const code = await main(["setup", "--apply"], app);
    expect(code).toBe(0);
    expect(readFileSync(claudeSettings, "utf8")).toBe(badJson);
  });

  it("review: filling an empty env value backs up before the write", async () => {
    const app = appFor();
    const claudeSettings = join(testHome, ".claude", "settings.json");

    // First apply brings everything current and creates backup #1.
    expect(await main(["setup", "--apply"], app)).toBe(0);

    const backupRoot = join(testHome, ".agents", "token-furnace-backups");
    const before = readdirSync(backupRoot).length;

    // Blank one env value: everything else is current, so the fill is the only change.
    const cfg = JSON.parse(readFileSync(claudeSettings, "utf8"));
    cfg.env.ENABLE_TOOL_SEARCH = "";
    writeFileSync(claudeSettings, JSON.stringify(cfg, null, 2) + "\n");

    expect(await main(["setup", "--apply"], app)).toBe(0);
    expect(JSON.parse(readFileSync(claudeSettings, "utf8")).env.ENABLE_TOOL_SEARCH).toBe("true");

    const dirs = readdirSync(backupRoot).sort();
    expect(dirs.length).toBe(before + 1);
    // The snapshot predates the fill: it still holds the empty value.
    const newest = join(backupRoot, dirs[dirs.length - 1]);
    expect(JSON.parse(readFileSync(join(newest, "claude-settings.json"), "utf8")).env.ENABLE_TOOL_SEARCH).toBe("");
  });

  it("review: a conflicting skill link is left alone and adds no backup on a no-op apply", async () => {
    const app = appFor();
    expect(await main(["setup", "--apply"], app)).toBe(0);

    const backupRoot = join(testHome, ".agents", "token-furnace-backups");
    const before = readdirSync(backupRoot).length;

    // Replace the claude token-furnace link with one pointing elsewhere.
    const linkPath = join(testHome, ".claude", "skills", "token-furnace");
    const elsewhere = join(testHome, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(elsewhere, linkPath);

    expect(await main(["setup", "--apply"], app)).toBe(0);

    // Left alone, and no new backup because nothing else needed a change.
    expect(resolve(dirname(linkPath), readlinkSync(linkPath))).toBe(resolve(elsewhere));
    expect(readdirSync(backupRoot).length).toBe(before);
  });

  it("trust boundary: non-object env/hooks shapes never throw or overwrite settings bytes", async () => {
    const app = appFor();
    const claudeSettings = join(testHome, ".claude", "settings.json");
    mkdirSync(join(testHome, ".claude"), { recursive: true });
    const variants: unknown[] = [
      { env: "oops" },
      { env: 42 },
      { env: [] },
      { env: null },
      { hooks: "nope" },
      { hooks: 7 },
      { hooks: [] },
      { hooks: null },
      [],
      42,
      null,
    ];
    for (const variant of variants) {
      const bytes = JSON.stringify(variant, null, 2) + "\n";
      writeFileSync(claudeSettings, bytes);
      expect(await main(["setup", "--apply"], app)).toBe(0);
      expect(readFileSync(claudeSettings, "utf8")).toBe(bytes);
    }
  });

  it("built CLI runs setup dry-run without writing to isolated HOME", () => {
    const cliBin = resolve(__dirname, "..", "dist", "cli.js");
    const result = execFileSync(process.execPath, [cliBin, "setup"], {
      env: { ...process.env, HOME: testHome, XDG_CACHE_HOME: join(testHome, ".cache") },
      encoding: "utf8",
    });
    expect(result).toContain("token-furnace setup");
    expect(readdirSync(testHome)).toEqual([]);
    expect(existsSync(join(testHome, ".agents"))).toBe(false);
    expect(existsSync(join(testHome, ".claude"))).toBe(false);
    expect(existsSync(join(testHome, ".codex"))).toBe(false);
  });

  it("quoted keys and commented table headers are preserved, not duplicated", async () => {
    const app = appFor();
    const codexConfig = join(testHome, ".codex", "config.toml");
    mkdirSync(join(testHome, ".codex"), { recursive: true });
    const initial = '"model_verbosity" = "high"\n[agents] # existing agents\nfoo = "keep"\n';
    writeFileSync(codexConfig, initial);

    expect(await main(["setup", "--apply"], app)).toBe(0);

    const after = readFileSync(codexConfig, "utf8");
    // The candidate parses, so there is no duplicate key and no second [agents] table.
    const parsed = parseToml(after) as Record<string, any>;
    expect(parsed.model_verbosity).toBe("high");
    expect(parsed.tool_output_token_limit).toBe(10000);
    expect(parsed.agents.foo).toBe("keep");
    expect(parsed.agents.max_concurrent_threads_per_session).toBe(3);
    expect(parsed.agents.default_subagent_reasoning_effort).toBe("medium");
    // Comments and the quoted existing key survive verbatim.
    expect(after).toContain("# existing agents");
    expect(after).toContain('"model_verbosity" = "high"');
    expect(after.match(/model_verbosity/g)?.length).toBe(1);
    expect(after.match(/^\[agents\]/gm)?.length).toBe(1);

    // Idempotent: a second apply changes nothing.
    expect(await main(["setup", "--apply"], app)).toBe(0);
    expect(readFileSync(codexConfig, "utf8")).toBe(after);
  });

  it("invalid existing codex TOML is left byte-for-byte unchanged", async () => {
    const app = appFor();
    const codexConfig = join(testHome, ".codex", "config.toml");
    mkdirSync(join(testHome, ".codex"), { recursive: true });
    const bad = 'model_verbosity = "low\n[agents\nfoo = "keep"\n';
    writeFileSync(codexConfig, bad);

    // Both dry run and apply must not touch an unparseable config.
    expect(await main(["setup"], app)).toBe(0);
    expect(readFileSync(codexConfig, "utf8")).toBe(bad);
    expect(await main(["setup", "--apply"], app)).toBe(0);
    expect(readFileSync(codexConfig, "utf8")).toBe(bad);
  });

  it("an unsupported inline agents table is skipped with a warning, not corrupted", async () => {
    const app = appFor();
    const codexConfig = join(testHome, ".codex", "config.toml");
    mkdirSync(join(testHome, ".codex"), { recursive: true });
    writeFileSync(codexConfig, 'agents = { foo = "keep" }\n');

    expect(await main(["setup", "--apply"], app)).toBe(0);

    const after = readFileSync(codexConfig, "utf8");
    const parsed = parseToml(after) as Record<string, any>;
    expect(parsed.agents.foo).toBe("keep");
    // No [agents] table was appended (that would not parse): the shape is left alone.
    expect(parsed.agents.max_concurrent_threads_per_session).toBeUndefined();
    expect(after).not.toContain("[agents]");
  });
  it("does not insert settings into a multiline string containing a table header", async () => {
    const app = appFor();
    const codexConfig = join(testHome, ".codex", "config.toml");
    mkdirSync(join(testHome, ".codex"), { recursive: true });
    const initial = 'note = """\n[agents]\nkeep this text\n"""\n';
    writeFileSync(codexConfig, initial);

    expect(await main(["setup", "--apply"], app)).toBe(0);
    expect(readFileSync(codexConfig, "utf8")).toBe(initial);
  });

});
