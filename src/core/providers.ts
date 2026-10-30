import { CONTEXT_TARGET } from "./context";
import type { ProviderId, Source } from "./model";

/** Provider-specific facts; analysis otherwise consumes normalized Turns. */
export const PROVIDERS = {
  claude: {
    label: "Claude Code",
    rules: "CLAUDE.md",
    cacheWrites: true,
    parserVersion: 2,
    compaction: `"autoCompactWindow": ${CONTEXT_TARGET.claude} in ~/.claude/settings.json`,
  },
  opencode: {
    label: "OpenCode",
    rules: "AGENTS.md",
    cacheWrites: true,
    parserVersion: 1,
    compaction: "Use /compact in OpenCode to start a smaller context.",
  },
  codex: {
    label: "Codex",
    rules: "AGENTS.md",
    cacheWrites: false,
    parserVersion: 5,
    compaction: `model_auto_compact_token_limit = ${CONTEXT_TARGET.codex} in ~/.codex/config.toml`,
  },
} as const;

export function kindOf(id: ProviderId): Source | undefined {
  const kind = id.split(":", 1)[0] as Source;
  return Object.hasOwn(PROVIDERS, kind) ? kind : undefined;
}

export function providerOf(id: ProviderId): (typeof PROVIDERS)[Source] {
  const kind = kindOf(id);
  if (!kind) throw new Error(`Unknown provider id: ${id}`);
  return PROVIDERS[kind];
}

export function providerLabel(id: ProviderId): string {
  const provider = providerOf(id);
  const [, slug] = id.split(":", 2);
  return slug && kindOf(id) === "claude" ? `${provider.label} (${slug})` : provider.label;
}

export function contextTargetOf(id: ProviderId): number {
  const kind = kindOf(id);
  return kind ? CONTEXT_TARGET[kind] : 0;
}
