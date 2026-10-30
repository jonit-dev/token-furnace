import {
  existsSync,
  mkdirSync,
  realpathSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseToml } from "smol-toml";
import { main } from "../src/cli";
import { compose } from "../src/compose";
import { runSetup } from "../src/setup/agents";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});

describe("token-furnace setup", () => {
  let testHome: string;
  let out: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(realpathSync(tmpdir()), "tf-setup-test-"));
    out = "";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(testHome, { recursive: true, force: true });
  });

  function appFor(env: Record<string, string | undefined> = {}) {
    return compose({
      HOME: testHome,
      ...env,
    }, { noCache: true });
  }

  it.each([false, true])("uses the OS home without HOME and respects custom directories (%s)", async (custom) => {
    vi.stubEnv("HOME", testHome);
    vi.stubEnv("USERPROFILE", testHome);
    const claudeDir = join(testHome, custom ? "claude custom" : ".claude");
    const codexDir = join(testHome, custom ? "codex custom" : ".codex");
    mkdirSync(claudeDir); mkdirSync(codexDir);
    const settings = join(claudeDir, "settings.json");
    const config = join(codexDir, "config.toml");
    writeFileSync(settings, '{"keep":true}');
    writeFileSync(config, 'keep = true\n');
    const app = appFor({ HOME: undefined,
      CLAUDE_CONFIG_DIR: custom ? claudeDir : undefined,
      CODEX_HOME: custom ? codexDir : undefined });
    let plan = "";
    expect(runSetup({}, app.env, { write: (text) => { plan += text; } })).toBe(0);
    expect(plan).toContain(join(testHome, ".agents", "token-furnace-backups"));
    expect(await main(["setup", "--apply"], app)).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8")).env.ENABLE_TOOL_SEARCH).toBe("true");
    expect(readFileSync(config, "utf8")).toContain('model_verbosity = "low"');
    expect(await main(["setup", "--verify"], app)).toBe(0);
    expect(await main(["fix-config"], app)).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8")).autoCompactWindow).toBe(400000);
    expect(parseToml(readFileSync(config, "utf8")).model_auto_compact_token_limit).toBe(300000);
    expect(await main(["setup", "--rollback"], app)).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe('{"keep":true}');
    expect(readFileSync(config, "utf8")).toBe('keep = true\n');
    if (custom) {
      // The absent default install is also configured by setup.
      expect(existsSync(join(testHome, ".claude", "settings.json"))).toBe(false);
      expect(existsSync(join(testHome, ".codex"))).toBe(false);
    }
  });

  it("applies and rolls back every discovered Claude install independently", async () => {
    const installs = [
      { dir: join(testHome, ".claude"), initial: JSON.stringify({ keep: "default" }) + "\n" },
      { dir: join(testHome, ".cc-work"), initial: JSON.stringify({ keep: "work" }) + "\n" },
    ];
    for (const install of installs) {
      mkdirSync(join(install.dir, "projects", "demo"), { recursive: true });
      writeFileSync(join(install.dir, "projects", "demo", "session.jsonl"), "{}\n");
      writeFileSync(join(install.dir, "settings.json"), install.initial);
    }
    const mcp = [join(testHome, ".claude.json"), join(installs[1].dir, ".claude.json")];
    mcp.forEach((path, i) => writeFileSync(path, JSON.stringify({ account: i })));
    const app = appFor();

    expect(await main(["setup", "--apply"], app)).toBe(0);
    for (const install of installs) {
      const settings = JSON.parse(readFileSync(join(install.dir, "settings.json"), "utf8"));
      expect(settings.keep).toBe(install.initial.includes("default") ? "default" : "work");
      expect(settings.env.ENABLE_TOOL_SEARCH).toBe("true");
      expect(readFileSync(join(install.dir, "CLAUDE.md"), "utf8")).toContain("token-furnace:begin");
      expect(existsSync(join(install.dir, "skills", "token-furnace", "SKILL.md"))).toBe(true);
    }

    const backupRoot = join(testHome, ".agents", "token-furnace-backups");
    const latest = readdirSync(backupRoot).sort().at(-1)!;
    expect(existsSync(join(backupRoot, latest, "claude-settings.json"))).toBe(true);
    expect(existsSync(join(backupRoot, latest, "claude-cc-work-claude-settings.json"))).toBe(true);

    expect(await main(["fix-config"], app)).toBe(0);
    for (const install of installs) {
      expect(JSON.parse(readFileSync(join(install.dir, "settings.json"), "utf8")).autoCompactWindow).toBe(400000);
      expect(existsSync(join(install.dir, "settings.json.token-furnace-backup"))).toBe(true);
    }
    mcp.forEach((path) => writeFileSync(path, "changed"));
    // The backup remembers the install even if its discovery markers later disappear.
    rmSync(join(installs[1].dir, "projects"), { recursive: true });
    expect(await main(["setup", "--rollback"], app)).toBe(0);
    mcp.forEach((path, i) => expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ account: i })));
    for (const install of installs) {
      expect(readFileSync(join(install.dir, "settings.json"), "utf8")).toBe(install.initial);
    }
  });

  it("repairs configuration without HOME when explicit agent directories are supplied", async () => {
    vi.stubEnv("HOME", testHome);
    vi.stubEnv("USERPROFILE", testHome);
    const app = appFor({ HOME: undefined, CLAUDE_CONFIG_DIR: join(testHome, "claude"), CODEX_HOME: join(testHome, "codex") });
    expect(await main(["fix-config"], app)).toBe(0);
    expect(JSON.parse(readFileSync(join(testHome, "claude", "settings.json"), "utf8")).autoCompactWindow).toBe(400000);
  });

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
    const hostileRoot = mkdtempSync(join(realpathSync(tmpdir()), "tf-test 'with space' $(echo evil) `touch marker`-"));
    try {
      const app = compose({ HOME: hostileRoot }, { noCache: true });
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
    symlinkSync(elsewhere, linkPath, process.platform === "win32" ? "junction" : "dir");

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

  it("links the bundled save-tokens-creator skill for both agents", async () => {
    const app = appFor();
    expect(await main(["setup", "--apply"], app)).toBe(0);
    for (const dir of [".claude", ".codex"]) {
      const skill = join(testHome, dir, "skills", "save-tokens-creator", "SKILL.md");
      expect(existsSync(skill), skill).toBe(true);
      expect(readFileSync(skill, "utf8")).toContain("save-tokens-creator");
    }
    expect(await main(["setup", "--verify"], app)).toBe(0);
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

describe("token-furnace fix-config", () => {
  let testHome: string;
  beforeEach(() => { testHome = mkdtempSync(join(realpathSync(tmpdir()), "tf-fix-config-")); });
  afterEach(() => { rmSync(testHome, { recursive: true, force: true }); });

  it("repairs both custom config paths, backs up original bytes, and is idempotent", async () => {
    const claudeDir = join(testHome, "claude-custom");
    const codexDir = join(testHome, "codex-custom");
    mkdirSync(claudeDir); mkdirSync(codexDir);
    const claudePath = join(claudeDir, "settings.json");
    const codexPath = join(codexDir, "config.toml");
    const claudeBytes = '{"autoCompactWindow":200000,"permissions":{"allow":[]},"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"800k","CUSTOM":"keep"}}';
    const codexBytes = '# keep comment\n"model_auto_compact_token_limit" = 160000\n[agents]\nmax_depth = 2\n';
    writeFileSync(claudePath, claudeBytes); writeFileSync(codexPath, codexBytes);
    const app = compose({ HOME: testHome, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir }, { noCache: true });
    expect(await main(["fix-config"], app)).toBe(0);
    expect(readFileSync(`${claudePath}.token-furnace-backup`, "utf8")).toBe(claudeBytes);
    expect(readFileSync(`${codexPath}.token-furnace-backup`, "utf8")).toBe(codexBytes);
    expect(JSON.parse(readFileSync(claudePath, "utf8"))).toEqual({ autoCompactWindow: 400000, permissions: { allow: [] }, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000", CUSTOM: "keep", CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "3", CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "4", CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } });
    expect(parseToml(readFileSync(codexPath, "utf8"))).toEqual({ model_auto_compact_token_limit: 300000, agents: { max_depth: 2, max_concurrent_threads_per_session: 3, default_subagent_reasoning_effort: "medium" } });
    expect(readFileSync(codexPath, "utf8")).toContain("# keep comment");
    expect(await main(["fix-config"], app)).toBe(0);
    expect(readdirSync(claudeDir)).toHaveLength(2);
    expect(readdirSync(codexDir)).toHaveLength(2);
  });

  it("leaves live config untouched when creating a backup fails", async () => {
    mkdirSync(join(testHome, ".claude"));
    const path = join(testHome, ".claude", "settings.json");
    writeFileSync(path, '{}');
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error("backup refused"); });
    expect(await main(["fix-config"], compose({ HOME: testHome }, { noCache: true }))).toBe(1);
    expect(readFileSync(path, "utf8")).toBe('{}');
    expect(existsSync(join(testHome, ".codex", "config.toml"))).toBe(false);
  });

  it("creates missing configuration with the requested targets", async () => {
    expect(await main(["fix-config"], compose({ HOME: testHome }, { noCache: true }))).toBe(0);
    expect(JSON.parse(readFileSync(join(testHome, ".claude", "settings.json"), "utf8")).autoCompactWindow).toBe(400000);
    expect(parseToml(readFileSync(join(testHome, ".codex", "config.toml"), "utf8")).model_auto_compact_token_limit).toBe(300000);
  });

  it("preserves healthy worker settings and only repairs depth when opted in", async () => {
    mkdirSync(join(testHome, ".claude")); mkdirSync(join(testHome, ".codex"));
    const claudePath = join(testHome, ".claude", "settings.json");
    const codexPath = join(testHome, ".codex", "config.toml");
    const env = { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2", CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "2", CLAUDE_CODE_SUBAGENT_MODEL: "haiku", CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "4" };
    writeFileSync(claudePath, JSON.stringify({ autoCompactWindow: 400000, env }));
    writeFileSync(codexPath, 'model_auto_compact_token_limit = 300000\n[agents]\nmax_concurrent_threads_per_session = 2\ndefault_subagent_reasoning_effort = "low"\nmax_depth = 4\n');
    const app = compose({ HOME: testHome }, { noCache: true });
    expect(await main(["fix-config"], app)).toBe(0);
    expect(JSON.parse(readFileSync(claudePath, "utf8")).env).toEqual(env);
    expect(await main(["fix-config", "--include-depth"], app)).toBe(0);
    expect(JSON.parse(readFileSync(claudePath, "utf8")).env).toEqual({ ...env, CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" });
    expect(parseToml(readFileSync(codexPath, "utf8")).agents).toEqual({ max_concurrent_threads_per_session: 2, default_subagent_reasoning_effort: "low", max_depth: 1 });
  });

  it("rejects malformed configuration before updating either file", async () => {
    mkdirSync(join(testHome, ".claude")); mkdirSync(join(testHome, ".codex"));
    const claudePath = join(testHome, ".claude", "settings.json");
    const codexPath = join(testHome, ".codex", "config.toml");
    writeFileSync(claudePath, '{}'); writeFileSync(codexPath, 'broken = "');
    const app = compose({ HOME: testHome }, { noCache: true });
    expect(await main(["fix-config"], app)).toBe(1);
    expect(readFileSync(claudePath, "utf8")).toBe('{}');
    expect(readdirSync(join(testHome, ".claude"))).toHaveLength(1);
    for (const invalid of ['[]', '{"env":null}', '{']) {
      writeFileSync(claudePath, invalid); writeFileSync(codexPath, '');
      expect(await main(["fix-config"], app)).toBe(1);
      expect(readFileSync(claudePath, "utf8")).toBe(invalid);
      expect(readFileSync(codexPath, "utf8")).toBe('');
    }
  });
});
