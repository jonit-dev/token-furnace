import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  autoPace,
  BUDGET_STALE_MS,
  meterWindowMs,
  canonicalIdentity,
  policyKey,
  policyMatches,
  validateBudgetPolicy,
  type BudgetIdentity,
  type BudgetMeter,
  type BudgetPolicy,
  type BudgetScope,
} from "../core/budgets";
import type { Source } from "../core/model";
import type { Env } from "../sources/agent-source";
import { writePrivateFile } from "./private-file";

export type StopScope = BudgetScope;

export interface BudgetSourceDescriptor {
  source: Source;
  label: string;
  installed: boolean;
  models?: string[];
  /** Verified provider/model identities (registered native targets, OpenCode provider/model records). */
  modelScopes?: Array<{ provider: string; model: string }>;
  /** Only identities observed from native telemetry or authoritative meters. */
  providers?: string[];
}

export interface BudgetSourceStatus extends BudgetSourceDescriptor {
  policy: BudgetPolicy | null;
  meter: BudgetMeter | null;
  /** Every meter the provider supplies for this source; the most restrictive window decides. */
  meters: BudgetMeter[];
  /** Auto converts weighted tokens to quota points with a ratio measured in the meter's window. */
  calibration: { estimated: true; meterId: string; percentagePointsPerMillionTokens: number | null } | null;
  pace: number | null;
  allowance: number | null;
  blockedWork: number;
  coverage: "Watching" | "Partial coverage" | "Enforcing";
  status: "Watching" | "Enforcing" | "Budget blocked" | "Emergency stopped" | "Usage unavailable" | "Partial coverage";
}

export interface BudgetSnapshot {
  revision: number;
  policies: BudgetPolicy[];
  sources: BudgetSourceStatus[];
  stops: Array<{ scope: StopScope; operationId: string; createdAt: string }>;
  error: string | null;
}

export interface AdmissionRequest {
  identity: BudgetIdentity;
  estimatedCost?: number;
  /** Auto meters are percentage points; manual policies use their configured unit. */
  costUnit?: BudgetPolicy["unit"];
  requestId?: string;
  /** Qualification-only correlation; never participates in admission idempotency. */
  correlationId?: string;
  /** Native session owning this request, distinct from per-call requestId. */
  sessionId?: string;
  now?: Date;
}

/** "tokens" is a native token observation; it can never satisfy a percentage reservation. */
export type ActualUsageUnit = "reservation" | "tokens" | BudgetPolicy["unit"];

export interface AdmissionDecision {
  allowed: boolean;
  reason: string;
  retryAt: string | null;
  reservationId: string | null;
  matched: string[];
}

export interface StopTargetOutcome {
  targetId: string;
  status: "requested" | "cancelled" | "terminated" | "unresolved" | "failed";
  detail?: string;
}

export interface StopPreview {
  id: string;
  fingerprint: string;
  scope: StopScope;
  targetIds: string[];
  targetProof?: string;
  revision: number;
  expiresAt: string;
}

export interface StopOperation {
  id: string;
  scope: StopScope;
  status: "complete" | "partial";
  outcomes: StopTargetOutcome[];
  createdAt: string;
  settingsError?: string;
}

interface StoredSettings {
  version: 1;
  revision: number;
  policies: BudgetPolicy[];
  latches?: Array<{ scope: StopScope; operationId: string; createdAt: number }>;
}

interface StoredMeter {
  id: string;
  source: Source;
  provider: string | null;
  account: string | null;
  used_percentage: number;
  reset_at: number;
  observed_at: number;
  authoritative: number;
  window: string | null;
}

const DEFAULT_SOURCES: BudgetSourceDescriptor[] = [
  { source: "claude", label: "Claude Code", installed: false },
  { source: "codex", label: "Codex", installed: false },
  { source: "opencode", label: "OpenCode", installed: false },
];

const DDL = `
PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS meters (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  provider TEXT,
  account TEXT,
  used_percentage REAL NOT NULL,
  reset_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  authoritative INTEGER NOT NULL,
  window TEXT
);
CREATE TABLE IF NOT EXISTS meter_refreshes (
  source TEXT PRIMARY KEY,
  tried_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_events (
  event_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_scope_at ON usage_events(scope_key, at);
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  correlation_id TEXT,
  session_id TEXT,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (reservation_id, scope_key)
);
CREATE INDEX IF NOT EXISTS reservation_scope_status ON reservations(scope_key, status);
CREATE TABLE IF NOT EXISTS admission_decisions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  provider TEXT,
  account TEXT,
  model TEXT,
  request_id TEXT,
  correlation_id TEXT,
  session_id TEXT,
  allowed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_windows (
  scope_key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stops (
  scope_key TEXT PRIMARY KEY,
  scope_json TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  unlocked_at INTEGER
);
CREATE TABLE IF NOT EXISTS stop_previews (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  target_ids_json TEXT NOT NULL,
  target_proof TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL,
  outcomes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export class BudgetService {
  readonly settingsPath: string;
  readonly dbPath: string;
  private readonly now: () => Date;
  private readonly db: DatabaseSync;
  private settingsError: string | null = null;

  constructor(env: Env = process.env, options: { now?: () => Date; dbPath?: string; settingsPath?: string } = {}) {
    this.now = options.now ?? (() => new Date());
    const home = env.HOME || homedir();
    const config = env.TOKEN_FURNACE_CONFIG_HOME || env.XDG_CONFIG_HOME || join(home, ".config");
    const state = env.TOKEN_FURNACE_STATE_HOME || env.XDG_STATE_HOME || join(home, ".local", "state");
    this.settingsPath = options.settingsPath ?? join(config, "token-furnace", "budgets.json");
    this.dbPath = options.dbPath ?? join(state, "token-furnace", "budgets.sqlite");
    mkdirSync(dirname(this.settingsPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA busy_timeout = 2500;");
    retrySqliteInitialization(() => {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      this.db.exec(DDL);
      addSqliteColumn(this.db, "ALTER TABLE meters ADD COLUMN window TEXT");
      addSqliteColumn(this.db, "ALTER TABLE reservations ADD COLUMN request_id TEXT");
      addSqliteColumn(this.db, "ALTER TABLE reservations ADD COLUMN correlation_id TEXT");
      addSqliteColumn(this.db, "ALTER TABLE reservations ADD COLUMN session_id TEXT");
      addSqliteColumn(this.db, "ALTER TABLE reservations ADD COLUMN source TEXT NOT NULL DEFAULT ''");
      addSqliteColumn(this.db, "ALTER TABLE stop_previews ADD COLUMN target_proof TEXT NOT NULL DEFAULT ''");
      for (const column of ["provider TEXT", "account TEXT", "model TEXT", "request_id TEXT", "correlation_id TEXT", "session_id TEXT"]) {
        addSqliteColumn(this.db, `ALTER TABLE admission_decisions ADD COLUMN ${column}`);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS reservation_request_status ON reservations(request_id, status)");
      this.db.exec("CREATE INDEX IF NOT EXISTS reservation_session_status ON reservations(session_id, status)");
      this.db.exec("CREATE INDEX IF NOT EXISTS reservation_source_session_status ON reservations(source, session_id, status)");
      this.db.exec("CREATE INDEX IF NOT EXISTS admission_correlation_at ON admission_decisions(correlation_id, at)");
    });
    try { chmodSync(this.dbPath, 0o600); } catch { /* best effort on Windows */ }
  }

  private closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  settings(): StoredSettings {
    return this.readSettings().settings;
  }

  savePolicies(policies: BudgetPolicy[], expectedRevision: number): StoredSettings {
    const now = this.now();
    const normalized: BudgetPolicy[] = [];
    const keys = new Set<string>();
    for (const policy of policies) {
      const result = validateBudgetPolicy(policy, now);
      if (result.error || !result.policy) throw new Error(result.error ?? "Invalid budget policy.");
      const key = policyKey(result.policy.scope);
      if (keys.has(key)) throw new Error(`Duplicate budget policy: ${key}`);
      keys.add(key);
      normalized.push(result.policy);
    }
    return this.writeTransaction(() => {
      const current = this.readSettings();
      if (current.error) throw new Error(current.error);
      if (current.settings.revision !== expectedRevision) throw new Error("Budget settings revision is stale.");
      const next: StoredSettings = { version: 1, revision: expectedRevision + 1, policies: normalized, latches: current.settings.latches ?? [] };
      this.writeSettings(next);
      const at = now.getTime();
      for (const policy of normalized) {
        this.db.prepare("INSERT OR IGNORE INTO policy_windows (scope_key, started_at) VALUES (?, ?)").run(policyKey(policy.scope), at);
      }
      return next;
    });
  }

  setMeters(meters: BudgetMeter[]): void {
    this.writeTransaction(() => {
      const statement = this.db.prepare(`INSERT INTO meters
        (id, source, provider, account, used_percentage, reset_at, observed_at, authoritative, window)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET source=excluded.source, provider=excluded.provider,
        account=excluded.account, used_percentage=excluded.used_percentage, reset_at=excluded.reset_at,
        observed_at=excluded.observed_at, authoritative=excluded.authoritative, window=excluded.window`);
      for (const meter of meters) {
        statement.run(meter.id, meter.source, canonicalIdentity(meter.provider), canonicalIdentity(meter.account),
          meter.usedPercentagePoints, meter.resetAt.getTime(), meter.observedAt.getTime(), meter.authoritative ? 1 : 0, meter.window ?? null);
      }
      // A provider's windows are replaced as a set: a window it stopped supplying must not linger and go stale.
      const keep = new Set(meters.map((meter) => meter.id));
      const providers = new Set(meters.map((meter) => `${meter.source}\0${canonicalIdentity(meter.provider) ?? ""}`));
      for (const row of this.meters()) {
        if (providers.has(`${row.source}\0${canonicalIdentity(row.provider) ?? ""}`) && !keep.has(row.id)) {
          this.db.prepare("DELETE FROM meters WHERE id = ?").run(row.id);
        }
      }
    });
  }

  observedProviders(): Map<Source, string[]> {
    const result = new Map<Source, string[]>();
    for (const meter of this.meters()) {
      if (!meter.provider) continue;
      const values = result.get(meter.source) ?? [];
      if (!values.includes(meter.provider)) values.push(meter.provider);
      result.set(meter.source, values.sort());
    }
    return result;
  }

  /**
   * Resolve an account only from authoritative meter identities; never infer it from a model label.
   * A candidate the hook derived itself (credentials, transcript) must equal a meter's account. Without
   * a candidate (Codex, whose account is only known to its app-server), the account is the one distinct
   * account across this machine's authoritative meters for that provider, and none when there are several.
   * Freshness is judged by admit, so a stale meter reads "stale" and not "unresolved".
   */
  verifiedAccount(source: Source, provider: string | null, candidate?: string | null): string | null {
    const matches = this.meters().filter((meter) => meter.source === source && canonicalIdentity(meter.provider) === canonicalIdentity(provider) && meter.authoritative && meter.account);
    if (candidate) return matches.some((meter) => canonicalIdentity(meter.account) === canonicalIdentity(candidate)) ? canonicalIdentity(candidate) : null;
    const accounts = [...new Set(matches.map((meter) => canonicalIdentity(meter.account)).filter((account): account is string => Boolean(account)))];
    return accounts.length === 1 ? accounts[0] : null;
  }

  snapshot(sources: BudgetSourceDescriptor[] = DEFAULT_SOURCES): BudgetSnapshot {
    const loaded = this.readSettings();
    const meters = this.meters();
    const stops = this.activeStops();
    const now = this.now();
    return {
      revision: loaded.settings.revision,
      policies: loaded.settings.policies,
      error: loaded.error,
      stops: stops.map((stop) => ({ scope: stop.scope, operationId: stop.operationId, createdAt: new Date(stop.createdAt).toISOString() })),
      sources: sources.map((source) => {
        const policy = loaded.settings.policies.find((candidate) => candidate.scope.kind === "source" && candidate.scope.source === source.source) ?? null;
        const sourceMeters = meters.filter((candidate) => candidate.source === source.source);
        const paced = sourceMeters.map((candidate) => ({ candidate, pace: meterIsAdmissible(candidate, now) ? autoPace(candidate, now) : null }));
        // One unavailable window leaves the most restrictive one unknown, so the whole source is unavailable.
        const tightest = paced.length && paced.every((entry) => entry.pace !== null)
          ? paced.reduce((best, entry) => (entry.pace! < best.pace! ? entry : best))
          : null;
        const meter = tightest?.candidate ?? sourceMeters[0] ?? null;
        const active = stops.some((stop) => stop.scope.kind === "source" && stop.scope.source === source.source);
        const pace = policy?.mode === "auto" ? tightest?.pace ?? null : policy?.mode === "manual" ? policy.limit : null;
        const allowance = pace;
        const ratio = policy?.mode === "auto" && tightest ? this.calibrationRatio(tightest.candidate, policyKey(policy.scope), now) : null;
        const blockedWork = this.blockedCount(source.source, policy, now);
        const status: BudgetSourceStatus["status"] = active
          ? "Emergency stopped"
          : policy?.mode === "off" || !policy
            ? "Watching"
            : policy.mode === "auto" && pace === null
              ? "Usage unavailable"
              : blockedWork > 0
                ? "Budget blocked"
                : "Partial coverage";
        return {
          ...source,
          policy,
          meter,
          meters: sourceMeters,
          calibration: policy?.mode === "auto" && meter ? { estimated: true, meterId: meter.id, percentagePointsPerMillionTokens: ratio === null ? null : ratio * 1e6 } : null,
          pace,
          allowance,
          blockedWork,
          coverage: policy?.mode && policy.mode !== "off" ? "Partial coverage" : "Watching",
          status,
          models: source.models ?? [],
          providers: source.providers ?? [],
        };
      }),
    };
  }

  recordUsage(input: { scope: BudgetScope; amount: number; unit?: BudgetPolicy["unit"]; eventId: string; at?: Date }): boolean {
    if (!Number.isFinite(input.amount) || input.amount < 0 || !input.eventId) return false;
    return this.writeTransaction(() => {
      const result = this.db.prepare("INSERT OR IGNORE INTO usage_events (event_id, scope_key, amount, unit, at) VALUES (?, ?, ?, ?, ?)")
        .run(input.eventId, policyKey(input.scope), input.amount, input.unit ?? "tokens-total", (input.at ?? this.now()).getTime());
      return Number(result.changes) > 0;
    });
  }

  seedRecentUsage(events: Array<{ scope: BudgetScope; amount: number; eventId: string; at: Date }>): number {
    let inserted = 0;
    for (const event of events) {
      if (this.recordUsage({ ...event, unit: "tokens-total" })) inserted++;
      if (this.recordUsage({ ...event, unit: "tokens-per-hour", eventId: `${event.eventId}:hour` })) inserted++;
    }
    return inserted;
  }

  admit(input: AdmissionRequest): AdmissionDecision {
    const now = input.now ?? this.now();
    return this.writeTransaction(() => {
      const loaded = this.readSettings();
      const identity = input.identity;
      if (loaded.error) return this.decision(input, false, loaded.error, null, []);
      const stops = this.activeStops();
      const stopped = stops.find((stop) => stopMatches(stop.scope, identity));
      if (stopped) return this.decision(input, false, "Emergency stop is active for this scope.", null, []);
      if (stops.some((stop) => stopRequiresResolvedIdentity(stop.scope, identity))) {
        return this.decision(input, false, "Emergency stop requires resolved provider/model identity.", null, []);
      }
      const enabled = loaded.settings.policies.filter((policy) => policy.mode !== "off");
      const unresolved = enabled.some((policy) =>
        (policy.scope.kind === "provider" && !identity.provider) ||
        (policy.scope.kind === "model" && (!identity.provider || !identity.model)));
      if (unresolved) return this.decision(input, false, "Enabled provider/model budget requires resolved identity.", null, []);
      const policies = enabled.filter((policy) => policyMatches(policy, identity));
      if (!policies.length) return this.decision(input, true, "Budget is Off.", null, []);
      const matched = policies.map((policy) => policyKey(policy.scope));
      if (input.requestId) {
        const existing = this.db.prepare("SELECT reservation_id FROM reservations WHERE source = ? AND request_id = ? AND status = 'reserved' LIMIT 1").get(input.identity.source, input.requestId) as { reservation_id: string } | undefined;
        if (existing) return { allowed: true, reason: "Already admitted.", retryAt: null, reservationId: existing.reservation_id, matched };
      }
      const reservations: Array<{ scopeKey: string; amount: number; unit: string }> = [];
      let retryAt: Date | null = null;
      for (const policy of policies) {
        if (policy.deadline && Date.parse(policy.deadline) <= now.getTime()) {
          return this.decision(input, false, "Budget deadline has expired.", policy.deadline, matched);
        }
        // Quota budgets (Auto, Manual percentage-per-hour) are metered in percentage points but admitted,
        // reserved and reconciled in weighted tokens, converted with a ratio measured in each meter's window.
        const quota = policy.mode === "auto" || policy.unit === "percentage-per-hour";
        const unit = quota ? "tokens-per-hour" : policy.unit;
        const quotaMeters = quota ? this.metersFor(policy, identity) : [];
        if (quota && !identity.account) {
          return this.decision(input, false, "Account identity unresolved: an enabled quota budget needs a verified account.", policy.deadline, matched);
        }
        if (quota && (!quotaMeters.length || !quotaMeters.every((meter) => meterIsAdmissible(meter, now)))) {
          return this.decision(input, false, "Authoritative budget meter is unavailable, stale, or unconfirmed.", policy.deadline, matched);
        }
        const limit = policy.mode === "auto" ? null : policy.limit;
        if (!quota && (limit === null || limit === undefined)) {
          return this.decision(input, false, "Budget meter is unavailable or stale.", policy.deadline, matched);
        }
        const costUnitOk = !input.costUnit || input.costUnit === unit || (quota && input.costUnit === "tokens-total");
        if (!costUnitOk) {
          return this.decision(input, false, `Estimated cost unit does not match ${unit}.`, policy.deadline, matched);
        }
        const estimatedCost = validCost(input.estimatedCost)
          ? Number(input.estimatedCost)
          : this.estimateFor(policy, identity, unit, now);
        if (estimatedCost === null) {
          return this.decision(input, false, "Enabled budget has no attributable recent usage to estimate this request.", policy.deadline, matched);
        }
        const key = policyKey(policy.scope);
        if (quota) {
          const denied = this.quotaDenial(policy, key, quotaMeters, estimatedCost, now);
          if (denied) return this.decision(input, false, denied, policy.deadline ?? new Date(now.getTime() + 3_600_000).toISOString(), matched);
          if (policy.deadline && !retryAt) retryAt = new Date(policy.deadline);
          reservations.push({ scopeKey: key, amount: estimatedCost, unit });
          continue;
        }
        const start = policy.unit === "tokens-total" ? this.policyStartedAt(key) : now.getTime() - 3_600_000;
        const used = Number((this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM usage_events WHERE scope_key = ? AND unit = ? AND at >= ?").get(key, unit, start) as { total: number }).total);
        const reserved = Number((this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM reservations WHERE scope_key = ? AND unit = ? AND status = 'reserved'").get(key, unit) as { total: number }).total);
        if (used + reserved + estimatedCost > limit! + 1e-9) {
          return this.decision(input, false, "Budget allowance is exhausted.", policy.deadline ?? new Date(now.getTime() + 3_600_000).toISOString(), matched);
        }
        if (policy.deadline && !retryAt) retryAt = new Date(policy.deadline);
        reservations.push({ scopeKey: key, amount: estimatedCost, unit });
      }
      const reservationId = randomUUID();
      for (const reservation of reservations) {
        this.db.prepare("INSERT INTO reservations (reservation_id, scope_key, source, request_id, correlation_id, session_id, amount, unit, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')")
          .run(reservationId, reservation.scopeKey, input.identity.source, input.requestId ?? null, input.correlationId ?? null, input.sessionId ?? null, reservation.amount, reservation.unit, now.getTime());
      }
      this.logDecision(input, true, "Admitted.");
      return { allowed: true, reason: "Admitted.", retryAt: retryAt?.toISOString() ?? null, reservationId, matched };
    });
  }

  release(reservationId: string): void {
    this.writeTransaction(() => {
      this.db.prepare("UPDATE reservations SET status = 'released' WHERE reservation_id = ? AND status = 'reserved'").run(reservationId);
    });
  }

  releaseRequest(source: Source, requestId: string): void {
    if (!requestId) return;
    this.writeTransaction(() => {
      this.db.prepare("UPDATE reservations SET status = 'released' WHERE source = ? AND request_id = ? AND status = 'reserved'").run(source, requestId);
    });
  }

  releaseSession(source: Source, sessionId: string): void {
    if (!sessionId) return;
    this.writeTransaction(() => {
      this.db.prepare("UPDATE reservations SET status = 'released' WHERE source = ? AND session_id = ? AND request_id IS NULL AND status = 'reserved'").run(source, sessionId);
    });
  }

  reconcile(reservationId: string, actualAmount: number, eventId = `${reservationId}:usage`, at?: Date, actualUnit: ActualUsageUnit = "reservation", source?: Source): string[] {
    if (!Number.isFinite(actualAmount) || actualAmount < 0) return [];
    return this.writeTransaction(() => {
      return this.reconcileRows([reservationId], actualAmount, eventId, at, actualUnit, source);
    });
  }

  reconcileReservations(source: Source, reservationIds: string[], actualAmount: number, eventId: string, at?: Date, actualUnit: ActualUsageUnit = "reservation"): string[] {
    if (!reservationIds.length || !Number.isFinite(actualAmount) || actualAmount < 0) return [];
    return this.writeTransaction(() => this.reconcileRows([...new Set(reservationIds)], actualAmount, eventId, at, actualUnit, source));
  }

  reconcileRequest(source: Source, requestId: string, actualAmount: number, eventId: string, at?: Date, actualUnit: ActualUsageUnit = "reservation"): string[] {
    if (!requestId || !Number.isFinite(actualAmount) || actualAmount < 0) return [];
    return this.writeTransaction(() => {
      const rows = this.db.prepare("SELECT DISTINCT reservation_id FROM reservations WHERE source = ? AND request_id = ? AND status = 'reserved'").all(source, requestId) as Array<{ reservation_id: string }>;
      return this.reconcileRows(rows.map((row) => row.reservation_id), actualAmount, eventId, at, actualUnit, source);
    });
  }

  reconcileSession(source: Source, sessionId: string, actualAmount: number, eventId: string, at?: Date, actualUnit: ActualUsageUnit = "reservation"): string[] {
    if (!sessionId || !Number.isFinite(actualAmount) || actualAmount < 0) return [];
    return this.writeTransaction(() => {
      const rows = this.db.prepare("SELECT DISTINCT reservation_id FROM reservations WHERE source = ? AND session_id = ? AND request_id IS NULL AND status = 'reserved'").all(source, sessionId) as Array<{ reservation_id: string }>;
      return this.reconcileRows(rows.map((row) => row.reservation_id), actualAmount, eventId, at, actualUnit, source);
    });
  }

  previewStop(scope: StopScope, targetIds: string[] = [], targetProof = ""): StopPreview {
    const normalized = normalizeScope(scope);
    const ids = [...new Set(targetIds.filter((id) => typeof id === "string" && id.length > 0))].sort();
    const fingerprint = fingerprintOf(normalized, ids, targetProof);
    const now = this.now();
    const preview: StopPreview = {
      id: randomUUID(), fingerprint, scope: normalized, targetIds: ids, targetProof,
      revision: this.settings().revision, expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    };
    this.writeTransaction(() => {
      this.db.prepare(`INSERT INTO stop_previews
        (id, fingerprint, scope_json, target_ids_json, target_proof, revision, created_at, expires_at, used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(preview.id, fingerprint, JSON.stringify(normalized), JSON.stringify(ids), targetProof, preview.revision, now.getTime(), Date.parse(preview.expiresAt));
    });
    return preview;
  }

  commitStop(previewId: string, fingerprint: string, outcomes: StopTargetOutcome[]): StopOperation {
    return this.writeTransaction(() => {
      const row = this.db.prepare("SELECT * FROM stop_previews WHERE id = ?").get(previewId) as {
        fingerprint: string; scope_json: string; revision: number; expires_at: number; used: number;
      } | undefined;
      const now = this.now();
      if (!row || row.used || row.fingerprint !== fingerprint || row.expires_at <= now.getTime() || row.revision !== this.settings().revision) {
        throw new Error("Stop preview is stale, expired, or already used.");
      }
      const scope = JSON.parse(row.scope_json) as StopScope;
      const id = randomUUID();
      const status = outcomes.length > 0 && outcomes.every((outcome) => outcome.status === "cancelled" || outcome.status === "terminated") ? "complete" : "partial";
      this.db.prepare("INSERT INTO stops (scope_key, scope_json, operation_id, created_at, active) VALUES (?, ?, ?, ?, 1) ON CONFLICT(scope_key) DO UPDATE SET scope_json=excluded.scope_json, operation_id=excluded.operation_id, created_at=excluded.created_at, active=1, unlocked_at=NULL")
        .run(policyKey(scope), JSON.stringify(scope), id, now.getTime());
      this.db.prepare("INSERT INTO operations (id, scope_json, status, outcomes_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, JSON.stringify(scope), status, JSON.stringify(outcomes), now.getTime());
      // The SQLite stops row is the authoritative latch. A malformed settings file is reported, never overwritten.
      const loaded = this.readSettings();
      if (!loaded.error) {
        const latches = (loaded.settings.latches ?? []).filter((latch) => policyKey(latch.scope) !== policyKey(scope));
        latches.push({ scope, operationId: id, createdAt: now.getTime() });
        this.writeSettings({ ...loaded.settings, latches });
      }
      this.db.prepare("UPDATE stop_previews SET used = 1 WHERE id = ?").run(previewId);
      return { id, scope, status, outcomes, createdAt: now.toISOString(), ...(loaded.error ? { settingsError: loaded.error } : {}) };
    });
  }

  preview(id: string): StopPreview | null {
    if (!id) return null;
    const row = this.db.prepare("SELECT * FROM stop_previews WHERE id = ?").get(id) as {
      id: string; fingerprint: string; scope_json: string; target_ids_json: string; target_proof: string; revision: number; expires_at: number; used: number;
    } | undefined;
    if (!row || row.used || row.expires_at <= this.now().getTime()) return null;
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      scope: JSON.parse(row.scope_json) as StopScope,
      targetIds: JSON.parse(row.target_ids_json) as string[],
      targetProof: row.target_proof,
      revision: row.revision,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  updateOperation(id: string, outcomes: StopTargetOutcome[]): StopOperation | null {
    const status = outcomes.length > 0 && outcomes.every((outcome) => outcome.status === "cancelled" || outcome.status === "terminated") ? "complete" : "partial";
    this.writeTransaction(() => {
      this.db.prepare("UPDATE operations SET status = ?, outcomes_json = ? WHERE id = ?").run(status, JSON.stringify(outcomes), id);
    });
    return this.operation(id);
  }

  operation(id: string): StopOperation | null {
    const row = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as { id: string; scope_json: string; status: "complete" | "partial"; outcomes_json: string; created_at: number } | undefined;
    if (!row) return null;
    return { id: row.id, scope: JSON.parse(row.scope_json) as StopScope, status: row.status, outcomes: JSON.parse(row.outcomes_json) as StopTargetOutcome[], createdAt: new Date(row.created_at).toISOString() };
  }

  /** Returns the settings error when the file is malformed and was left untouched. */
  unlock(scope: StopScope): string | null {
    return this.writeTransaction(() => {
      this.db.prepare("UPDATE stops SET active = 0, unlocked_at = ? WHERE scope_key = ?").run(this.now().getTime(), policyKey(normalizeScope(scope)));
      const loaded = this.readSettings();
      if (loaded.error) return loaded.error;
      this.writeSettings({ ...loaded.settings, latches: (loaded.settings.latches ?? []).filter((latch) => policyKey(latch.scope) !== policyKey(normalizeScope(scope))) });
      return null;
    });
  }

  private decision(input: AdmissionRequest, allowed: boolean, reason: string, retryAt: string | Date | null, matched: string[]): AdmissionDecision {
    this.logDecision(input, allowed, reason);
    return { allowed, reason, retryAt: retryAt instanceof Date ? retryAt.toISOString() : retryAt, reservationId: null, matched };
  }

  private logDecision(input: AdmissionRequest, allowed: boolean, reason: string): void {
    this.db.prepare("INSERT INTO admission_decisions (id, source, provider, account, model, request_id, correlation_id, session_id, allowed, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), input.identity.source, canonicalIdentity(input.identity.provider), canonicalIdentity(input.identity.account), canonicalIdentity(input.identity.model), input.requestId ?? null, input.correlationId ?? null, input.sessionId ?? null, allowed ? 1 : 0, reason, (input.now ?? this.now()).getTime());
  }

  /** Denials inside the same window admission measures usage over: the policy window for totals, else the last hour. */
  private blockedCount(source: Source, policy: BudgetPolicy | null, now: Date): number {
    const since = policy?.unit === "tokens-total" ? this.policyStartedAt(policyKey(policy.scope)) : now.getTime() - 3_600_000;
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM admission_decisions WHERE source = ? AND allowed = 0 AND at >= ?").get(source, since) as { count: number }).count);
  }

  /** True while any Auto or Manual percentage-per-hour policy is enabled, so quota meters must be kept fresh. */
  quotaEnabled(source?: Source): boolean {
    const loaded = this.readSettings();
    return !loaded.error && loaded.settings.policies.some((policy) => policy.mode !== "off" &&
      (policy.mode === "auto" || policy.unit === "percentage-per-hour") &&
      (!source || policy.scope.kind !== "source" || policy.scope.source === source));
  }

  /**
   * One hook process at a time may refresh a source's quota meters: only when a quota policy applies and a
   * meter is missing or over 4 minutes old, and at most once a minute across processes.
   */
  claimMeterRefresh(source: Source): boolean {
    if (!this.quotaEnabled(source)) return false;
    return this.writeTransaction(() => {
      const at = this.now().getTime();
      const meters = this.meters().filter((meter) => meter.source === source);
      if (meters.length && meters.every((meter) => at - meter.observedAt.getTime() <= BUDGET_STALE_MS - 60_000)) return false;
      const row = this.db.prepare("SELECT tried_at FROM meter_refreshes WHERE source = ?").get(source) as { tried_at: number } | undefined;
      if (row && at - row.tried_at < 60_000) return false;
      this.db.prepare("INSERT INTO meter_refreshes (source, tried_at) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET tried_at = excluded.tried_at").run(source, at);
      return true;
    });
  }

  /** True when any policy is on, a stop is latched, or settings are unreadable, so hooks must do control work. */
  enforcing(): boolean {
    const loaded = this.readSettings();
    return Boolean(loaded.error) || loaded.settings.policies.some((policy) => policy.mode !== "off") || this.activeStops().length > 0;
  }

  private policyStartedAt(scopeKey: string): number {
    const row = this.db.prepare("SELECT started_at FROM policy_windows WHERE scope_key = ?").get(scopeKey) as { started_at: number } | undefined;
    return row?.started_at ?? 0;
  }

  /** Every window the provider supplies for this identity: all of them bound admission. */
  private metersFor(policy: BudgetPolicy, identity: BudgetIdentity): BudgetMeter[] {
    const provider = policy.scope.kind === "source" ? identity.provider : policy.scope.provider;
    return this.meters().filter((meter) => meter.source === identity.source &&
      canonicalIdentity(meter.provider) === canonicalIdentity(provider) &&
      (!identity.account || canonicalIdentity(meter.account) === canonicalIdentity(identity.account)));
  }

  /** Quota percentage points per weighted token, measured from this window's own movement, or null. */
  private calibrationRatio(meter: BudgetMeter, scopeKey: string, now: Date): number | null {
    const length = meterWindowMs(meter.window);
    if (length === null) return null;
    const start = Math.min(now.getTime(), meter.resetAt.getTime() - length);
    const tokens = this.tokensSince(scopeKey, start);
    return tokens > 0 && meter.usedPercentagePoints > 0 ? meter.usedPercentagePoints / tokens : null;
  }

  private tokensSince(scopeKey: string, since: number): number {
    return Number((this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM usage_events WHERE scope_key = ? AND unit = 'tokens-per-hour' AND at >= ?").get(scopeKey, since) as { total: number }).total);
  }

  /** A denial reason when the request would push any window past its hourly limit, else null. */
  private quotaDenial(policy: BudgetPolicy, scopeKey: string, meters: BudgetMeter[], estimateTokens: number, now: Date): string | null {
    const usedTokens = this.tokensSince(scopeKey, now.getTime() - 3_600_000);
    const reservedTokens = Number((this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM reservations WHERE scope_key = ? AND unit = 'tokens-per-hour' AND status = 'reserved'").get(scopeKey) as { total: number }).total);
    for (const meter of meters) {
      if (meterWindowMs(meter.window) === null) return "Authoritative budget meter has no known window length.";
      const limit = policy.mode === "auto" ? autoPace(meter, now) : policy.limit;
      if (limit === null || limit === undefined) return "Budget meter is unavailable or stale.";
      const ratio = this.calibrationRatio(meter, scopeKey, now);
      if (ratio === null) return "Auto needs measured quota movement to convert usage; no calibration in the current window.";
      if ((usedTokens + reservedTokens + estimateTokens) * ratio > limit + 1e-9) return "Budget allowance is exhausted.";
    }
    return null;
  }

  private estimateFor(policy: BudgetPolicy, _identity: BudgetIdentity, unit: string, now: Date): number | null {
    const key = policyKey(policy.scope);
    const rows = this.db.prepare(`SELECT amount FROM usage_events
      WHERE scope_key = ? AND unit = ? AND at >= ? ORDER BY amount DESC LIMIT 32`)
      .all(key, unit, now.getTime() - 86_400_000) as Array<{ amount: number }>;
    const values = rows.map((row) => Number(row.amount)).filter((amount) => Number.isFinite(amount) && amount > 0);
    return values.length ? values[0] : null;
  }

  private reconcileRows(reservationIds: string[], actualAmount: number, eventId: string, at: Date | undefined, actualUnit: ActualUsageUnit, source?: Source): string[] {
    const scopes = new Map<string, string>();
    const completed = new Set<string>();
    for (const reservationId of reservationIds) {
      const rows = this.db.prepare("SELECT scope_key, source, unit, status FROM reservations WHERE reservation_id = ?").all(reservationId) as Array<{ scope_key: string; source: string; unit: string; status: string }>;
      for (const row of rows) {
        if (row.status !== "reserved" || (source && row.source !== source) || !usageUnitMatches(row.unit, actualUnit)) continue;
        this.db.prepare("UPDATE reservations SET status = 'completed' WHERE reservation_id = ? AND scope_key = ? AND source = ? AND status = 'reserved'").run(reservationId, row.scope_key, row.source);
        scopes.set(`${row.scope_key}\0${row.unit}`, `${row.scope_key}\0${row.unit}`);
      }
    }
    for (const reservationId of reservationIds) {
      const remaining = this.db.prepare("SELECT 1 FROM reservations WHERE reservation_id = ? AND status = 'reserved' LIMIT 1").get(reservationId);
      if (!remaining) completed.add(reservationId);
    }
    for (const key of scopes.values()) {
      const [scopeKey, unit] = key.split("\0");
      this.db.prepare("INSERT OR IGNORE INTO usage_events (event_id, scope_key, amount, unit, at) VALUES (?, ?, ?, ?, ?)")
        .run(`${eventId}:${scopeKey}:${unit}`, scopeKey, actualAmount, unit, at?.getTime() ?? this.now().getTime());
    }
    return [...completed];
  }

  private meters(): BudgetMeter[] {
    return (this.db.prepare("SELECT * FROM meters").all() as unknown as StoredMeter[]).map((row) => ({
      id: row.id, source: row.source, provider: row.provider, account: row.account,
      usedPercentagePoints: row.used_percentage,
      resetAt: new Date(row.reset_at), observedAt: new Date(row.observed_at), authoritative: Boolean(row.authoritative), window: row.window ?? undefined,
    }));
  }

  private activeStops(): Array<{ scope: StopScope; operationId: string; createdAt: number }> {
    const durable = (this.db.prepare("SELECT scope_json, operation_id, created_at FROM stops WHERE active = 1").all() as Array<{ scope_json: string; operation_id: string; created_at: number }>).map((row) => ({
      scope: JSON.parse(row.scope_json) as StopScope, operationId: row.operation_id, createdAt: row.created_at,
    }));
    const byKey = new Map(durable.map((stop) => [policyKey(stop.scope), stop]));
    for (const latch of this.readSettings().settings.latches ?? []) byKey.set(policyKey(latch.scope), latch);
    return [...byKey.values()];
  }

  private readSettings(): { settings: StoredSettings; error: string | null } {
    if (!existsSync(this.settingsPath)) return { settings: { version: 1, revision: 0, policies: [] }, error: null };
    try {
      const value = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Partial<StoredSettings>;
      if (value.version !== 1 || !Number.isInteger(value.revision) || !Array.isArray(value.policies)) throw new Error("Budget settings file is malformed.");
      const policies: BudgetPolicy[] = [];
      const keys = new Set<string>();
      for (const candidate of value.policies) {
        const result = validateBudgetPolicy(candidate as BudgetPolicy, new Date(0));
        if (result.error || !result.policy) throw new Error(`Budget settings file is malformed: ${result.error ?? "invalid policy"}`);
        const key = policyKey(result.policy.scope);
        if (keys.has(key)) throw new Error(`Budget settings file is malformed: duplicate ${key}`);
        keys.add(key); policies.push(result.policy);
      }
      this.settingsError = null;
      const latches = (Array.isArray(value.latches) ? value.latches : []).map((latch) => {
        if (!latch || typeof latch !== "object" || typeof (latch as { operationId?: unknown }).operationId !== "string" || !Number.isFinite((latch as { createdAt?: unknown }).createdAt)) throw new Error("Budget settings file is malformed: invalid stop latch.");
        const scope = normalizeScope((latch as { scope: StopScope }).scope);
        return { scope, operationId: (latch as { operationId: string }).operationId, createdAt: Number((latch as { createdAt: number }).createdAt) };
      });
      return { settings: { version: 1, revision: Number(value.revision), policies, latches }, error: null };
    } catch (error) {
      this.settingsError = error instanceof Error ? error.message : String(error);
      return { settings: { version: 1, revision: 0, policies: [] }, error: this.settingsError };
    }
  }

  private writeSettings(settings: StoredSettings): void {
    writePrivateFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  private writeTransaction<T>(fn: () => T): T {
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        if (attempt < 3 && /busy|locked/i.test(String(error))) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }
  }
}

function validCost(value: number | undefined): boolean {
  return Number.isFinite(value) && (value ?? 0) > 0;
}

function usageUnitMatches(reservationUnit: string, actualUnit: ActualUsageUnit): boolean {
  if (actualUnit === "reservation") return true;
  if (actualUnit === "tokens") return reservationUnit === "tokens-total" || reservationUnit === "tokens-per-hour";
  return reservationUnit === actualUnit;
}

function meterIsAdmissible(meter: BudgetMeter | null, now: Date): meter is BudgetMeter {
  return Boolean(meter && meter.authoritative && meter.account && meter.window && Number.isFinite(meter.observedAt.getTime()) &&
    meter.observedAt.getTime() <= now.getTime() && now.getTime() - meter.observedAt.getTime() <= 5 * 60_000);
}

function normalizeScope(scope: StopScope): StopScope {
  if (scope.kind === "source") return scope;
  if (scope.kind === "provider") return { kind: "provider", provider: canonicalIdentity(scope.provider)! };
  return { kind: "model", provider: canonicalIdentity(scope.provider)!, model: canonicalIdentity(scope.model)! };
}

function fingerprintOf(scope: StopScope, targetIds: string[], targetProof = ""): string {
  return createHash("sha256").update(JSON.stringify({ scope, targetIds, targetProof })).digest("hex");
}

function stopMatches(scope: StopScope, identity: BudgetIdentity): boolean {
  if (scope.kind === "source") return scope.source === identity.source;
  if (scope.kind === "provider") return Boolean(identity.provider) && canonicalIdentity(scope.provider) === canonicalIdentity(identity.provider);
  return Boolean(identity.provider && identity.model) &&
    (canonicalIdentity(scope.provider) === canonicalIdentity(identity.provider) && canonicalIdentity(scope.model) === canonicalIdentity(identity.model));
}

function stopRequiresResolvedIdentity(scope: StopScope, identity: BudgetIdentity): boolean {
  if (scope.kind === "source") return false;
  if (!identity.provider) return true;
  return scope.kind === "model" && canonicalIdentity(scope.provider) === canonicalIdentity(identity.provider) && !identity.model;
}

function retrySqliteInitialization<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try { return fn(); } catch (error) {
      if (attempt >= 5 || !sqliteBusy(error)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (2 ** attempt));
    }
  }
}

function addSqliteColumn(db: DatabaseSync, statement: string): void {
  try { db.exec(statement); } catch (error) {
    if (!/duplicate column name|already exists/i.test(sqliteErrorText(error))) throw error;
  }
}

function sqliteBusy(error: unknown): boolean {
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(sqliteErrorText(error));
}

function sqliteErrorText(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return `${code} ${error instanceof Error ? error.message : String(error)}`;
}
