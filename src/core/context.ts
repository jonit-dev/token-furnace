/** Ideal context size per provider; shared by analysis, configuration repair and the UI. */
export const CONTEXT_TARGET = { claude: 400_000, codex: 300_000, opencode: 128_000 } as const;
export const CONTEXT_TARGET_LABEL = `Claude ${CONTEXT_TARGET.claude / 1000}k / Codex ${CONTEXT_TARGET.codex / 1000}k / OpenCode ${CONTEXT_TARGET.opencode / 1000}k`;

/** Maximum share of turns or spend allowed above the provider context target. */
export const MAX_OVER_TARGET_SHARE = 0.1;
