import { CONTEXT_TARGET } from "./context";

/** Provider-specific facts; analysis otherwise consumes normalized Turns. */
export const PROVIDERS = {
  claude: {
    label: "Claude Code",
    cacheWrites: true,
    parserVersion: 1,
    compaction: `"autoCompactWindow": ${CONTEXT_TARGET.claude} in ~/.claude/settings.json`,
  },
  opencode: {
    label: "OpenCode",
    cacheWrites: true,
    parserVersion: 1,
    compaction: "Use /compact in OpenCode to start a smaller context.",
  },
  codex: {
    label: "Codex",
    cacheWrites: false,
    parserVersion: 3,
    compaction: `model_auto_compact_token_limit = ${CONTEXT_TARGET.codex} in ~/.codex/config.toml`,
  },
} as const;
