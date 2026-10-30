import { parse as parseToml } from "smol-toml";
import { int0 } from "./format";
import { CONTEXT_TARGET, MEMORY_INDEX_LINES, SUBAGENT_CAP, SUBAGENT_DEPTH, TOOL_CONCURRENCY, SUBAGENT_ENV, CODEX_SUBAGENT_KEY } from "./flags";
import type { ConfigInput, ConfigNote, ProviderId } from "../model";
import { kindOf } from "../providers";

/** A numeric note where lower is better: unset or over the limit warns. burn.py:410 */
function atMost(
  agent: ProviderId,
  label: string,
  key: string,
  value: number | null,
  source: string | null,
  limit: number,
): ConfigNote {
  let shown: string;
  let line: string;
  if (value === null) {
    shown = "unset";
    line = `${key} is unset: set it to at most ${limit}.`;
  } else {
    shown = String(value);
    line =
      value > limit
        ? `${key} is ${value} (from ${source}): too high. Use ${limit}.`
        : `${key} is ${value} (from ${source}): ok.`;
  }
  const ok = value !== null && value <= limit;
  return {
    name: label,
    source: agent,
    value: shown,
    target: `at most ${limit}`,
    ok,
    level: ok ? "ok" : "warn",
    ratio: value ? value / limit : null,
    line,
  };
}

/** A string note: unset warns, set is ok. `want` is the advice when unset. burn.py:424 */
function isSet(
  agent: ProviderId,
  label: string,
  key: string,
  value: string | null,
  source: string | null,
  want: string,
): ConfigNote {
  const ok = Boolean(value);
  const line = ok
    ? `${key} is ${value} (from ${source}): ok.`
    : `${key} is unset: ${want}`;
  return {
    name: label,
    source: agent,
    value: value || "unset",
    target: "pinned",
    ok,
    level: ok ? "ok" : "warn",
    ratio: null,
    line,
  };
}

/** The auto-compact window in tokens, and the source that set it. burn.py:335 */
export function compactWindow(
  config: ConfigInput,
): [number | null, string | null] {
  const savedEnv = (settings(config)?.env as Record<string, unknown> | undefined)?.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const env = config.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || (savedEnv == null ? undefined : String(savedEnv));
  if (env) {
    const text = env.trim().toLowerCase();
    const scale: Record<string, number> = { k: 1_000, m: 1_000_000 };
    const unit = text.slice(-1);
    const factor = scale[unit] ?? 1;
    const parsed = Number.parseFloat(text.replace(/[km]+$/, ""));
    if (!Number.isFinite(parsed)) return [null, `env (unparsed: ${env})`];
    const value = parsed * factor;
    return [Math.trunc(value >= 1000 ? value : value * 1000), config.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ? "env" : "settings.env"];
  }
  const value = settings(config)?.autoCompactWindow;
  return typeof value === "number" && Number.isFinite(value) ? [Math.trunc(value), "settings"] : [null, null];
}

/** An integer env setting from settings.json .env (which wins) or the process env. burn.py:354 */
export function claudeEnvInt(
  config: ConfigInput,
  key: string,
): [number | null, string | null] {
  const raw = (settings(config)?.env as Record<string, unknown> | undefined)?.[key];
  let value: unknown = raw;
  let source = "settings";
  if (value === undefined || value === null) {
    value = config.env[key];
    source = "env";
  }
  if (value === undefined || value === null) return [null, null];
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return [null, `${source} (unparsed: ${String(value)})`];
  return [Math.trunc(parsed), source];
}

/** A string env setting from settings.json .env or the process env. burn.py:373 */
export function claudeEnvStr(config: ConfigInput, key: string): [string | null, string | null] {
  const raw = (settings(config)?.env as Record<string, unknown> | undefined)?.[key];
  if (raw === undefined || raw === null) return [config.env[key] ?? null, "env"];
  return [String(raw), "settings"];
}

/** The concurrent-subagent cap and the source that set it. burn.py:385 */
export function claudeSubagentCap(config: ConfigInput): [number | null, string | null] {
  return claudeEnvInt(config, SUBAGENT_ENV);
}

/** A value (string) from Codex config.toml, under [table] or as a dotted key. burn.py:390 */
export function codexValue(config: ConfigInput, key: string): string | null {
  if (config.codexConfig === null) return null;
  try {
    const data = parseToml(config.codexConfig);
    const scope = key === "model_auto_compact_token_limit" ? data : data.agents;
    if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return null;
    const value = (scope as Record<string, unknown>)[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : null;
  } catch {
    return null;
  }
}

/** Codex's [agents] max_concurrent_threads_per_session. burn.py:401 */
export function codexSubagentCap(config: ConfigInput): [number | null, string | null] {
  const value = codexValue(config, CODEX_SUBAGENT_KEY);
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? [parsed, "config.toml"] : [null, null];
}

/** Recommended settings, one per agent, judged from actual config. burn.py:434 */
export function configNotes(live: ProviderId[], config: ConfigInput): ConfigNote[] {
  const notes: ConfigNote[] = [];
  for (const agent of live.filter((id) => kindOf(id) === "claude")) {
    const scoped = config.claudeInstalls?.[agent];
    const current = scoped
      ? { ...config, claudeBase: scoped.base, claudeHome: scoped.home, settings: scoped.settings, memoryIndexes: scoped.memoryIndexes }
      : config;
    const [window, wsource] = compactWindow(current);
    const within = window === CONTEXT_TARGET.claude;
    let line: string;
    if (window === null) {
      line =
        `autoCompactWindow is unset: compaction waits for the model window (about 1M on 1M models). Set "autoCompactWindow": ${CONTEXT_TARGET.claude}.`;
    } else if (!within) {
      line = `autoCompactWindow is ${int0(window / 1000)}k (from ${wsource}): use ${int0(CONTEXT_TARGET.claude / 1000)}k.`;
    } else {
      line = `autoCompactWindow is ${int0(window / 1000)}k (from ${wsource}): ok.`;
    }
    notes.push({
      name: "autoCompactWindow",
      source: agent,
      value: window ? `${int0(window / 1000)}k` : "unset (model max)",
      target: `${int0(CONTEXT_TARGET.claude / 1000)}k`,
      ok: within,
      level: within ? "ok" : "warn",
      ratio: window ? window / CONTEXT_TARGET.claude : null,
      line,
    });
    const [cap, csrc] = claudeSubagentCap(current);
    notes.push(atMost(agent, "Max concurrent subagents", SUBAGENT_ENV, cap, csrc, SUBAGENT_CAP));
    const [depth, dsrc] = claudeEnvInt(current, "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH");
    notes.push(
      atMost(agent, "Subagent spawn depth", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", depth, dsrc, SUBAGENT_DEPTH),
    );
    const [model, msrc] = claudeEnvStr(current, "CLAUDE_CODE_SUBAGENT_MODEL");
    notes.push(
      isSet(
        agent,
        "Subagent model",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        model,
        msrc,
        "subagents inherit the main model; pin a cheap worker (e.g. CLAUDE_CODE_SUBAGENT_MODEL=sonnet).",
      ),
    );
    const [tools, tsrc] = claudeEnvInt(current, "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY");
    notes.push(
      atMost(agent, "Tool-call concurrency", "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY", tools, tsrc, TOOL_CONCURRENCY),
    );
  }
  if (live.some((id) => kindOf(id) === "codex")) {
    const [cap, csrc] = codexSubagentCap(config);
    notes.push(
      atMost("codex", "Max concurrent subagents", `agents.${CODEX_SUBAGENT_KEY}`, cap, csrc, SUBAGENT_CAP),
    );
    const depth = codexValue(config, "max_depth");
    notes.push(
      atMost(
        "codex",
        "Agent nesting depth",
        "agents.max_depth",
        depth && /^\d+$/.test(depth) ? Number.parseInt(depth, 10) : null,
        "config.toml",
        SUBAGENT_DEPTH,
      ),
    );
    const effort = codexValue(config, "default_subagent_reasoning_effort");
    const effortOk = effort === "low" || effort === "medium" || effort === "minimal" || effort === "none";
    notes.push({
      name: "Subagent reasoning effort",
      source: "codex",
      value: effort || "unset",
      target: "low or medium",
      ok: effortOk,
      level: effortOk ? "ok" : "warn",
      ratio: null,
      line: effortOk
        ? `agents.default_subagent_reasoning_effort is ${effort}: ok.`
        : `agents.default_subagent_reasoning_effort is ${effort || "unset"}: set it to low or medium so workers don't inherit a costly effort.`,
    });
    const compact = codexValue(config, "model_auto_compact_token_limit");
    const compactOk = compact !== null && /^\d+$/.test(compact) && Number.parseInt(compact, 10) === CONTEXT_TARGET.codex;
    notes.push({
      name: "Auto-compact token limit",
      source: "codex",
      value: compact || "unset",
      target: `${int0(CONTEXT_TARGET.codex / 1000)}k`,
      ok: compactOk,
      level: compactOk ? "ok" : "warn",
      ratio: null,
      line: compactOk
        ? `model_auto_compact_token_limit is ${compact}: ok.`
        : `model_auto_compact_token_limit is ${compact || "unset"}: set ${CONTEXT_TARGET.codex}.`,
    });
  }
  return notes;
}

/** The config check sentences. burn.py:498 */
export function configChecks(live: ProviderId[], config: ConfigInput): string[] {
  const lines = configNotes(live, config).map((note) => note.source.startsWith("claude:")
    ? `${note.source} (${config.claudeInstalls?.[note.source]?.base}/settings.json): ${note.line}`
    : note.line);
  for (const agent of live.filter((id) => kindOf(id) === "claude")) {
    const scoped = config.claudeInstalls?.[agent];
    const current = scoped
      ? { ...config, claudeBase: scoped.base, claudeHome: scoped.home, settings: scoped.settings, memoryIndexes: scoped.memoryIndexes }
      : config;
    for (const index of current.memoryIndexes) {
      const shown =
        current.claudeBase === current.claudeHome
          ? index.path.replace(current.claudeBase, "~/.claude")
          : index.path;
      if (index.lines > MEMORY_INDEX_LINES) {
        lines.push(
          `${shown} has ${index.lines} lines: lines after ${MEMORY_INDEX_LINES} are not loaded, so those memories are invisible. Shorten it.`,
        );
      }
    }
  }
  return lines.length ? lines : ["none"];
}

/** The parsed settings.json object, or an empty object for a missing or broken file. */
function settings(config: ConfigInput): Record<string, any> | undefined {
  if (config.settings === null) return undefined;
  try {
    const parsed = JSON.parse(config.settings);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}
