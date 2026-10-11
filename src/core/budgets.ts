import type { Source } from "./model";
import { PROVIDERS } from "./providers";

export const BUDGET_MODES = ["off", "auto", "manual"] as const;
export type BudgetMode = (typeof BUDGET_MODES)[number];

export const BUDGET_UNITS = ["percentage-per-hour", "tokens-per-hour", "tokens-total"] as const;
export type BudgetUnit = (typeof BUDGET_UNITS)[number];

export type BudgetScope =
  | { kind: "source"; source: Source }
  | { kind: "provider"; provider: string }
  | { kind: "model"; provider: string; model: string };

export interface BudgetPolicy {
  scope: BudgetScope;
  mode: BudgetMode;
  unit: BudgetUnit;
  /** Positive pace or cumulative allowance. Auto policies derive this from their meter. */
  limit: number | null;
  /** A cumulative policy stops admitting work after this instant. */
  deadline: string | null;
}

export interface BudgetMeter {
  id: string;
  source: Source;
  provider: string | null;
  account: string | null;
  usedPercentagePoints: number;
  resetAt: Date;
  observedAt: Date;
  authoritative: boolean;
}

export interface BudgetIdentity {
  source: Source;
  provider: string | null;
  account?: string | null;
  model?: string | null;
}

export interface PolicyValidation {
  policy?: BudgetPolicy;
  error?: string;
}

export const BUDGET_STALE_MS = 5 * 60_000;

/** Stable lower-case identity used for policy selectors and durable keys. */
export function canonicalIdentity(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text || null;
}

export function policyKey(scope: BudgetScope): string {
  if (scope.kind === "source") return `source:${scope.source}`;
  if (scope.kind === "provider") return `provider:${canonicalIdentity(scope.provider) ?? ""}`;
  return `model:${canonicalIdentity(scope.provider) ?? ""}/${canonicalIdentity(scope.model) ?? ""}`;
}

/** Auto pacing is a fraction of the complete quota, not of the remaining balance. */
export function autoPace(meter: BudgetMeter, now: Date = new Date()): number | null {
  const used = meter.usedPercentagePoints;
  const reset = meter.resetAt.getTime();
  const observed = meter.observedAt.getTime();
  const at = now.getTime();
  if (!meter.authoritative || !Number.isFinite(used) || used < 0 || used > 100) return null;
  if (!Number.isFinite(reset) || reset <= at) return null;
  if (!Number.isFinite(observed) || observed > at || at - observed > BUDGET_STALE_MS) return null;
  const hoursUntilReset = (reset - at) / 3_600_000;
  return Math.max(0, 100 - used) / hoursUntilReset;
}

export function autoAllowance(meter: BudgetMeter, now: Date = new Date(), hours = 1): number | null {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const pace = autoPace(meter, now);
  return pace === null ? null : pace * hours;
}

export function validateBudgetPolicy(input: BudgetPolicy, now: Date = new Date()): PolicyValidation {
  if (!input || typeof input !== "object") return { error: "Budget policy must be an object." };
  if (!BUDGET_MODES.includes(input.mode)) return { error: "Budget mode must be Off, Auto, or Manual." };
  if (!BUDGET_UNITS.includes(input.unit)) return { error: "Budget unit is unsupported." };
  if (!input.scope || typeof input.scope !== "object" || !["source", "provider", "model"].includes(input.scope.kind)) {
    return { error: "Budget scope is unsupported." };
  }
  if (input.scope.kind === "source" && !Object.hasOwn(PROVIDERS, input.scope.source)) {
    return { error: "Budget source is unsupported." };
  }
  if (input.scope.kind === "provider" && !canonicalIdentity(input.scope.provider)) {
    return { error: "Provider scope requires a provider id." };
  }
  if (input.scope.kind === "model" && (!canonicalIdentity(input.scope.provider) || !canonicalIdentity(input.scope.model))) {
    return { error: "Model scope requires a provider and model id." };
  }
  if (input.mode !== "off") {
    if (input.mode === "manual" && (!Number.isFinite(input.limit) || (input.limit ?? 0) <= 0)) {
      return { error: "Manual budget limit must be positive." };
    }
    if (input.mode === "auto" && input.limit !== null && (!Number.isFinite(input.limit) || input.limit < 0)) {
      return { error: "Auto budget limit must be empty or non-negative." };
    }
  }
  if (input.deadline !== null) {
    const deadline = Date.parse(input.deadline);
    if (!Number.isFinite(deadline) || deadline <= now.getTime()) return { error: "Budget deadline must be in the future." };
  }
  if (input.unit === "tokens-total" && input.mode !== "off" && !input.deadline) {
    return { error: "A cumulative token allowance requires a deadline." };
  }
  return { policy: {
    scope: input.scope.kind === "source"
      ? input.scope
      : input.scope.kind === "provider"
        ? { kind: "provider", provider: canonicalIdentity(input.scope.provider)! }
        : { kind: "model", provider: canonicalIdentity(input.scope.provider)!, model: canonicalIdentity(input.scope.model)! },
    mode: input.mode,
    unit: input.unit,
    limit: input.mode === "off" ? null : input.limit,
    deadline: input.deadline,
  } };
}

export function policyMatches(policy: BudgetPolicy, identity: BudgetIdentity): boolean {
  if (policy.scope.kind === "source") return policy.scope.source === identity.source;
  if (policy.scope.kind === "provider") return canonicalIdentity(identity.provider) === canonicalIdentity(policy.scope.provider);
  return canonicalIdentity(identity.provider) === canonicalIdentity(policy.scope.provider) &&
    canonicalIdentity(identity.model) === canonicalIdentity(policy.scope.model);
}

export function policyUnitForMeter(policy: BudgetPolicy, meter: BudgetMeter | null): BudgetUnit | null {
  if (policy.mode === "off") return null;
  if (policy.mode === "auto") return meter?.authoritative ? "percentage-per-hour" : null;
  return policy.unit;
}
