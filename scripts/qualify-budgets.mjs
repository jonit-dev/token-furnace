#!/usr/bin/env node
/**
 * Native qualification entrypoint. It only runs against explicitly dedicated homes so a
 * qualification cannot consume or terminate a personal session by accident.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const supported = ["claude", "codex", "opencode"];
const requested = parseSources(process.argv.slice(2));
const home = homedir();
const personal = new Set([
  realpathOr(join(home, ".claude")),
  realpathOr(join(home, ".codex")),
  realpathOr(join(home, ".local", "share", "opencode")),
]);
const config = {
  claude: process.env.TOKEN_FURNACE_QUALIFY_CLAUDE_HOME,
  codex: process.env.TOKEN_FURNACE_QUALIFY_CODEX_HOME,
  opencode: process.env.TOKEN_FURNACE_QUALIFY_OPENCODE_DATA_DIR,
};
const blocked = [];

for (const source of requested) {
  const command = source === "opencode" ? "opencode" : source;
  const dedicated = config[source];
  if (!dedicated) {
    blocked.push(`${source}: set TOKEN_FURNACE_QUALIFY_${source === "opencode" ? "OPENCODE_DATA_DIR" : `${source.toUpperCase()}_HOME`} to a disposable authenticated home`);
    continue;
  }
  const resolved = realpathOr(dedicated);
  if (!isAbsolute(dedicated) || !existsSync(dedicated) || personal.has(resolved)) {
    blocked.push(`${source}: qualification home is missing or resolves to a personal home`);
    continue;
  }
  const credential = join(dedicated, source === "claude" ? ".credentials.json" : "auth.json");
  if (!existsSync(credential)) {
    blocked.push(`${source}: dedicated credential file is missing`);
    continue;
  }
  const version = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: dedicated,
      CLAUDE_CONFIG_DIR: source === "claude" ? dedicated : undefined,
      CODEX_HOME: source === "codex" ? dedicated : undefined,
      OPENCODE_DATA_DIR: source === "opencode" ? dedicated : undefined,
      XDG_CONFIG_HOME: join(dedicated, ".config"),
      XDG_DATA_HOME: join(dedicated, ".local", "share"),
      XDG_STATE_HOME: join(dedicated, ".local", "state"),
      PATH: process.env.PATH,
    },
    timeout: 10_000,
  });
  if (version.error || version.status !== 0) blocked.push(`${source}: native executable could not be discovered`);
  else console.log(`DISCOVERED ${source}: ${String(version.stdout || version.stderr).trim().split("\n")[0]}`);
}

if (blocked.length) {
  console.error("BLOCKED: native authenticated budget qualification did not run.");
  for (const reason of blocked) console.error(`- ${reason}`);
  console.error("No provider requests, hook decisions, process cancellations, or PASS results were fabricated.");
  process.exitCode = 75;
} else {
  console.error("BLOCKED: dedicated homes were discovered, but the real provider/session scenario runner is not enabled in this checkout.");
  console.error("Implement and qualify the native browser, admission, provider-stop, model-stop, and force-recovery scenarios before claiming AC-1 or AC-4 through AC-8.");
  process.exitCode = 75;
}

function parseSources(args) {
  const index = args.indexOf("--sources");
  const value = index >= 0 ? args[index + 1] : supported.join(",");
  const sources = String(value || "").split(",").map((source) => source.trim()).filter(Boolean);
  const invalid = sources.filter((source) => !supported.includes(source));
  if (invalid.length || !sources.length) {
    console.error(`Usage: npm run qualify:budgets -- --sources ${supported.join(",")}`);
    process.exit(2);
  }
  return [...new Set(sources)];
}

function realpathOr(path) {
  try { return realpathSync(path); } catch { return path; }
}
