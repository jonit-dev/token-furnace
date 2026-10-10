import { CONTEXT_TARGET } from "./context";
import { SUBAGENT_CAP, SUBAGENT_DEPTH, TOOL_CONCURRENCY } from "./analyze/flags";

const depthNote = "Some versions may reject this setting or block spawning. Codex Multi-Agent V2 ignores it.";
export const CONFIG_REPAIRS = [
  { id: "claude-context", provider: "claude", label: `Context limit: ${CONTEXT_TARGET.claude.toLocaleString("en-US")} tokens`, detail: "Update autoCompactWindow and its saved environment override, if present." },
  { id: "claude-workers", provider: "claude", label: `Concurrent subagents: at most ${SUBAGENT_CAP}`, detail: "Preserve an existing lower limit." },
  { id: "claude-tools", provider: "claude", label: `Parallel tool calls: at most ${TOOL_CONCURRENCY}`, detail: "Preserve an existing lower limit." },
  { id: "claude-model", provider: "claude", label: "Worker model: Sonnet if unset", detail: "Preserve an existing pinned model." },
  { id: "claude-depth", provider: "claude", label: `Subagent nesting depth: at most ${SUBAGENT_DEPTH}`, detail: depthNote },
  { id: "codex-context", provider: "codex", label: `Context limit: ${CONTEXT_TARGET.codex.toLocaleString("en-US")} tokens`, detail: "Update model_auto_compact_token_limit." },
  { id: "codex-workers", provider: "codex", label: `Concurrent subagents: at most ${SUBAGENT_CAP}`, detail: "Preserve an existing lower limit." },
  { id: "codex-effort", provider: "codex", label: "Worker reasoning: medium or lower", detail: "Preserve an existing lower reasoning effort." },
  { id: "codex-depth", provider: "codex", label: `Agent nesting depth: at most ${SUBAGENT_DEPTH}`, detail: depthNote },
] as const;
export type ConfigRepairId = typeof CONFIG_REPAIRS[number]["id"];
