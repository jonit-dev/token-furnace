import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Source } from "../core/model";
import { canonicalIdentity, type BudgetIdentity, type BudgetScope } from "../core/budgets";
import type { Env } from "../sources/agent-source";

export interface ProcessIdentity {
  pid: number;
  processStartTime: number;
  ownerUid: number | null;
  parentPid: number | null;
  executable?: string | null;
}

export interface NativeTarget {
  kind: "opencode" | "codex";
  endpoint: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
}

export interface ControlTarget {
  id: string;
  source: Source;
  provider: string | null;
  /** Provider account/quota identity when the native runtime exposes it. */
  account?: string | null;
  model: string | null;
  pid: number;
  processStartTime: number;
  ownerUid: number | null;
  executable?: string | null;
  sessionId?: string | null;
  /** Native cancellation is preferred for mixed-model hosts. */
  native?: NativeTarget;
  nativeCancel?: () => Promise<boolean>;
  nativeState?: () => Promise<boolean>;
  /** Process fallback is valid only when this target owns the whole process. */
  exclusive?: boolean;
}

export interface ControlOutcome {
  targetId: string;
  status: "requested" | "cancelled" | "terminated" | "unresolved" | "failed";
  detail?: string;
}

export interface ControlPreview {
  targets: ControlTarget[];
  unverified: Array<{ id: string; source: Source | null; provider: string | null; model: string | null; detail: string }>;
  collateral: Array<{ id: string; source: Source | null; provider: string | null; model: string | null; detail: string }>;
}

/** Stable proof of the verified process/native identities shown in a stop preview. */
export function controlTargetProof(targets: ControlTarget[]): string {
  const identity = [...targets].sort((a, b) => a.id.localeCompare(b.id)).map((target) => ({
    id: target.id,
    source: target.source,
    provider: target.provider,
    account: target.account ?? null,
    model: target.model,
    pid: target.pid,
    processStartTime: target.processStartTime,
    ownerUid: target.ownerUid,
    executable: target.executable ?? null,
    native: target.native ?? null,
    exclusive: target.exclusive === true,
  }));
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export interface AgentControlOptions {
  env?: Env;
  statePath?: string;
  inspect?: (pid: number) => ProcessIdentity | null;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  currentUid?: number | null;
  currentPid?: number;
  /** Adapter discovery is invoked for every preview, so racing work is visible. */
  discoverRuntime?: () => ControlTarget[];
  graceMs?: number;
}

interface StoredControl {
  version: 1;
  targets: Array<Omit<ControlTarget, "nativeCancel" | "nativeState">>;
  outcomes: ControlOutcome[];
}

/** Durable ownership-aware local control. Unregistered or unverifiable work is never signalled. */
export class AgentControl {
  private readonly targets = new Map<string, ControlTarget>();
  private readonly outcomes = new Map<string, ControlOutcome>();
  private readonly inspectProcess: (pid: number) => ProcessIdentity | null;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly currentUid: number | null;
  private readonly currentPid: number;
  private readonly statePath: string | null;
  private readonly discoverRuntime?: () => ControlTarget[];
  private readonly graceMs: number;

  constructor(options: AgentControlOptions = {}) {
    this.inspectProcess = options.inspect ?? inspectProcess;
    this.signalProcess = options.signal ?? ((pid, signal) => process.kill(pid, signal));
    this.currentUid = options.currentUid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : options.currentUid;
    this.currentPid = options.currentPid ?? process.pid;
    const env = options.env ?? process.env;
    const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
    this.statePath = options.statePath ?? join(state, "token-furnace", "control.json");
    this.discoverRuntime = options.discoverRuntime;
    this.graceMs = Math.max(0, options.graceMs ?? 5_000);
    this.load();
  }

  register(target: ControlTarget): boolean {
    if (!target.id || !Number.isInteger(target.pid) || target.pid <= 0 || target.pid === this.currentPid) return false;
    if (this.currentUid !== null && target.ownerUid !== null && target.ownerUid !== this.currentUid) return false;
    const normalized: ControlTarget = {
      ...target,
      provider: canonicalIdentity(target.provider),
      account: canonicalIdentity(target.account),
      model: canonicalIdentity(target.model),
      sessionId: target.sessionId ?? target.native?.sessionId ?? null,
      executable: target.executable ?? this.inspectProcess(target.pid)?.executable ?? null,
      nativeCancel: target.nativeCancel ?? nativeCanceller(target.native),
      nativeState: target.nativeState ?? nativeStateChecker(target.native),
    };
    this.targets.set(normalized.id, normalized);
    this.persist();
    return true;
  }

  unregister(id: string): void {
    this.targets.delete(id);
    this.persist();
  }

  /** All durable registrations, useful for provider/model identity discovery in the UI. */
  registered(): ControlTarget[] {
    this.refreshRuntime();
    return [...this.targets.values()];
  }

  processIdentity(pid: number): ProcessIdentity | null {
    return this.inspectProcess(pid);
  }

  /** A real preview includes only targets that can be safely signalled plus unresolved scope. */
  preview(scope: BudgetScope): ControlPreview {
    this.refreshRuntime();
    const targets: ControlTarget[] = [];
    const unverified: ControlPreview["unverified"] = [];
    const collateral: ControlPreview["collateral"] = [];
    for (const target of this.targets.values()) {
      const relation = scopeRelation(scope, target);
      if (relation === "none") continue;
      const verification = this.verify(target);
      if (relation === "unknown") {
        unverified.push({ id: target.id, source: target.source, provider: target.provider, model: target.model, detail: "Provider or model identity is unresolved for this stop scope." });
      } else if (verification.ok) {
        targets.push(target);
      } else {
        unverified.push({ id: target.id, source: target.source, provider: target.provider, model: target.model, detail: verification.detail });
      }
    }
    // A non-exclusive process can contain unrelated sessions. It is shown as collateral, never
    // widened into a force kill without a new explicit confirmation.
    for (const target of targets) {
      if (target.exclusive !== true && !target.nativeCancel) {
        collateral.push({ id: target.id, source: target.source, provider: target.provider, model: target.model, detail: "Process fallback is not exclusive." });
      }
    }
    return { targets, unverified, collateral };
  }

  discover(scope: BudgetScope): ControlTarget[] {
    return this.preview(scope).targets;
  }

  async cancel(target: ControlTarget, force = false): Promise<ControlOutcome> {
    const identity = this.inspectProcess(target.pid);
    if (!identity) return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Process is no longer discoverable." });
    if (target.pid === this.currentPid || this.protectsCurrentProcess(target.pid)) {
      return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Refused to target Token Furnace or an ancestor." });
    }
    if (identity.processStartTime !== target.processStartTime || identity.ownerUid !== target.ownerUid) {
      return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Process ownership or start identity changed." });
    }
    if (this.currentUid !== null && identity.ownerUid !== this.currentUid) {
      return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Process is not owned by the current user." });
    }
    if (target.executable && identity.executable && !sameExecutable(target.executable, identity.executable)) {
      return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Executable identity changed." });
    }

    if (!force && target.nativeCancel) {
      try {
        if (await target.nativeCancel()) {
          const terminal = await this.waitForTerminal(target);
          if (terminal) return this.finish(target, { targetId: target.id, status: "cancelled", detail: "Native terminal state or process exit verified." });
          return this.finish(target, { targetId: target.id, status: "requested", detail: "Native cancellation was accepted; terminal state remains unresolved." });
        }
      } catch (error) {
        if (target.exclusive !== true) {
          return this.finish(target, { targetId: target.id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    if (target.exclusive !== true) {
      return this.finish(target, { targetId: target.id, status: "unresolved", detail: "No native adapter and process fallback is not exclusive." });
    }
    try {
      this.signalProcess(target.pid, force ? "SIGKILL" : "SIGTERM");
      const terminal = await this.waitForTerminal(target);
      if (terminal) return this.finish(target, { targetId: target.id, status: force ? "terminated" : "cancelled", detail: "Process exit verified." });
      return this.finish(target, {
        targetId: target.id,
        status: force ? "unresolved" : "requested",
        detail: force ? "Force signal sent but process exit was not verified." : "Cancellation requested; five-second grace period did not finish the process.",
      });
    } catch (error) {
      return this.finish(target, { targetId: target.id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  async stop(scope: BudgetScope, force = false): Promise<ControlOutcome[]> {
    const targets = this.discover(scope);
    const outcomes: ControlOutcome[] = [];
    for (const target of targets) outcomes.push(await this.cancel(target, force));
    return outcomes;
  }

  close(): void {
    this.persist();
  }

  private refreshRuntime(): void {
    const discovered = this.discoverRuntime?.() ?? discoverMarkedProcesses(this.inspectProcess, this.currentPid);
    for (const target of discovered) {
      if (target.id) this.targets.set(target.id, { ...target, provider: canonicalIdentity(target.provider), account: canonicalIdentity(target.account), model: canonicalIdentity(target.model), nativeCancel: target.nativeCancel ?? nativeCanceller(target.native), nativeState: target.nativeState ?? nativeStateChecker(target.native) });
    }
    if (discovered.length) this.persist();
  }

  private verify(target: ControlTarget): { ok: true } | { ok: false; detail: string } {
    const identity = this.inspectProcess(target.pid);
    if (!identity) return { ok: false, detail: "Process is no longer discoverable." };
    if (target.pid === this.currentPid || this.protectsCurrentProcess(target.pid)) return { ok: false, detail: "Token Furnace or an ancestor is protected." };
    if (identity.processStartTime !== target.processStartTime || identity.ownerUid !== target.ownerUid) return { ok: false, detail: "Process ownership or start identity changed." };
    if (this.currentUid !== null && identity.ownerUid !== this.currentUid) return { ok: false, detail: "Process is not owned by the current user." };
    if (target.executable && identity.executable && !sameExecutable(target.executable, identity.executable)) return { ok: false, detail: "Executable identity changed." };
    return { ok: true };
  }

  /** Walk the current process's parents: descendants are valid workers, ancestors are protected. */
  private protectsCurrentProcess(pid: number): boolean {
    const seen = new Set<number>();
    let current = this.inspectProcess(this.currentPid)?.parentPid ?? null;
    while (current && current > 1 && !seen.has(current)) {
      if (current === pid) return true;
      seen.add(current);
      current = this.inspectProcess(current)?.parentPid ?? null;
    }
    return false;
  }

  private async waitForTerminal(target: ControlTarget): Promise<boolean> {
    const started = Date.now();
    while (true) {
      if (target.nativeState) {
        try { if (await target.nativeState()) return true; } catch { /* keep checking process ownership */ }
      }
      if (!this.inspectProcess(target.pid)) return true;
      if (Date.now() - started >= this.graceMs) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, this.graceMs)));
    }
  }

  private finish(target: ControlTarget, outcome: ControlOutcome): ControlOutcome {
    this.outcomes.set(target.id, outcome);
    this.persist();
    return outcome;
  }

  private load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const stored = JSON.parse(readFileSync(this.statePath, "utf8")) as StoredControl;
      if (stored.version !== 1 || !Array.isArray(stored.targets)) return;
      for (const target of stored.targets) {
        if (!target?.id || !Number.isInteger(target.pid)) continue;
        this.targets.set(target.id, { ...target, provider: canonicalIdentity(target.provider), account: canonicalIdentity(target.account), model: canonicalIdentity(target.model), nativeCancel: nativeCanceller(target.native), nativeState: nativeStateChecker(target.native) });
      }
      for (const outcome of stored.outcomes ?? []) if (outcome?.targetId) this.outcomes.set(outcome.targetId, outcome);
    } catch { /* A corrupt registry is unresolved work, never a reason to signal by guess. */ }
  }

  private persist(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const targets = [...this.targets.values()].map(({ nativeCancel: _nativeCancel, nativeState: _nativeState, ...target }) => target);
      const value: StoredControl = { version: 1, targets, outcomes: [...this.outcomes.values()].slice(-200) };
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      try { chmodSync(temporary, 0o600); } catch { /* best effort on Windows */ }
      renameSync(temporary, this.statePath);
    } catch { /* Control state is fail-closed; the next preview marks the target unresolved. */ }
  }
}

function scopeRelation(scope: BudgetScope, target: ControlTarget): "match" | "unknown" | "none" {
  if (scope.kind === "source") return scope.source === target.source ? "match" : "none";
  if (!target.provider) return "unknown";
  if (canonicalIdentity(scope.provider) !== canonicalIdentity(target.provider)) return "none";
  if (scope.kind === "provider") return "match";
  if (!target.model) return "unknown";
  return canonicalIdentity(scope.model) === canonicalIdentity(target.model) ? "match" : "none";
}

function sameExecutable(expected: string, actual: string): boolean {
  try { return realpathSync(expected) === realpathSync(actual); } catch { return expected === actual || expected.endsWith(`/${actual}`) || actual.endsWith(`/${expected}`); }
}

function nativeCanceller(native: NativeTarget | undefined): (() => Promise<boolean>) | undefined {
  if (!native?.endpoint || (native.kind === "opencode" && !native.sessionId)) return undefined;
  return async () => {
    if (!/^https?:\/\//i.test(native.endpoint)) return false;
    const path = native.kind === "opencode"
      ? `${native.endpoint.replace(/\/$/, "")}/session/${encodeURIComponent(native.sessionId ?? "")}/abort`
      : native.endpoint;
    const body = native.kind === "codex"
      ? { jsonrpc: "2.0", id: randomUUID(), method: "turn/interrupt", params: { threadId: native.threadId, turnId: native.turnId } }
      : undefined;
    const response = await fetch(path, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(2_000) });
    return response.ok;
  };
}

function nativeStateChecker(native: NativeTarget | undefined): (() => Promise<boolean>) | undefined {
  if (!native?.endpoint || native.kind !== "opencode" || !native.sessionId || !/^https?:\/\//i.test(native.endpoint)) return undefined;
  return async () => {
    const response = await fetch(`${native.endpoint.replace(/\/$/, "")}/session/status`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const statuses = await response.json() as Record<string, { type?: string }>;
    const status = statuses[native.sessionId!];
    return Boolean(status && status.type !== "busy");
  };
}

function discoverMarkedProcesses(inspect: (pid: number) => ProcessIdentity | null, currentPid: number): ControlTarget[] {
  if (process.platform === "win32") return [];
  const out: ControlTarget[] = [];
  let pids: string[];
  try { pids = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)); } catch { return out; }
  for (const value of pids) {
    const pid = Number(value);
    if (pid === currentPid) continue;
    const identity = inspect(pid);
    if (!identity) continue;
    const env = readProcEnv(pid);
    if (env.TOKEN_FURNACE_CONTROL_TARGET !== "1") continue;
    const source = env.TOKEN_FURNACE_SOURCE;
    if (source !== "claude" && source !== "codex" && source !== "opencode") continue;
    const executable = identity.executable ?? readProcExecutable(pid);
    out.push({
      id: env.TOKEN_FURNACE_SESSION_ID || `${source}:${pid}:${identity.processStartTime}`,
      source,
      provider: env.TOKEN_FURNACE_PROVIDER || null,
      account: env.TOKEN_FURNACE_ACCOUNT || null,
      model: env.TOKEN_FURNACE_MODEL || null,
      pid,
      processStartTime: identity.processStartTime,
      ownerUid: identity.ownerUid,
      executable,
      sessionId: env.TOKEN_FURNACE_NATIVE_SESSION || null,
      native: env.TOKEN_FURNACE_NATIVE_ENDPOINT ? {
        kind: source === "opencode" ? "opencode" : "codex",
        endpoint: env.TOKEN_FURNACE_NATIVE_ENDPOINT,
        sessionId: env.TOKEN_FURNACE_NATIVE_SESSION,
        threadId: env.TOKEN_FURNACE_NATIVE_THREAD,
        turnId: env.TOKEN_FURNACE_NATIVE_TURN,
      } : undefined,
      exclusive: env.TOKEN_FURNACE_EXCLUSIVE === "1",
    });
  }
  return out;
}

function readProcEnv(pid: number): Record<string, string> {
  try {
    const result: Record<string, string> = {};
    for (const entry of readFileSync(`/proc/${pid}/environ`).toString().split("\0")) {
      const split = entry.indexOf("=");
      if (split > 0 && entry.startsWith("TOKEN_FURNACE_")) result[entry.slice(0, split)] = entry.slice(split + 1);
    }
    return result;
  } catch { return {}; }
}

function readProcExecutable(pid: number): string | null {
  try { return realpathSync(`/proc/${pid}/exe`); } catch { return null; }
}

function inspectProcess(pid: number): ProcessIdentity | null {
  if (process.platform === "win32") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const parentPid = Number(fields[1]);
    const processStartTime = Number(fields[19]);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    if (!Number.isFinite(parentPid) || !Number.isFinite(processStartTime) || uid === undefined) return null;
    return { pid, processStartTime, ownerUid: Number(uid), parentPid, executable: readProcExecutable(pid) };
  } catch { return null; }
}

export function controlIdentity(target: ControlTarget): BudgetIdentity {
  return { source: target.source, provider: target.provider, model: target.model };
}
