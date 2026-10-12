import { execFile } from "node:child_process";
import type { Source } from "../core/model";

/** Headless agent runs found in the process table, per source. */
export interface Headless {
  /** Runs that leave no transcript at all (codex exec --ephemeral), so nothing else can count them. */
  hidden: Partial<Record<Source, number>>;
  /** Headless runs that normally write a transcript; the report subtracts the ones it already sees. */
  visible: Partial<Record<Source, number>>;
}

const RUNNERS = new Set(["node", "nodejs", "bun", "deno"]);
const FLAGS = { claude: ["-p", "--print"], codex: ["exec"], opencode: ["run"] } as const;

function tokens(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** `C:\bin\Codex.EXE` and `/usr/bin/codex.js` both become `codex`. */
function name(path: string): string {
  return (path.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|js|mjs)$/, "");
}

/**
 * Counts process-table lines that run an agent without a terminal UI. Only argv[0] (or the script
 * after node/bun) can name the agent, so a shell line that merely mentions `codex exec` never counts.
 * Interactive sessions are left out: they write transcripts and may sit idle for days.
 */
export function parseHeadless(text: string): Headless {
  const out: Headless = { hidden: {}, visible: {} };
  for (const line of text.split("\n")) {
    const argv = tokens(line.trim());
    const at = argv[0] && RUNNERS.has(name(argv[0])) ? 1 : 0;
    const agent = name(argv[at] ?? "") as Source;
    const marks = FLAGS[agent as keyof typeof FLAGS];
    if (!marks || !argv.slice(at + 1).some((a) => (marks as readonly string[]).includes(a))) continue;
    const args = argv.slice(at + 1);
    const hidden = (agent === "codex" && args.includes("--ephemeral")) || (agent === "claude" && args.includes("--no-session-persistence"));
    const bucket = hidden ? out.hidden : out.visible;
    bucket[agent] = (bucket[agent] ?? 0) + 1;
  }
  return out;
}

let cached: { at: number; value: Headless } | null = null;

/** The process table through the platform's own tool. Any failure reads as "none found". */
export function headlessAgents(now = Date.now()): Promise<Headless> {
  if (cached && now - cached.at < 10_000) return Promise.resolve(cached.value);
  const [cmd, args] = process.platform === "win32"
    ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"]]
    : ["ps", ["-axo", "args="]];
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, maxBuffer: 16 << 20, windowsHide: true }, (error, stdout) => {
      const value = error ? { hidden: {}, visible: {} } : parseHeadless(stdout);
      cached = { at: now, value };
      resolve(value);
    });
  });
}
