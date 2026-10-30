import { mkdirSync, symlinkSync, readlinkSync, readdirSync, realpathSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ProviderId } from "../core/model";
import type { Env } from "./agent-source";

export type ClaudeInstallSignal = "default" | "env" | "scan" | "shell-rc";

export interface ClaudeInstall {
  id: ProviderId;
  label: string;
  dir: string;
  isDefault: boolean;
  found: ClaudeInstallSignal[];
}

const RC_FILES = [
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".bashrc",
  ".bash_profile",
  ".profile",
  join(".config", "fish", "config.fish"),
];

/** Find Claude Code config directories without relying on their names. */
export function discoverClaudeInstalls(env: Env): ClaudeInstall[] {
  const home = env.HOME || homedir();
  const defaultDir = join(home, ".claude");
  const candidates = new Map<string, { dir: string; found: ClaudeInstallSignal[] }>();
  const add = (dir: string, signal: ClaudeInstallSignal, requireMarkers = true): void => {
    const resolved = realpathSafe(dir);
    if (requireMarkers && !looksLikeClaude(resolved)) return;
    const existing = candidates.get(resolved);
    if (existing) {
      if (!existing.found.includes(signal)) existing.found.push(signal);
      return;
    }
    candidates.set(resolved, { dir: resolved, found: [signal] });
  };

  add(defaultDir, "default", false);
  if (env.CLAUDE_CONFIG_DIR) add(env.CLAUDE_CONFIG_DIR, "env", false);
  for (const root of [home, env.XDG_CONFIG_HOME || join(home, ".config")]) {
    for (const name of readDirSafe(root)) {
      const dir = join(root, name);
      if (isDirectory(dir)) add(dir, "scan");
    }
  }
  for (const file of RC_FILES) {
    const text = readText(join(home, file));
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      const value = assignment(line);
      const dir = value === null ? null : expand(value, home);
      if (dir) add(dir, "shell-rc");
    }
  }

  const defaultKey = realpathSafe(defaultDir);
  const primary = candidates.get(defaultKey);
  const others = [...candidates.values()]
    .filter((candidate) => candidate !== primary)
    .sort((a, b) => a.dir.localeCompare(b.dir));
  const used = new Set<string>();
  const installs: ClaudeInstall[] = [];
  if (primary) {
    installs.push({ id: "claude", label: "Claude Code", dir: primary.dir, isDefault: primary.dir === defaultKey, found: primary.found });
  }
  for (const candidate of others) {
    const base = slug(candidate.dir);
    let value = base;
    for (let n = 2; used.has(value) || !reserveIdentity(env, value, candidate.dir); n++) value = `${base}-${n}`;
    used.add(value);
    installs.push({
      id: `claude:${value}`,
      label: `Claude Code (${value})`,
      dir: candidate.dir,
      isDefault: false,
      found: candidate.found,
    });
  }
  return installs.sort((a, b) => a.id === "claude" ? -1 : b.id === "claude" ? 1 : (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** The default install identity used by callers that intentionally request one install. */
export function defaultClaudeInstall(env: Env): ClaudeInstall {
  const dir = realpathSafe(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"));
  const home = realpathSafe(join(env.HOME || homedir(), ".claude"));
  return { id: "claude", label: "Claude Code", dir, isDefault: dir === home, found: ["default"] };
}

function looksLikeClaude(dir: string): boolean {
  const projects = join(dir, "projects");
  if (!isDirectory(projects)) return false;
  if (![".claude.json", "settings.json", "history.jsonl"].some((name) => isFile(join(dir, name)))) return false;
  return readDirSafe(projects).some((project) =>
    isDirectory(join(projects, project)) && readDirSafe(join(projects, project)).some((name) => name.endsWith(".jsonl") && isFile(join(projects, project, name))),
  );
}

function assignment(line: string): string | null {
  if (line.trimStart().startsWith("#")) return null;
  const match = /(?:^|[\s'"])(?:export\s+)?CLAUDE_CONFIG_DIR\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#;'"]+))/.exec(line);
  if (!match || /[$`\\]/.test(line[match.index + match[0].length] ?? "")) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function expand(value: string, home: string): string | null {
  const homeVariable = /\$HOME(?![a-zA-Z0-9_])|\$\{HOME\}/g;
  if (/[$`]/.test(value.replace(homeVariable, ""))) return null;
  let out = value.replace(homeVariable, () => home);
  if (out === "~") out = home;
  else if (out.startsWith("~/")) out = join(home, out.slice(2));
  return isAbsolute(out) ? resolve(out) : null;
}

function slug(dir: string): string {
  const name = basename(dir).replace(/^\.+/, "").replace(/^claude(?:[-_.]+)?/i, "");
  return (name || "install").replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch { return resolve(path); }
}

function readDirSafe(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Reserve suffixes atomically so changing discovery never reuses another install's identity. */
function reserveIdentity(env: Env, slug: string, dir: string): boolean {
  const root = join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "token-furnace", "claude-installs");
  const path = join(root, slug);
  try {
    mkdirSync(root, { recursive: true });
    symlinkSync(dir, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readlinkSync(path) === dir;
    throw new Error(`Cannot reserve Claude install identity in ${root}`, { cause: error });
  }
}
