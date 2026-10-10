import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { CONFIG_REPAIRS, type ConfigRepairId } from "../core/config-repairs";
import { CONTEXT_TARGET } from "../core/context";
import { SUBAGENT_CAP, SUBAGENT_DEPTH, TOOL_CONCURRENCY, SUBAGENT_ENV, CODEX_SUBAGENT_KEY } from "../core/analyze/flags";
import type { Env } from "../sources/agent-source";

export interface SetupOptions {
  apply?: boolean;
  aggressive?: boolean;
  rollback?: boolean;
  verify?: boolean;
}

const SKILLS = ["token-furnace", "prd-creator", "prd-manager"];

const BEGIN = "<!-- token-furnace:begin -->";
const END = "<!-- token-furnace:end -->";
const LINE =
  "Token discipline, every session: slice uncertain or cross-file work into a compact PRD with the `prd-creator` skill first and execute from that, rather than exploring and implementing in one context (`prd-manager` reports where PRDs stand); retrieve the smallest range that answers the question and **never re-establish a fact you already have** — no confirming grep after a read that answered it; run the smallest test that can falsify the current hypothesis; after two failures with the same cause, stop editing and re-plan. Full policy: `~/.agents/skills/token-furnace/SKILL.md`.";

function createBackupDir(backupRoot: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let dir = join(backupRoot, base);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  let counter = 1;
  while (existsSync(`${dir}.${counter}`)) {
    counter++;
  }
  dir = `${dir}.${counter}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function collapseHome(path: string, home: string): string {
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Resolve TOML keys through the parser so quoted keys and comments cannot hide existing settings. */
function getTomlValue(text: string, table: string, key: string): string | undefined {
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const scope = table ? data[table] : data;
  if (!isPlainObject(scope)) return undefined;
  const v = scope[key];
  if (v === undefined) return undefined;
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

/** The unquoted name of a `[table]` header line, or null when the line is not one. */
function tableHeaderName(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith("[") || t.startsWith("[[")) return null;
  const close = t.indexOf("]");
  if (close === -1) return null;
  let name = t.slice(1, close).trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1);
  }
  return name;
}

function setTomlValue(content: string, table: string, key: string, val: string): string {
  const lines = content.length > 0 ? content.split("\n") : [];
  // Normalize lines to retain original endings if needed or standard \n
  const linesWithNl = lines.map((l) => `${l}\n`);
  const assignment = `${key} = ${val}\n`;
  const hdr = `[${table}]`;
  if (table) {
    const idx = linesWithNl.findIndex((l) => tableHeaderName(l) === table);
    if (idx === -1) {
      if (linesWithNl.length > 0 && !linesWithNl[linesWithNl.length - 1].endsWith("\n")) {
        linesWithNl.push("\n");
      }
      linesWithNl.push("\n", `${hdr}\n`, assignment);
    } else {
      linesWithNl.splice(idx + 1, 0, assignment);
    }
  } else {
    let i = linesWithNl.findIndex((l) => l.trimStart().startsWith("["));
    if (i === -1) i = linesWithNl.length;
    const atTable = i < linesWithNl.length;
    while (i > 0 && !linesWithNl[i - 1].trim()) {
      i--;
    }
    linesWithNl.splice(i, 0, assignment, ...(atTable ? [] : ["\n"]));
  }
  return linesWithNl.join("");
}

export function runSetup(
  opts: SetupOptions,
  env: Env = process.env,
  out: { write(text: string): unknown } = process.stdout,
): number {
  const home = env.HOME ?? "";
  const apply = Boolean(opts.apply);
  const aggressive = Boolean(opts.aggressive);
  const rollback = Boolean(opts.rollback);
  const verifyOnly = Boolean(opts.verify);

  const hub = join(home, ".agents", "skills");
  const claudeDir = join(home, ".claude");
  const codexDir = join(home, ".codex");
  const backupRoot = join(home, ".agents", "token-furnace-backups");

  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = existsSync(join(here, "SKILL.md"))
    ? here
    : existsSync(join(here, "..", "SKILL.md"))
      ? resolve(here, "..")
      : resolve(here, "..", "..");
  const skillsParent = resolve(packageRoot, "..");

  const tracked: Array<{ label: string; path: string }> = [
    { label: "claude-settings.json", path: join(claudeDir, "settings.json") },
    { label: "claude-mcp.json", path: join(home, ".claude.json") },
    { label: "claude-CLAUDE.md", path: join(claudeDir, "CLAUDE.md") },
    { label: "codex-config.toml", path: join(codexDir, "config.toml") },
    { label: "codex-AGENTS.md", path: join(codexDir, "AGENTS.md") },
  ];

  const say = (s: string) => out.write(`  ${s}\n`);
  const ok = (s: string) => out.write(`  \x1b[32mok\x1b[0m    ${s}\n`);
  const plan = (s: string) => out.write(`  \x1b[33mwould\x1b[0m ${s}\n`);
  const did = (s: string) => out.write(`  \x1b[36mdid\x1b[0m   ${s}\n`);
  const warn = (s: string) => out.write(`  \x1b[31mskip\x1b[0m  ${s}\n`);
  const bad = (s: string) => out.write(`  \x1b[31mFAIL\x1b[0m  ${s}\n`);
  const head = (s: string) => out.write(`\n\x1b[1m${s}\x1b[0m\n`);

  // --- Rollback ---
  if (rollback) {
    let latest = "";
    if (existsSync(backupRoot)) {
      const entries = readdirSync(backupRoot).filter((e) => {
        try {
          return lstatSync(join(backupRoot, e)).isDirectory();
        } catch {
          return false;
        }
      }).sort();
      if (entries.length > 0) {
        latest = join(backupRoot, entries[entries.length - 1]);
      }
    }
    if (!latest) {
      out.write(`no backups in ${backupRoot}\n`);
      return 1;
    }
    out.write(`restoring ${latest}\n`);
    for (const item of tracked) {
      const backupFile = join(latest, item.label);
      if (existsSync(backupFile)) {
        mkdirSync(dirname(item.path), { recursive: true });
        // Keep the live file before overwriting it, so this rollback is itself reversible.
        if (existsSync(item.path)) {
          copyFileSync(item.path, join(latest, `${item.label}.pre-rollback`));
        }
        copyFileSync(backupFile, item.path);
      } else if (existsSync(item.path)) {
        renameSync(item.path, `${item.path}.token-furnace-removed`);
      }
    }
    out.write("restored\n");
    return 0;
  }

  // --- Verify ---
  const runVerification = (): number => {
    head("Verify");
    let fails = 0;

    const claudeSettings = join(claudeDir, "settings.json");
    if (existsSync(claudeSettings)) {
      let valid = false;
      let parsed: any = null;
      try {
        parsed = JSON.parse(readFileSync(claudeSettings, "utf8"));
        if (parsed && typeof parsed === "object") valid = true;
      } catch {}
      if (valid) {
        ok("settings.json parses");
        for (const k of ["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "ENABLE_TOOL_SEARCH", "MAX_MCP_OUTPUT_TOKENS"]) {
          const v = parsed?.env?.[k];
          if (v !== undefined && v !== "") {
            ok(`claude ${k}=${v}`);
          } else {
            bad(`claude ${k} missing`);
            fails++;
          }
        }
      } else {
        bad("settings.json is not valid JSON");
        fails++;
      }
    } else {
      bad(`${claudeSettings} missing`);
      fails++;
    }

    const codexConfig = join(codexDir, "config.toml");
    if (existsSync(codexConfig)) {
      const tomlText = readFileSync(codexConfig, "utf8");
      ok("config.toml readable");
      const pairs: Array<{ table: string; key: string }> = [
        { table: "", key: "model_verbosity" },
        { table: "", key: "tool_output_token_limit" },
        { table: "agents", key: "max_concurrent_threads_per_session" },
        { table: "agents", key: "default_subagent_reasoning_effort" },
      ];
      for (const p of pairs) {
        const v = getTomlValue(tomlText, p.table, p.key);
        const label = p.table ? `${p.table}.${p.key}` : p.key;
        if (v !== undefined) {
          const display = v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
          ok(`codex ${label}=${display}`);
        } else {
          bad(`codex ${label} missing`);
          fails++;
        }
      }
    } else {
      bad(`${codexConfig} missing`);
      fails++;
    }

    for (const s of SKILLS) {
      // token-furnace must always resolve; prd-* are optional, only checked when the
      // installer had them available.
      if (s !== "token-furnace" && !existsSync(join(skillsParent, s))) continue;
      for (const d of [join(claudeDir, "skills", s), join(codexDir, "skills", s)]) {
        const skillFile = join(d, "SKILL.md");
        const disp = collapseHome(d, home);
        if (existsSync(skillFile)) {
          ok(`${disp}/SKILL.md readable`);
        } else {
          let isLink = false;
          try {
            isLink = lstatSync(d).isSymbolicLink();
          } catch {}
          if (isLink) bad(`${disp} is a dangling link`);
          else bad(`${disp} missing`);
          fails++;
        }
      }
    }

    // Hook check
    let hookWired = false;
    if (existsSync(claudeSettings)) {
      try {
        const cfg = JSON.parse(readFileSync(claudeSettings, "utf8"));
        const postToolUse = cfg?.hooks?.PostToolUse;
        if (Array.isArray(postToolUse)) {
          for (const item of postToolUse) {
            if (Array.isArray(item?.hooks)) {
              for (const h of item.hooks) {
                if (
                  typeof h?.command === "string" &&
                  (h.command.includes("hook churn") || h.command.includes("escalate-on-churn.py"))
                ) {
                  hookWired = true;
                }
              }
            }
          }
        }
      } catch {}
    }
    if (hookWired) {
      ok("PostToolUse escalate-on-churn wired");
    } else {
      bad("PostToolUse escalate-on-churn not wired");
      fails++;
    }

    for (const f of [join(claudeDir, "CLAUDE.md"), join(codexDir, "AGENTS.md")]) {
      const disp = collapseHome(f, home);
      let carries = false;
      if (existsSync(f)) {
        const content = readFileSync(f, "utf8");
        if (content.includes(LINE)) carries = true;
      }
      if (carries) ok(`${disp} carries the line`);
      else {
        bad(`${disp} is missing the token-furnace line`);
        fails++;
      }
    }

    let restorable = false;
    let latestDir = "";
    if (existsSync(backupRoot)) {
      const list = readdirSync(backupRoot).filter((e) => {
        try {
          return lstatSync(join(backupRoot, e)).isDirectory();
        } catch {
          return false;
        }
      }).sort();
      if (list.length > 0) {
        latestDir = join(backupRoot, list[list.length - 1]);
        if (existsSync(join(latestDir, "restore.sh"))) restorable = true;
      }
    }
    if (restorable) {
      ok(`backup restorable: ${collapseHome(latestDir, home)}`);
    } else {
      bad(`no restorable backup in ${collapseHome(backupRoot, home)}`);
      fails++;
    }

    if (fails === 0) {
      out.write("\n  \x1b[32mall checks passed\x1b[0m\n");
      return 0;
    }
    out.write(`\n  \x1b[31m${fails} check(s) failed\x1b[0m\n`);
    return 1;
  };

  if (verifyOnly) {
    return runVerification();
  }

  function shQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  // Backup is lazy: created once, immediately before the first real mutation. A
  // no-op apply writes nothing, and the snapshot always predates every change.
  let backupDir = "";
  function ensureBackup(): void {
    if (backupDir) return;
    backupDir = createBackupDir(backupRoot);
    const restoreScriptLines: string[] = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'd="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    ];
    for (const pair of tracked) {
      if (existsSync(pair.path)) {
        copyFileSync(pair.path, join(backupDir, pair.label));
        const qPath = shQuote(pair.path);
        restoreScriptLines.push(
          `if [ -f ${qPath} ]; then cp -p ${qPath} "$d/${pair.label}.pre-rollback"; fi`,
        );
        restoreScriptLines.push(`cp -p "$d/${pair.label}" ${qPath}`);
        did(`saved ${pair.path}`);
      } else {
        const qPath = shQuote(pair.path);
        const qRem = shQuote(`${pair.path}.token-furnace-removed`);
        restoreScriptLines.push(`if [ -f ${qPath} ]; then mv ${qPath} ${qRem}; fi`);
        say(`absent ${pair.path} (restore will move it aside, not delete)`);
      }
    }
    restoreScriptLines.push('echo "restored"');
    const restoreScript = join(backupDir, "restore.sh");
    // Raw writeFileSync, not writeConfig: writing the script must not recurse into a backup.
    writeFileSync(restoreScript, restoreScriptLines.join("\n") + "\n");
    try {
      chmodSync(restoreScript, 0o755);
    } catch {}
    ok(backupDir);
    say("undo with: token-furnace setup --rollback");
  }

  // Every config and instruction write snapshots the tracked files first, exactly once.
  function writeConfig(path: string, text: string): void {
    ensureBackup();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  // --- Backup ---
  head("Backup");
  if (apply) {
    say("created before the first change, if a change is needed");
  } else {
    plan(`back up 5 files to ${backupRoot}/<timestamp>/ with a restore.sh`);
  }

  // --- 1. Skills ---
  head("1. Skills (both agents)");
  const linkSkill = (target: string, linkPath: string) => {
    const disp = collapseHome(linkPath, home);
    const dispT = collapseHome(target, home);
    let exists = false;
    let isLink = false;
    try {
      const stat = lstatSync(linkPath);
      exists = true;
      isLink = stat.isSymbolicLink();
    } catch {}

    if (exists) {
      let resolved = "";
      try {
        resolved = resolve(dirname(linkPath), readlinkSync(linkPath));
      } catch {
        resolved = resolve(linkPath);
      }
      if (resolved === resolve(target)) {
        ok(disp);
        return;
      }
      warn(`${disp} exists and points elsewhere — left alone`);
      return;
    }

    if (apply) {
      mkdirSync(dirname(linkPath), { recursive: true });
      ensureBackup();
      symlinkSync(target, linkPath);
      did(disp);
    } else {
      plan(`link ${disp} -> ${dispT}`);
    }
  };

  for (const s of SKILLS) {
    const srcPath = s === "token-furnace"
      ? (existsSync(join(packageRoot, "SKILL.md")) ? packageRoot : join(skillsParent, s))
      : join(skillsParent, s);
    if (!existsSync(srcPath)) {
      warn(`${s} not found`);
      continue;
    }
    const hubPath = join(hub, s);
    linkSkill(srcPath, hubPath);
    linkSkill(hubPath, join(claudeDir, "skills", s));
    linkSkill(hubPath, join(codexDir, "skills", s));
  }

  // --- 2. Always-on instruction ---
  head("2. Always-on instruction");
  const inject = (filePath: string) => {
    const disp = collapseHome(filePath, home);
    let currentContent = "";
    if (existsSync(filePath)) {
      currentContent = readFileSync(filePath, "utf8");
      if (currentContent.includes(BEGIN)) {
        if (currentContent.includes(LINE)) {
          ok(`${disp} current`);
          return;
        }
        if (apply) {
          const lines = currentContent.split("\n");
          const outLines: string[] = [];
          let skip = false;
          for (const l of lines) {
            if (l === BEGIN) {
              outLines.push(BEGIN, LINE, END);
              skip = true;
              continue;
            }
            if (l === END) {
              skip = false;
              continue;
            }
            if (!skip) outLines.push(l);
          }
          writeConfig(filePath, outLines.join("\n"));
          did(`${disp} line replaced`);
        } else {
          plan(`replace the line between markers in ${disp}`);
        }
        return;
      }
    }
    if (apply) {
      const prefix = currentContent.length > 0 ? "\n" : "";
      const addition = `${prefix}${BEGIN}\n${LINE}\n${END}\n`;
      writeConfig(filePath, currentContent + addition);
      did(`${disp} line added`);
    } else {
      plan(`append the marked line to ${disp}`);
    }
  };
  inject(join(claudeDir, "CLAUDE.md"));
  inject(join(codexDir, "AGENTS.md"));

  // --- 3. Token-efficient defaults ---
  head("3. Token-efficient defaults");

  const claudeSettingsPath = join(claudeDir, "settings.json");
  let claudeCfg: any = {};
  let claudeJsonMalformed = false;
  if (existsSync(claudeSettingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(claudeSettingsPath, "utf8"));
      // A non-object top level, or a non-object env/hooks, would throw or silently
      // clobber bytes on write. Treat all of them as malformed and leave the file alone.
      const envOk = parsed?.env === undefined || isPlainObject(parsed?.env);
      const hooksOk = parsed?.hooks === undefined || isPlainObject(parsed?.hooks);
      if (isPlainObject(parsed) && envOk && hooksOk) {
        claudeCfg = parsed;
      } else {
        claudeJsonMalformed = true;
      }
    } catch {
      claudeJsonMalformed = true;
    }
  }

  const setClaudeEnv = (k: string, v: string | boolean | number) => {
    if (claudeJsonMalformed) {
      warn(`claude settings.json is malformed JSON — left alone (wanted ${k}=${v})`);
      return;
    }
    const strVal = String(v);
    const cur = claudeCfg?.env?.[k];
    if (cur !== undefined && String(cur) === strVal) {
      ok(`claude ${k}=${strVal}`);
      return;
    }
    if (cur !== undefined && String(cur) !== "") {
      warn(`claude ${k} already set to "${cur}" — left alone (wanted ${strVal})`);
      return;
    }
    if (apply) {
      if (!claudeCfg.env) claudeCfg.env = {};
      claudeCfg.env[k] = v;
      writeConfig(claudeSettingsPath, JSON.stringify(claudeCfg, null, 2) + "\n");
      did(`claude ${k}=${strVal}`);
    } else {
      plan(`set claude ${k}=${strVal}`);
    }
  };

  const setClaudeHook = () => {
    if (claudeJsonMalformed) {
      warn("claude settings.json is malformed JSON — left alone (wanted PostToolUse hook)");
      return;
    }
    const targetCmd = "npx -y token-furnace hook churn";
    let replacedLegacy = false;
    let alreadyConfigured = false;
    const postToolUse = claudeCfg?.hooks?.PostToolUse;
    if (Array.isArray(postToolUse)) {
      for (const item of postToolUse) {
        if (Array.isArray(item?.hooks)) {
          for (const h of item.hooks) {
            if (h?.command === targetCmd) {
              alreadyConfigured = true;
            } else if (typeof h?.command === "string" && h.command.includes("escalate-on-churn.py")) {
              if (apply) {
                h.command = targetCmd;
              }
              replacedLegacy = true;
            }
          }
        }
      }
    }
    if (replacedLegacy && apply) {
      writeConfig(claudeSettingsPath, JSON.stringify(claudeCfg, null, 2) + "\n");
      did("claude PostToolUse replaced legacy escalate-on-churn.py hook");
      return;
    }
    if (alreadyConfigured) {
      ok("claude PostToolUse escalate-on-churn");
      return;
    }
    if (apply) {
      if (!claudeCfg.hooks) claudeCfg.hooks = {};
      if (!Array.isArray(claudeCfg.hooks.PostToolUse)) claudeCfg.hooks.PostToolUse = [];
      claudeCfg.hooks.PostToolUse.push({
        matcher: "Edit|Write|NotebookEdit",
        hooks: [{ type: "command", command: targetCmd }],
      });
      writeConfig(claudeSettingsPath, JSON.stringify(claudeCfg, null, 2) + "\n");
      did("claude PostToolUse escalate-on-churn");
    } else {
      plan("wire claude PostToolUse escalate-on-churn");
    }
  };

  const codexConfigPath = join(codexDir, "config.toml");
  let codexToml = "";
  let codexTomlInvalid = false;
  if (existsSync(codexConfigPath)) {
    codexToml = readFileSync(codexConfigPath, "utf8");
    try {
      parseToml(codexToml);
    } catch {
      codexTomlInvalid = true;
      warn("codex config.toml is not valid TOML — left unchanged");
    }
  }

  const setCodexIfUnset = (table: string, key: string, tomlVal: string, humanVal: string) => {
    if (codexTomlInvalid) return;
    const cur = getTomlValue(codexToml, table, key);
    const label = table ? `${table}.${key}` : key;
    if (cur !== undefined) {
      const display = cur.startsWith('"') && cur.endsWith('"') ? cur.slice(1, -1) : cur;
      if (display === humanVal) {
        ok(`codex ${label} = ${humanVal}`);
        return;
      }
      warn(`codex ${label} already "${display}" — left alone (wanted ${humanVal})`);
      return;
    }
    if (apply) {
      const candidate = setTomlValue(codexToml, table, key, tomlVal);
      // shortcut: unsupported table layouts are skipped; use a preserving editor if they need support.
      try {
        parseToml(candidate);
        // An apparent table header can be inside a multiline string.
        if (getTomlValue(candidate, table, key) !== tomlVal) throw new Error("Setting was not inserted");
      } catch {
        warn(`codex ${label}: cannot set without risking config — left alone`);
        return;
      }
      codexToml = candidate;
      writeConfig(codexConfigPath, codexToml);
      did(`codex ${label} = ${tomlVal}`);
    } else {
      plan(`set codex ${label} = ${tomlVal}`);
    }
  };

  setClaudeEnv("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "3");
  setClaudeEnv("ENABLE_TOOL_SEARCH", "true");
  setClaudeEnv("MAX_MCP_OUTPUT_TOKENS", "12000");
  setClaudeHook();

  setCodexIfUnset("", "model_verbosity", '"low"', "low");
  setCodexIfUnset("", "tool_output_token_limit", "10000", "10000");
  setCodexIfUnset("agents", "max_concurrent_threads_per_session", "3", "3");
  setCodexIfUnset("agents", "default_subagent_reasoning_effort", '"medium"', "medium");

  head("   Flagged as risky");
  if (aggressive) {
    say("--aggressive: spawn depth has version-specific reports of behaving one level off.");
    say("Verify after any Claude Code upgrade that subagents still spawn.");
    setClaudeEnv("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", "1");
  } else {
    say("not set (pass --aggressive to include, after reading SKILL.md):");
    say("  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1   may block all spawning on some versions");
  }

  head("Never set by this script");
  say("CLAUDE_CODE_EFFORT_LEVEL         your reasoning baseline is yours, not a script's");
  say("codex model_reasoning_effort     same — not read, not written, not suggested");
  say("codex skills.max_context_tokens  truncates the skill catalog; prune skills instead");
  say("codex agents.max_depth           not in the current official config reference");

  // Like the original `verify || true`: report failures, never fail or falsely pass the apply.
  if (apply) {
    runVerification();
    if (!backupDir) ok("configuration already current (no-op apply; no backup created)");
  }

  head("Next");
  if (apply) {
    say("1. Start a fresh session in either agent.");
    say("2. Confirm the token-furnace line is in context.");
    say("3. Re-check any time: token-furnace setup --verify");
    say("4. Unhappy with anything: token-furnace setup --rollback");
  } else {
    say("Dry run. Nothing was written.");
    say("Apply with: token-furnace setup --apply");
  }

  return 0;
}

/** Repair actionable settings; back up every changed file before writing either config. */
export function runFixConfig(env: Env, out: { write(text: string): unknown }, options: { includeDepth?: boolean; repairs?: readonly ConfigRepairId[] } = {}): number {
  try {
    const repairs = options.repairs ?? CONFIG_REPAIRS.filter((repair) => options.includeDepth || !repair.id.endsWith("-depth")).map((repair) => repair.id);
    if (!Array.isArray(repairs) || repairs.some((id) => !CONFIG_REPAIRS.some((repair) => repair.id === id))) {
      throw new Error("Unknown configuration repair selection");
    }
    if (!repairs.length) { out.write("No repairs selected. No files changed.\n"); return 0; }
    const selected = (id: ConfigRepairId) => repairs.includes(id);
    if (!env.HOME) throw new Error("HOME must be set");
    const claudePath = join(env.CLAUDE_CONFIG_DIR || join(env.HOME, ".claude"), "settings.json");
    const codexPath = join(env.CODEX_HOME || join(env.HOME, ".codex"), "config.toml");
    const changes: { path: string; before: string | null; after: string }[] = [];
    const withinCap = (value: unknown, cap: number) => {
      const n = typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN;
      return Number.isInteger(n) && n >= 0 && n <= cap;
    };
    if (repairs.some((id) => id.startsWith("claude-"))) {
      const beforeClaude = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : null;
      const claude = JSON.parse(beforeClaude ?? "{}");
      if (!isPlainObject(claude) || (claude.env !== undefined && !isPlainObject(claude.env))) {
        throw new Error(`${claudePath}: expected an object with an optional env object`);
      }
      const originalClaude = JSON.stringify(claude);
      const hadEnv = claude.env !== undefined;
      const claudeEnv = (claude.env ??= {}) as Record<string, unknown>;
      if (selected("claude-context")) claude.autoCompactWindow = CONTEXT_TARGET.claude;
      if (selected("claude-context") && claudeEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined) {
        claudeEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(CONTEXT_TARGET.claude);
      }
      for (const [id, key, cap] of [
        ["claude-workers", SUBAGENT_ENV, SUBAGENT_CAP],
        ["claude-tools", "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY", TOOL_CONCURRENCY],
        ["claude-depth", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", SUBAGENT_DEPTH],
      ] as const) {
        if (selected(id) && !withinCap(claudeEnv[key], cap)) claudeEnv[key] = String(cap);
      }
      if (selected("claude-model") && (typeof claudeEnv.CLAUDE_CODE_SUBAGENT_MODEL !== "string" || !claudeEnv.CLAUDE_CODE_SUBAGENT_MODEL.trim())) {
        claudeEnv.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet";
      }
      if (!hadEnv && !Object.keys(claudeEnv).length) delete claude.env;
      if (JSON.stringify(claude) !== originalClaude) {
        changes.push({ path: claudePath, before: beforeClaude, after: JSON.stringify(claude, null, 2) + "\n" });
      }
    }

    if (repairs.some((id) => id.startsWith("codex-"))) {
      const beforeCodex = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : null;
      const codex = parseToml(beforeCodex ?? "");
      if (codex.agents !== undefined && !isPlainObject(codex.agents)) {
        throw new Error(`${codexPath}: expected an agents table`);
      }
      const agents = (codex.agents ?? {}) as Record<string, unknown>;
      let afterCodex = beforeCodex ?? "";
      const updateCodex = (table: string, key: string, value: string | number) => {
        const object = table ? agents : codex;
        if (object[key] === value) return;
        const old = object[key];
        const encoded = JSON.stringify(value);
        if (old === undefined) {
          afterCodex = setTomlValue(afterCodex, table, key, encoded);
        } else {
          let scope = "";
          const quoted = (name: string) => `(?:${name}|"${name}"|'${name}')`;
          afterCodex = afterCodex.split("\n").map((line) => {
            if (line.trimStart().startsWith("[")) scope = tableHeaderName(line) ?? "other";
            const local = scope === table && new RegExp(`^\\s*${quoted(key)}\\s*=`).test(line);
            const dotted = table && scope === "" && new RegExp(`^\\s*${quoted(table)}\\s*\\.\\s*${quoted(key)}\\s*=`).test(line);
            return local || dotted ? `${dotted ? table + "." : ""}${key} = ${encoded}` : line;
          }).join("\n");
        }
        object[key] = value;
        if (table) codex.agents = agents;
      };
      if (selected("codex-context")) updateCodex("", "model_auto_compact_token_limit", CONTEXT_TARGET.codex);
      if (selected("codex-workers") && !withinCap(agents[CODEX_SUBAGENT_KEY], SUBAGENT_CAP)) updateCodex("agents", CODEX_SUBAGENT_KEY, SUBAGENT_CAP);
      if (selected("codex-effort") && !["low", "medium", "minimal", "none"].includes(String(agents.default_subagent_reasoning_effort))) {
        updateCodex("agents", "default_subagent_reasoning_effort", "medium");
      }
      if (selected("codex-depth") && !withinCap(agents.max_depth, SUBAGENT_DEPTH)) updateCodex("agents", "max_depth", SUBAGENT_DEPTH);
      // Reject unsupported layouts before backups or writes rather than risking unrelated data.
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(parseToml(afterCodex))), JSON.parse(JSON.stringify(codex)))) {
        throw new Error(`${codexPath}: unsupported setting layout; left unchanged`);
      }
      if (afterCodex !== (beforeCodex ?? "")) changes.push({ path: codexPath, before: beforeCodex, after: afterCodex });
    }

    const backups: string[] = [];
    for (const change of changes) {
      if (change.before === null) continue;
      let backup = `${change.path}.token-furnace-backup`;
      for (let i = 1; existsSync(backup); i++) backup = `${change.path}.token-furnace-backup.${i}`;
      writeFileSync(backup, change.before, { flag: "wx", mode: 0o600 });
      backups.push(backup);
    }
    for (const backup of backups) out.write(`Backup: ${backup}\n`);
    for (const change of changes) {
      mkdirSync(dirname(change.path), { recursive: true });
      writeFileSync(change.path, change.after, { mode: 0o600 });
      out.write(`Updated: ${change.path}\n`);
    }
    if (!changes.length) out.write("Configuration already current. No files changed.\n");
    out.write(`Selected repairs: ${repairs.join(", ")}. Restart agents to load changes.\n`);
    if (selected("claude-context") && env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
      out.write("Unset CLAUDE_CODE_AUTO_COMPACT_WINDOW in your shell so it cannot override the saved target.\n");
    }
    return 0;
  } catch (error) {
    out.write(`fix-config: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
