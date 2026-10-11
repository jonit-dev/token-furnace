import type { App } from "../compose";
import { BUDGET_STALE_MS, type BudgetMeter } from "../core/budgets";
import type { Source, Week } from "../core/model";
import { codexRateLimits } from "./codex-rate-limits";
import { claudeAccount, openCodeCredential, openCodeWindows, planWindows, withId, type QuotaWindow } from "./usage-client";

export interface MeterRefreshOptions {
  /** Refresh only these sources' providers. */
  only?: Source[];
  /** Keep the quota caches even when the app was composed with --no-cache (hook processes are short lived). */
  persist?: boolean;
}

function toMeter(source: Source, provider: string, window: QuotaWindow): BudgetMeter {
  return {
    id: window.id, source, provider, account: window.account ?? null, usedPercentagePoints: window.used,
    resetAt: window.resets, observedAt: validObservedAt(window.observedAt), authoritative: window.authoritative ?? true, window: window.window,
  };
}

function validObservedAt(value: Date | undefined): Date {
  return value && Number.isFinite(value.getTime()) ? value : new Date(0);
}

/**
 * Every window each provider supplies becomes its own meter, replacing that provider's previous set.
 * Codex prefers a fresh authoritative app-server reading once the transcript-derived one is stale.
 */
export async function refreshBudgetMeters(app: App, network: boolean, options: MeterRefreshOptions = {}): Promise<void> {
  const now = app.now();
  const env = options.persist ? { ...app.env, TOKEN_FURNACE_NO_CACHE: process.env.TOKEN_FURNACE_NO_CACHE ?? "0" } : app.env;
  const wants = (source: Source): boolean => !options.only || options.only.includes(source);
  const [plan, codex, open] = await Promise.all([
    wants("claude") ? planWindows(env, now, network) : [],
    wants("codex") ? codexWindows(app, env, now, network) : [],
    wants("opencode") ? openCodeWindows(env, now, network) : [],
  ]);
  const meters = [
    ...plan.map((window) => toMeter("claude", "anthropic", window)),
    ...codex.map((window) => toMeter("codex", "openai", window)),
    ...open.map((window) => toMeter("opencode", "opencode-go", window)),
  ];
  if (meters.length) app.budgets.setMeters(meters);
}

async function codexWindows(app: App, env: App["env"], now: Date, network: boolean): Promise<QuotaWindow[]> {
  const adapter = app.sources.find((source) => source.name === "codex");
  const transcript: Week | null = adapter?.weekReading?.(now) ?? adapter?.week?.(now) ?? null;
  const observed = transcript?.observedAt?.getTime();
  const fresh = transcript && observed !== undefined && Number.isFinite(observed) && now.getTime() - observed <= BUDGET_STALE_MS;
  if (!fresh) {
    const live = await codexRateLimits(env, now, network);
    if (live) return live.windows;
  }
  const legacy = withId("openai:weekly", transcript);
  return legacy ? [legacy] : [];
}

const NON_ADMISSION_EVENTS = new Set(["PostToolUse", "Stop", "SubagentStop", "SessionEnd"]);
const NON_ADMISSION_PHASES = new Set(["complete", "completed", "reconcile", "cancel", "cancelled", "abandon", "abandoned"]);

/**
 * Hook path without a server: before an admission decision, refresh a stale applicable quota meter once.
 * The budget store throttles attempts to one a minute across all hook processes, and the clients keep
 * their own 5-minute reuse, so a hook never calls the network on every run. Never throws.
 */
export async function refreshHookMeters(app: App, stdin: string, sourceOverride?: Source): Promise<void> {
  try {
    let event: Record<string, unknown> = {};
    try { event = JSON.parse(stdin) as Record<string, unknown>; } catch { return; }
    if (!event || typeof event !== "object") return;
    const hookEvent = String(event.hook_event_name ?? event.hookEventName ?? event.eventName ?? "");
    const phase = String(event.phase ?? event.lifecycle ?? "");
    if (NON_ADMISSION_EVENTS.has(hookEvent) || NON_ADMISSION_PHASES.has(phase)) return;
    const named = String(event.source ?? app.env.TOKEN_FURNACE_SOURCE ?? "");
    const source = sourceOverride ?? (named === "claude" || named === "codex" || named === "opencode" ? named : undefined);
    if (!source || !app.budgets.claimMeterRefresh(source)) return;
    await refreshBudgetMeters(app, true, { only: [source], persist: true });
  } catch { /* a failed refresh leaves the meter stale, and a stale meter denies */ }
}

/**
 * The account this machine's own credentials identify for a provider, so a hook matches the meter it
 * belongs to without guessing. Null when the hook cannot derive it (Codex): the meter rule applies then.
 */
export function localQuotaAccount(env: App["env"], source: Source, provider: string | null): string | null {
  if (source === "claude" && provider === "anthropic") return claudeAccount(env);
  if (source === "opencode" && provider === "opencode-go") return openCodeCredential(env)?.account ?? null;
  return null;
}
