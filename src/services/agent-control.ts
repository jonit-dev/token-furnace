import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { connect as connectTls } from "node:tls";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Source } from "../core/model";
import { canonicalIdentity, type BudgetIdentity, type BudgetScope } from "../core/budgets";
import type { Env } from "../sources/agent-source";

export interface ProcessIdentity {
  pid: number;
  processStartTime: number;
  ownerUid: number | null;
  ownerIdentity?: string | null;
  ownerSid?: string | null;
  parentPid: number | null;
  executable?: string | null;
  commandLine?: string | null;
}

export interface NativeAuth {
  scheme: "bearer" | "basic";
  /** Environment variable names only; secret values never enter target metadata. */
  tokenEnv?: string;
  usernameEnv?: string;
  passwordEnv?: string;
}

export interface NativeTarget {
  kind: "opencode" | "codex";
  endpoint: string;
  transport?: "http" | "websocket" | "unix" | "stdio";
  auth?: NativeAuth;
  /** Legacy Codex-only environment variable name; endpoint credentials never enter the control store. */
  authEnv?: string;
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
  ownerIdentity?: string | null;
  ownerSid?: string | null;
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
    ownerIdentity: target.ownerIdentity ?? null,
    ownerSid: target.ownerSid ?? null,
    executable: target.executable ?? null,
    native: target.native ?? null,
    exclusive: target.exclusive === true,
  }));
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export interface AgentControlOptions {
  env?: Env;
  /** Legacy test name retained; this path is now a SQLite control store. */
  statePath?: string;
  storePath?: string;
  inspect?: (pid: number) => ProcessIdentity | null;
  listProcesses?: () => ProcessIdentity[];
  listNativeProcesses?: () => ProcessIdentity[];
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  currentUid?: number | null;
  currentOwner?: string | null;
  currentOwnerSid?: string | null;
  currentPid?: number;
  /** Adapter discovery is invoked for every preview, so racing work is visible. */
  discoverRuntime?: () => ControlTarget[];
  graceMs?: number;
}

interface ProcessInspectionResult {
  identity: ProcessIdentity | null;
  available: boolean;
  detail?: string;
}

interface ProcessMetadataGraph {
  available: boolean;
  byPid: Map<number, ProcessIdentity>;
  detail?: string;
}

/** Durable ownership-aware local control. Unregistered or unverifiable work is never signalled. */
export class AgentControl {
  private readonly inspectProcess: (pid: number) => ProcessIdentity | null;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly currentUid: number | null;
  private readonly currentOwner: string | null;
  private currentOwnerSid: string | null;
  private readonly resolveCurrentOwnerSid: boolean;
  private currentOwnerSidResolved = false;
  private readonly currentPid: number;
  private readonly env: Env;
  private readonly store: ControlStore | null;
  private readonly discoverRuntime?: () => ControlTarget[];
  private readonly listProcesses: () => ProcessIdentity[];
  private readonly listNativeProcesses: () => ProcessIdentity[];
  private readonly metadataAncestry: boolean;
  private readonly graceMs: number;
  private readonly adapters = new Map<string, { cancel?: () => Promise<boolean>; state?: () => Promise<boolean> }>();
  private runtimeUnverified: ControlPreview["unverified"] = [];
  private storeError: string | null = null;
  private closed = false;

  constructor(options: AgentControlOptions = {}) {
    this.inspectProcess = options.inspect ?? inspectProcess;
    this.signalProcess = options.signal ?? terminateProcess;
    this.currentUid = options.currentUid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : options.currentUid;
    this.currentPid = options.currentPid ?? process.pid;
    const env = options.env ?? process.env;
    this.currentOwner = options.currentOwner === undefined
      ? process.platform === "win32" && env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME ?? env.USER ?? null
      : options.currentOwner;
    this.currentOwnerSid = options.currentOwnerSid ?? null;
    this.resolveCurrentOwnerSid = process.platform === "win32" && options.currentOwnerSid === undefined;
    this.env = env;
    const state = env.TOKEN_FURNACE_STATE_HOME || env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
    const storePath = options.storePath ?? options.statePath ?? join(state, "token-furnace", "control.sqlite");
    try { this.store = new ControlStore(storePath); } catch (error) {
      this.store = null;
      this.storeError = error instanceof Error ? error.message : String(error);
    }
    this.discoverRuntime = options.discoverRuntime;
    this.listProcesses = options.listProcesses ?? listProcessIdentities;
    this.listNativeProcesses = options.listNativeProcesses ?? options.listProcesses ?? listNativeProcessIdentities;
    this.metadataAncestry = process.platform === "win32" || options.listProcesses !== undefined;
    this.graceMs = Math.max(0, options.graceMs ?? 5_000);
  }

  register(target: ControlTarget): boolean {
    if (!target.id || !Number.isInteger(target.pid) || target.pid <= 0 || target.pid === this.currentPid) return false;
    const observedResult = this.inspectSafely(target.pid);
    if (!observedResult.available) return false;
    const observed = observedResult.identity;
    const ownerUid = target.ownerUid ?? observed?.ownerUid ?? null;
    const ownerIdentity = target.ownerIdentity ?? observed?.ownerIdentity ?? null;
    const ownerSid = target.ownerSid ?? observed?.ownerSid ?? null;
    if (this.currentUid !== null && ownerUid !== null && ownerUid !== this.currentUid) return false;
    const currentOwnerSid = this.ownerSid();
    if (this.requiresVerifiedOwnerSid() && !currentOwnerSid) return false;
    if (currentOwnerSid && ownerSid && ownerSid !== currentOwnerSid) return false;
    const normalized: ControlTarget = {
      ...target,
      provider: canonicalIdentity(target.provider),
      account: canonicalIdentity(target.account),
      model: canonicalIdentity(target.model),
      sessionId: target.sessionId ?? target.native?.sessionId ?? null,
      ownerUid,
      ownerIdentity,
      ownerSid,
      executable: target.executable ?? observed?.executable ?? null,
      nativeCancel: target.nativeCancel ?? nativeCanceller(target.native, this.env),
      nativeState: target.nativeState ?? nativeStateChecker(target.native, this.env),
    };
    this.adapters.set(normalized.id, { cancel: normalized.nativeCancel, state: normalized.nativeState });
    return this.writeStore(() => this.store?.upsertTarget(normalized) ?? false);
  }

  unregister(id: string): void {
    this.writeStore(() => this.store?.removeTarget(id) ?? false);
  }

  /** All durable registrations, useful for provider/model identity discovery in the UI. */
  registered(): ControlTarget[] {
    this.refreshRuntime();
    return this.readTargets();
  }

  processIdentity(pid: number): ProcessIdentity | null {
    return this.inspectSafely(pid).identity;
  }

  /** Resolve a hook's intermediary parent to the owned native runtime, never to a shell alone. */
  owningProcess(pid: number, source: Source, expectedExecutable?: string | null): ProcessIdentity | null {
    const seen = new Set<number>();
    let currentResult = this.inspectSafely(pid);
    if (!currentResult.available) return null;
    let current = currentResult.identity;
    while (current && current.pid > 1 && !seen.has(current.pid)) {
      seen.add(current.pid);
      const executable = current.executable ?? "";
      const expected = expectedExecutable && sameExecutable(expectedExecutable, executable);
      if (sourceForIdentity(current) === source && (!expectedExecutable || expected || sourceForExecutable(executable) === source)) return current;
      currentResult = current.parentPid ? this.inspectSafely(current.parentPid) : { identity: null, available: true };
      if (!currentResult.available) return null;
      current = currentResult.identity;
    }
    return null;
  }

  /** A real preview includes only targets that can be safely signalled plus unresolved scope. */
  preview(scope: BudgetScope): ControlPreview {
    this.refreshRuntime();
    const targets: ControlTarget[] = [];
    const unverified: ControlPreview["unverified"] = [...this.runtimeUnverified];
    const collateral: ControlPreview["collateral"] = [];
    const metadataGraph = this.metadataAncestry ? this.readMetadataGraph() : undefined;
    if (this.storeError) unverified.push({ id: "control-store", source: null, provider: null, model: null, detail: `Control store unavailable: ${this.storeError}` });
    for (const target of this.readTargets()) {
      const relation = scopeRelation(scope, target);
      if (relation === "none") continue;
      const verification = this.verify(target, metadataGraph);
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

  ownsSession(source: Source, sessionId: string): boolean {
    if (!sessionId) return false;
    return this.preview({ kind: "source", source }).targets.some((target) => target.sessionId === sessionId || target.id === sessionId);
  }

  async cancel(target: ControlTarget, force = false): Promise<ControlOutcome> {
    const initial = this.inspectSafely(target.pid);
    if (!initial.available) return this.finish(target, { targetId: target.id, status: "unresolved", detail: initial.detail ?? "Process identity lookup is unavailable." });
    const identity = initial.identity;
    if (!identity) return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Process is no longer discoverable." });
    const metadataGraph = this.metadataAncestry ? this.readMetadataGraph() : undefined;
    const protection = this.protectsCurrentProcess(target.pid, metadataGraph);
    if (!protection.available) return this.finish(target, { targetId: target.id, status: "unresolved", detail: protection.detail ?? "Ancestor identity lookup is unavailable." });
    if (target.pid === this.currentPid || protection.protected) {
      return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Refused to target Token Furnace or an ancestor." });
    }
    if (identity.processStartTime !== target.processStartTime || identity.ownerUid !== target.ownerUid || (identity.ownerIdentity ?? null) !== (target.ownerIdentity ?? null) || (identity.ownerSid ?? null) !== (target.ownerSid ?? null)) {
      return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Process ownership or start identity changed." });
    }
    if (this.currentUid !== null && identity.ownerUid !== this.currentUid) {
      return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Process is not owned by the current user." });
    }
    if (!this.matchesCurrentOwner(identity)) {
      return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Process owner SID changed." });
    }
    if (target.executable && identity.executable && !sameExecutable(target.executable, identity.executable)) {
      return this.finish(target, { targetId: target.id, status: "unresolved", detail: "Executable identity changed." });
    }

    if (!force && target.nativeCancel) {
      try {
        const beforeNative = this.verify(target, metadataGraph);
        if (!beforeNative.ok) return this.finish(target, { targetId: target.id, status: "unresolved", detail: beforeNative.detail });
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
      const beforeSignal = this.verify(target, metadataGraph);
      if (!beforeSignal.ok) return this.finish(target, { targetId: target.id, status: "unresolved", detail: beforeSignal.detail });
      const descendants = this.ownedDescendants(target, metadataGraph);
      if (descendants === null) return this.finish(target, { targetId: target.id, status: "unresolved", detail: "An owned descendant could not be verified for process fallback." });
      this.signalProcess(target.pid, force ? "SIGKILL" : "SIGTERM");
      for (const descendant of descendants) {
        const inspected = this.inspectSafely(descendant.pid);
        if (!inspected.available) return this.finish(target, { targetId: target.id, status: "unresolved", detail: "An owned descendant identity lookup is unavailable." });
        if (!inspected.identity) continue;
        if (!this.verifyProcessIdentity(descendant, inspected.identity, metadataGraph)) return this.finish(target, { targetId: target.id, status: "unresolved", detail: "An owned descendant changed identity before termination." });
        this.signalProcess(descendant.pid, force ? "SIGKILL" : "SIGTERM");
      }
      const terminal = await this.waitForProcessExit(target, descendants);
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
    if (this.closed) return;
    this.closed = true;
    this.store?.close();
  }

  private refreshRuntime(): void {
    let discovered: ControlTarget[];
    try {
      discovered = this.discoverRuntime?.() ?? this.discoverNativeProcesses();
    } catch (error) {
      this.runtimeUnverified = [{
        id: "native-discovery",
        source: null,
        provider: null,
        model: null,
        detail: `Native process discovery is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      }];
      return;
    }
    for (const target of discovered) {
      if (!target.id) continue;
      const normalized = { ...target, provider: canonicalIdentity(target.provider), account: canonicalIdentity(target.account), model: canonicalIdentity(target.model), nativeCancel: target.nativeCancel ?? nativeCanceller(target.native, this.env), nativeState: target.nativeState ?? nativeStateChecker(target.native, this.env) };
      this.adapters.set(normalized.id, { cancel: normalized.nativeCancel, state: normalized.nativeState });
      this.writeStore(() => this.store?.upsertTarget(normalized) ?? false);
    }
    if (this.discoverRuntime) this.runtimeUnverified = [];
  }

  private discoverNativeProcesses(): ControlTarget[] {
    try {
      const discovered = discoverNativeProcesses(this.listNativeProcesses, (pid) => this.inspectSafely(pid).identity, this.currentPid);
      this.runtimeUnverified = discovered.unverified;
      return discovered.targets;
    } catch (error) {
      this.runtimeUnverified = [{
        id: "native-discovery",
        source: null,
        provider: null,
        model: null,
        detail: `Native process discovery is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      }];
      return [];
    }
  }

  private readTargets(): ControlTarget[] {
    if (!this.store) return [];
    try {
      return this.store.readTargets().map((target) => {
        const adapter = this.adapters.get(target.id);
        return { ...target, nativeCancel: adapter?.cancel ?? nativeCanceller(target.native, this.env), nativeState: adapter?.state ?? nativeStateChecker(target.native, this.env) };
      });
    } catch (error) {
      this.storeError = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  private writeStore(fn: () => boolean): boolean {
    try {
      const ok = fn();
      if (!ok) this.storeError ??= "Control store is unavailable.";
      return ok;
    } catch (error) {
      this.storeError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private verify(target: ControlTarget, metadataGraph?: ProcessMetadataGraph): { ok: true } | { ok: false; detail: string } {
    const inspected = this.inspectSafely(target.pid);
    if (!inspected.available) return { ok: false, detail: inspected.detail ?? "Process identity lookup is unavailable." };
    const identity = inspected.identity;
    if (!identity) return { ok: false, detail: "Process is no longer discoverable." };
    const protection = this.protectsCurrentProcess(target.pid, metadataGraph);
    if (!protection.available) return { ok: false, detail: protection.detail ?? "Ancestor identity lookup is unavailable." };
    if (target.pid === this.currentPid || protection.protected) return { ok: false, detail: "Token Furnace or an ancestor is protected." };
    if (identity.processStartTime !== target.processStartTime || identity.ownerUid !== target.ownerUid || (identity.ownerIdentity ?? null) !== (target.ownerIdentity ?? null) || (identity.ownerSid ?? null) !== (target.ownerSid ?? null)) return { ok: false, detail: "Process ownership or start identity changed." };
    if (identity.ownerUid === null && !identity.ownerIdentity && !identity.ownerSid) return { ok: false, detail: "Process owner identity is unavailable." };
    if (this.currentUid !== null && identity.ownerUid !== this.currentUid) return { ok: false, detail: "Process is not owned by the current user." };
    if (this.currentOwner && identity.ownerIdentity && identity.ownerIdentity !== this.currentOwner) return { ok: false, detail: "Process owner identity changed." };
    if (!this.matchesCurrentOwner(identity)) return { ok: false, detail: "Process owner identity changed or is unavailable." };
    if (target.executable && identity.executable && !sameExecutable(target.executable, identity.executable)) return { ok: false, detail: "Executable identity changed." };
    return { ok: true };
  }

  private readMetadataGraph(): ProcessMetadataGraph {
    try {
      const byPid = new Map<number, ProcessIdentity>();
      for (const identity of this.listProcesses()) {
        if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !Number.isFinite(identity.processStartTime) || identity.processStartTime <= 0 || (identity.parentPid !== null && (!Number.isInteger(identity.parentPid) || identity.parentPid < 0)) || (identity.executable != null && typeof identity.executable !== "string")) {
          return { available: false, byPid, detail: `Process metadata graph is malformed at PID ${identity.pid} (start ${identity.processStartTime}, parent PID ${identity.parentPid ?? "none"}).` };
        }
        if (byPid.has(identity.pid)) return { available: false, byPid, detail: `Process metadata graph contains duplicate PID ${identity.pid}.` };
        byPid.set(identity.pid, identity);
      }
      return { available: true, byPid };
    } catch (error) {
      return {
        available: false,
        byPid: new Map(),
        detail: `Process metadata graph is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private graphInspection(graph: ProcessMetadataGraph, pid: number): ProcessInspectionResult {
    if (!graph.available) return { identity: null, available: false, detail: graph.detail };
    const identity = graph.byPid.get(pid);
    return identity ? { identity, available: true } : this.inspectSafely(pid);
  }

  /** Walk a complete metadata graph: ancestors are protected, successful absence ends the chain. */
  private protectsCurrentProcess(pid: number, metadataGraph?: ProcessMetadataGraph): { protected: boolean; available: boolean; detail?: string } {
    if (metadataGraph) return this.protectsWithMetadataGraph(pid, metadataGraph);
    const seen = new Set<number>();
    const currentResult = this.inspectSafely(this.currentPid);
    if (!currentResult.available || !currentResult.identity) return {
      protected: false,
      available: false,
      detail: currentResult.detail ?? "Token Furnace identity lookup is unavailable.",
    };
    let child = currentResult.identity;
    while (child.parentPid && child.parentPid > 1) {
      const parentPid = child.parentPid;
      if (seen.has(parentPid)) return { protected: false, available: false, detail: this.generationDetail(child, parentPid, "ancestor cycle") };
      seen.add(parentPid);
      const inspected = this.inspectSafely(parentPid);
      if (!inspected.available) return { protected: false, available: false, detail: this.ancestorLookupDetail(parentPid, child, inspected.detail) };
      if (!inspected.identity) return { protected: false, available: true };
      if (!this.validGeneration(child, inspected.identity)) return { protected: false, available: false, detail: this.generationDetail(inspected.identity, parentPid, "parent start is newer than child") };
      if (parentPid === pid) return { protected: true, available: true };
      child = inspected.identity;
    }
    return { protected: false, available: true };
  }

  private protectsWithMetadataGraph(pid: number, graph: ProcessMetadataGraph): { protected: boolean; available: boolean; detail?: string } {
    if (!graph.available) return { protected: false, available: false, detail: graph.detail ?? "Process metadata graph is unavailable." };
    const currentResult = this.graphInspection(graph, this.currentPid);
    if (!currentResult.available || !currentResult.identity) return {
      protected: false,
      available: false,
      detail: currentResult.detail ?? "Token Furnace identity lookup is unavailable.",
    };
    const seen = new Set<number>([currentResult.identity.pid]);
    let child = currentResult.identity;
    while (child.parentPid && child.parentPid > 1) {
      const parentPid = child.parentPid;
      if (seen.has(parentPid)) return { protected: false, available: false, detail: this.generationDetail(child, parentPid, "ancestor cycle") };
      seen.add(parentPid);
      const inspected = this.graphInspection(graph, parentPid);
      if (!inspected.available) return { protected: false, available: false, detail: this.ancestorLookupDetail(parentPid, child, inspected.detail) };
      if (!inspected.identity) return { protected: false, available: true };
      if (!this.validGeneration(child, inspected.identity)) return { protected: false, available: false, detail: this.generationDetail(inspected.identity, parentPid, "parent start is newer than child") };
      if (parentPid === pid) return { protected: true, available: true };
      child = inspected.identity;
    }
    return { protected: false, available: true };
  }

  private validGeneration(child: ProcessIdentity, parent: ProcessIdentity): boolean {
    return parent.processStartTime <= child.processStartTime;
  }

  private ancestorLookupDetail(parentPid: number, child: ProcessIdentity, detail?: string): string {
    return `Ancestor identity lookup is unavailable at PID ${parentPid} (child PID ${child.pid}, child start ${child.processStartTime}, parent PID ${child.parentPid ?? "none"})${detail ? `: ${detail}` : "."}`;
  }

  private generationDetail(parent: ProcessIdentity, boundaryPid: number, reason: string): string {
    return `Ancestor generation is inconsistent at PID ${boundaryPid} (start ${parent.processStartTime}, parent PID ${parent.parentPid ?? "none"}): ${reason}.`;
  }

  private async waitForTerminal(target: ControlTarget): Promise<boolean> {
    const started = Date.now();
    while (true) {
      if (target.nativeState) {
        try { if (await target.nativeState()) return true; } catch { /* keep checking process ownership */ }
      }
      const inspected = this.inspectSafely(target.pid);
      if (inspected.available && !inspected.identity) return true;
      if (Date.now() - started >= this.graceMs) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, this.graceMs)));
    }
  }

  private async waitForProcessExit(target: ControlTarget, descendants: ProcessIdentity[] = []): Promise<boolean> {
    const started = Date.now();
    while (true) {
      const inspected = this.inspectSafely(target.pid);
      if (!inspected.available) return false;
      const identity = inspected.identity;
      if (identity && !sameProcessIdentity(identity, target)) return false;
      let descendantAlive = false;
      for (const descendant of descendants) {
        const currentResult = this.inspectSafely(descendant.pid);
        if (!currentResult.available) return false;
        const current = currentResult.identity;
        if (current && !sameProcessIdentity(current, descendant)) return false;
        descendantAlive ||= Boolean(current);
      }
      if (!identity && !descendantAlive) return true;
      if (Date.now() - started >= this.graceMs) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, this.graceMs))));
    }
  }

  private verifyProcessIdentity(expected: ProcessIdentity, observed?: ProcessIdentity, metadataGraph?: ProcessMetadataGraph): boolean {
    const inspected = observed ? { identity: observed, available: true } : this.inspectSafely(expected.pid);
    if (!inspected.available) return false;
    const identity = inspected.identity;
    if (!identity || !sameProcessIdentity(identity, expected)) return false;
    const protection = this.protectsCurrentProcess(expected.pid, metadataGraph);
    if (!protection.available || expected.pid === this.currentPid || protection.protected) return false;
    if (identity.ownerUid === null && !identity.ownerIdentity && !identity.ownerSid) return false;
    if (this.currentUid !== null && identity.ownerUid !== this.currentUid) return false;
    if (!this.matchesCurrentOwner(identity)) return false;
    return true;
  }

  private ownerSid(): string | null {
    if (!this.resolveCurrentOwnerSid || this.currentOwnerSidResolved) return this.currentOwnerSid;
    this.currentOwnerSidResolved = true;
    const inspected = this.inspectSafely(this.currentPid);
    if (inspected.available) this.currentOwnerSid = inspected.identity?.ownerSid ?? null;
    return this.currentOwnerSid;
  }

  private requiresVerifiedOwnerSid(): boolean {
    return process.platform === "win32" && this.resolveCurrentOwnerSid;
  }

  private matchesCurrentOwner(identity: ProcessIdentity): boolean {
    const currentOwnerSid = this.ownerSid();
    if (this.requiresVerifiedOwnerSid() && !currentOwnerSid) return false;
    if (this.currentUid !== null && identity.ownerUid !== this.currentUid) return false;
    if (this.currentOwner && identity.ownerIdentity && identity.ownerIdentity !== this.currentOwner) return false;
    if (currentOwnerSid && identity.ownerSid !== currentOwnerSid) return false;
    return this.currentUid !== null || Boolean(this.currentOwner) || Boolean(currentOwnerSid);
  }

  private ownedDescendants(target: ControlTarget, metadataGraph?: ProcessMetadataGraph): ProcessIdentity[] | null {
    if (metadataGraph && !metadataGraph.available) return null;
    const processes = metadataGraph ? [...metadataGraph.byPid.values()] : (() => {
      try { return this.listProcesses(); } catch { return null; }
    })();
    if (!processes) return null;
    const children = new Map<number, ProcessIdentity[]>();
    for (const identity of processes) {
      if (identity.parentPid === null) continue;
      const list = children.get(identity.parentPid) ?? [];
      list.push(identity);
      children.set(identity.parentPid, list);
    }
    const result: ProcessIdentity[] = [];
    const queue = [...(children.get(target.pid) ?? [])];
    while (queue.length) {
      const identity = queue.shift()!;
      const inspected = this.inspectSafely(identity.pid);
      if (!inspected.available) return null;
      const observed = inspected.identity;
      if (!observed) {
        queue.push(...(children.get(identity.pid) ?? []));
        continue;
      }
      if (!sameProcessMetadata(identity, observed)) return null;
      if (!sameProcessOwner(observed, target)) return null;
      const verified = { ...identity, ownerUid: observed.ownerUid, ownerIdentity: observed.ownerIdentity, ownerSid: observed.ownerSid, executable: identity.executable ?? observed.executable };
      if (!this.verifyProcessIdentity(verified, observed, metadataGraph)) return null;
      result.push(observed);
      queue.push(...(children.get(identity.pid) ?? []));
    }
    return result;
  }

  private inspectSafely(pid: number): ProcessInspectionResult {
    try {
      return { identity: this.inspectProcess(pid), available: true };
    } catch (error) {
      return {
        identity: null,
        available: false,
        detail: `Process identity lookup is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private finish(target: ControlTarget, outcome: ControlOutcome): ControlOutcome {
    this.writeStore(() => this.store?.recordOutcome(outcome) ?? false);
    return outcome;
  }
}

interface StoredTargetRow {
  id: string;
  source: Source;
  provider: string | null;
  account: string | null;
  model: string | null;
  pid: number;
  process_start_time: number;
  owner_uid: number | null;
  owner_identity: string | null;
  owner_sid: string | null;
  executable: string | null;
  session_id: string | null;
  native_json: string | null;
  exclusive: number;
}

/** Cross-process ownership registry. The database is the source of truth; maps only hold live adapters. */
class ControlStore {
  private readonly db: DatabaseSync;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 2500;");
    retrySqliteInitialization(() => {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS targets (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          provider TEXT,
          account TEXT,
          model TEXT,
          pid INTEGER NOT NULL,
          process_start_time INTEGER NOT NULL,
          owner_uid INTEGER,
          owner_identity TEXT,
          owner_sid TEXT,
          executable TEXT,
          session_id TEXT,
          native_json TEXT,
          exclusive INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outcomes (
          target_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          detail TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS targets_source ON targets(source);
        CREATE INDEX IF NOT EXISTS targets_identity ON targets(provider, model);
      `);
      const columns = this.db.prepare("PRAGMA table_info(targets)").all() as Array<{ name?: string }>;
      if (!columns.some((column) => column.name === "owner_sid")) addSqliteColumn(this.db, "ALTER TABLE targets ADD COLUMN owner_sid TEXT");
    });
  }

  upsertTarget(target: ControlTarget): boolean {
    return this.write(() => {
      this.db.prepare(`INSERT INTO targets
        (id, source, provider, account, model, pid, process_start_time, owner_uid, owner_identity, owner_sid, executable, session_id, native_json, exclusive, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET source=excluded.source,
        model=COALESCE(excluded.model, targets.model), pid=excluded.pid, process_start_time=excluded.process_start_time, owner_uid=COALESCE(excluded.owner_uid, targets.owner_uid),
        owner_identity=COALESCE(excluded.owner_identity, targets.owner_identity), owner_sid=COALESCE(excluded.owner_sid, targets.owner_sid), executable=COALESCE(excluded.executable, targets.executable),
        provider=COALESCE(excluded.provider, targets.provider), account=COALESCE(excluded.account, targets.account),
        session_id=COALESCE(excluded.session_id, targets.session_id), native_json=COALESCE(excluded.native_json, targets.native_json),
        exclusive=excluded.exclusive, updated_at=excluded.updated_at`).run(
        target.id, target.source, target.provider, target.account ?? null, target.model, target.pid, target.processStartTime,
        target.ownerUid, target.ownerIdentity ?? null, target.ownerSid ?? null, target.executable ?? null, target.sessionId ?? null,
        target.native ? JSON.stringify(serializableNative(target.native)) : null, target.exclusive === true ? 1 : 0, Date.now(),
      );
      return true;
    });
  }

  removeTarget(id: string): boolean {
    return this.write(() => {
      this.db.prepare("DELETE FROM targets WHERE id = ?").run(id);
      return true;
    });
  }

  readTargets(): ControlTarget[] {
    return (this.db.prepare("SELECT id, source, provider, account, model, pid, process_start_time, owner_uid, owner_identity, owner_sid, executable, session_id, native_json, exclusive FROM targets ORDER BY id").all() as unknown as StoredTargetRow[])
      .map((row) => ({
        id: row.id,
        source: row.source,
        provider: row.provider,
        account: row.account,
        model: row.model,
        pid: row.pid,
        processStartTime: row.process_start_time,
        ownerUid: row.owner_uid,
        ownerIdentity: row.owner_identity,
        ownerSid: row.owner_sid,
        executable: row.executable,
        sessionId: row.session_id,
        native: parseNative(row.native_json),
        exclusive: Boolean(row.exclusive),
      }));
  }

  recordOutcome(outcome: ControlOutcome): boolean {
    return this.write(() => {
      this.db.prepare(`INSERT INTO outcomes (target_id, status, detail, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(target_id) DO UPDATE SET status=excluded.status, detail=excluded.detail, updated_at=excluded.updated_at`)
        .run(outcome.targetId, outcome.status, outcome.detail ?? null, Date.now());
      return true;
    });
  }

  close(): void {
    this.db.close();
  }

  private write<T>(fn: () => T): T {
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* the transaction may not have started */ }
        if (attempt < 3 && /busy|locked/i.test(String(error))) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }
  }
}

function serializableNative(native: NativeTarget): NativeTarget {
  const validEnv = (value: unknown): value is string => typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value);
  const auth = native.auth && (native.auth.scheme === "basic" || native.auth.scheme === "bearer") ? {
    scheme: native.auth.scheme,
    ...(validEnv(native.auth.tokenEnv) ? { tokenEnv: native.auth.tokenEnv } : {}),
    ...(validEnv(native.auth.usernameEnv) ? { usernameEnv: native.auth.usernameEnv } : {}),
    ...(validEnv(native.auth.passwordEnv) ? { passwordEnv: native.auth.passwordEnv } : {}),
  } satisfies NativeAuth : undefined;
  return {
    kind: native.kind,
    endpoint: sanitizeEndpoint(native.endpoint),
    transport: native.transport,
    ...(auth ? { auth } : {}),
    ...(validEnv(native.authEnv) ? { authEnv: native.authEnv } : {}),
    ...(typeof native.sessionId === "string" ? { sessionId: native.sessionId } : {}),
    ...(typeof native.threadId === "string" ? { threadId: native.threadId } : {}),
    ...(typeof native.turnId === "string" ? { turnId: native.turnId } : {}),
  };
}

function sanitizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return endpoint.split(/[?#]/, 1)[0];
  }
}

function parseNative(value: string | null): NativeTarget | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<NativeTarget>;
    if ((parsed.kind !== "codex" && parsed.kind !== "opencode") || typeof parsed.endpoint !== "string" || !parsed.endpoint) return undefined;
    const transport = parsed.transport === "http" || parsed.transport === "websocket" || parsed.transport === "unix" || parsed.transport === "stdio" ? parsed.transport : undefined;
    const auth = parsed.auth && typeof parsed.auth === "object" && (parsed.auth.scheme === "basic" || parsed.auth.scheme === "bearer") ? {
      scheme: parsed.auth.scheme,
      tokenEnv: typeof parsed.auth.tokenEnv === "string" && /^[A-Z_][A-Z0-9_]*$/.test(parsed.auth.tokenEnv) ? parsed.auth.tokenEnv : undefined,
      usernameEnv: typeof parsed.auth.usernameEnv === "string" && /^[A-Z_][A-Z0-9_]*$/.test(parsed.auth.usernameEnv) ? parsed.auth.usernameEnv : undefined,
      passwordEnv: typeof parsed.auth.passwordEnv === "string" && /^[A-Z_][A-Z0-9_]*$/.test(parsed.auth.passwordEnv) ? parsed.auth.passwordEnv : undefined,
    } satisfies NativeAuth : undefined;
    return { kind: parsed.kind, endpoint: sanitizeEndpoint(parsed.endpoint), transport, auth, authEnv: typeof parsed.authEnv === "string" && /^[A-Z_][A-Z0-9_]*$/.test(parsed.authEnv) ? parsed.authEnv : undefined, sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined, threadId: typeof parsed.threadId === "string" ? parsed.threadId : undefined, turnId: typeof parsed.turnId === "string" ? parsed.turnId : undefined };
  } catch {
    return undefined;
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

function sameProcessIdentity(actual: ProcessIdentity, expected: Pick<ProcessIdentity, "pid" | "processStartTime" | "ownerUid" | "ownerIdentity" | "ownerSid">): boolean {
  return actual.pid === expected.pid && actual.processStartTime === expected.processStartTime && actual.ownerUid === expected.ownerUid &&
    (actual.ownerIdentity ?? null) === (expected.ownerIdentity ?? null) && (actual.ownerSid ?? null) === (expected.ownerSid ?? null);
}

function sameProcessMetadata(actual: ProcessIdentity, expected: ProcessIdentity): boolean {
  if (actual.pid !== expected.pid || actual.processStartTime !== expected.processStartTime || actual.parentPid !== expected.parentPid) return false;
  if (expected.executable && (!actual.executable || !sameExecutable(expected.executable, actual.executable))) return false;
  return true;
}

function sameProcessOwner(actual: ProcessIdentity, expected: ControlTarget): boolean {
  if (expected.ownerUid !== null && actual.ownerUid !== expected.ownerUid) return false;
  if (expected.ownerIdentity && actual.ownerIdentity !== expected.ownerIdentity) return false;
  if (expected.ownerSid && actual.ownerSid !== expected.ownerSid) return false;
  return expected.ownerUid !== null || Boolean(expected.ownerIdentity) || Boolean(expected.ownerSid);
}

function nativeCanceller(native: NativeTarget | undefined, env: Env): (() => Promise<boolean>) | undefined {
  if (!native?.endpoint || (native.kind === "opencode" && !native.sessionId)) return undefined;
  return async () => {
    if (native.kind === "codex") {
      const response = await codexRpc(native, env, "turn/interrupt", { threadId: native.threadId, turnId: native.turnId });
      return !response.error && response.result !== undefined;
    }
    const url = localHttpEndpoint(native.endpoint, `/session/${encodeURIComponent(native.sessionId ?? "")}/abort`);
    if (!url) return false;
    if (!await verifyOpenCodeSession(native, env)) return false;
    const statusUrl = localHttpEndpoint(native.endpoint, "/session/status");
    if (!statusUrl) return false;
    const statusResponse = await fetch(statusUrl, { headers: nativeHeaders(native, env), signal: AbortSignal.timeout(2_000) });
    if (!statusResponse.ok) return false;
    const statuses = await statusResponse.json() as Record<string, { type?: string }>;
    if (statuses[native.sessionId ?? ""]?.type !== "busy") return false;
    const response = await fetch(url, { method: "POST", headers: nativeHeaders(native, env), signal: AbortSignal.timeout(2_000) });
    return response.ok;
  };
}

async function verifyOpenCodeSession(native: NativeTarget, env: Env): Promise<boolean> {
  if (native.kind !== "opencode" || !native.sessionId) return false;
  const url = localHttpEndpoint(native.endpoint, `/session/${encodeURIComponent(native.sessionId)}`);
  if (!url) return false;
  const response = await fetch(url, { headers: nativeHeaders(native, env), signal: AbortSignal.timeout(2_000) });
  if (!response.ok) return false;
  const session = await response.json() as { id?: unknown };
  return session.id === native.sessionId;
}

function nativeStateChecker(native: NativeTarget | undefined, env: Env): (() => Promise<boolean>) | undefined {
  if (!native?.endpoint) return undefined;
  if (native.kind === "codex") {
    if (!native.threadId || !native.turnId) return undefined;
    return async () => {
      const response = await codexRpc(native, env, "thread/read", { threadId: native.threadId, includeTurns: true });
      if (response.error || !response.result || typeof response.result !== "object") return false;
      const result = response.result as { thread?: { turns?: Array<{ id?: string; status?: string }> }; turn?: { id?: string; status?: string }; status?: string };
      const turn = result.turn ?? result.thread?.turns?.find((candidate) => candidate.id === native.turnId);
      return Boolean(turn?.status && ["interrupted", "completed", "failed", "declined"].includes(turn.status)) || ["interrupted", "completed", "failed", "declined"].includes(result.status ?? "");
    };
  }
  if (!native.sessionId) return undefined;
  return async () => {
    if (!await verifyOpenCodeSession(native, env)) return false;
    const url = localHttpEndpoint(native.endpoint, "/session/status");
    if (!url) return false;
    const response = await fetch(url, { headers: nativeHeaders(native, env), signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const statuses = await response.json() as Record<string, { type?: string }>;
    const status = statuses[native.sessionId!];
    return Boolean(status && status.type !== "busy");
  };
}

function nativeHeaders(native: NativeTarget, env: Env): Record<string, string> {
  if (native.kind === "opencode") {
    const passwordEnv = native.auth?.passwordEnv ?? "OPENCODE_SERVER_PASSWORD";
    const usernameEnv = native.auth?.usernameEnv ?? "OPENCODE_SERVER_USERNAME";
    const password = safeAuthToken(env[passwordEnv]);
    if (!password) return {};
    const username = safeAuthToken(env[usernameEnv]) ?? "opencode";
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` };
  }
  const tokenEnv = native.auth?.tokenEnv ?? native.authEnv;
  const token = tokenEnv ? safeAuthToken(env[tokenEnv]) : undefined;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function safeAuthToken(value: string | undefined): string | undefined {
  return value && !/[\r\n]/.test(value) ? value : undefined;
}

interface RpcMessage {
  id?: number | string;
  result?: unknown;
  error?: unknown;
  method?: string;
  params?: unknown;
}

interface NativeWebSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

type NativeWebSocketConstructor = new (url: string) => NativeWebSocket;

async function codexRpc(native: NativeTarget, env: Env, method: string, params: Record<string, unknown>): Promise<RpcMessage> {
  const transport = native.transport ?? inferTransport(native.endpoint);
  if (transport === "websocket") return rpcOverWebSocket(native, env, method, params);
  if (transport === "unix") return rpcOverUnixSocket(native, env, method, params);
  // The stdio server is owned by the Codex CLI process and cannot be safely attached to from a
  // second process. It remains eligible for the verified exclusive-process fallback instead.
  throw new Error(`Codex ${transport} transport is not accessible for an out-of-process interrupt.`);
}

function inferTransport(endpoint: string): NativeTarget["transport"] {
  if (/^unix:\/\//i.test(endpoint)) return "unix";
  if (/^wss?:\/\//i.test(endpoint)) return "websocket";
  if (/^stdio:\/\//i.test(endpoint)) return "stdio";
  return "http";
}

function localHttpEndpoint(endpoint: string, suffix: string): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]" && url.hostname !== "::1") return null;
    return `${url.origin}${url.pathname.replace(/\/$/, "")}${suffix}`;
  } catch { return null; }
}

function rpcOverWebSocket(native: NativeTarget, env: Env, method: string, params: Record<string, unknown>): Promise<RpcMessage> {
  const tokenEnv = native.auth?.tokenEnv ?? native.authEnv;
  const token = tokenEnv ? safeAuthToken(env[tokenEnv]) : undefined;
  if (!token && !isLoopbackEndpoint(native.endpoint)) return Promise.reject(new Error("Codex remote WebSocket requires an authenticated endpoint."));
  if (token) return rpcOverNetworkSocket(native.endpoint, method, params, token, "Codex App Server WebSocket");
  return rpcOverBrowserWebSocket(native.endpoint, method, params);
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function rpcOverBrowserWebSocket(endpoint: string, method: string, params: Record<string, unknown>): Promise<RpcMessage> {
  const WebSocketImpl = (globalThis as unknown as { WebSocket?: NativeWebSocketConstructor }).WebSocket;
  if (!WebSocketImpl) return Promise.reject(new Error("Codex WebSocket transport is unavailable in this Node runtime."));
  return new Promise<RpcMessage>((resolve, reject) => {
    const socket = new WebSocketImpl(endpoint);
    let phase: "initialize" | "interrupt" = "initialize";
    const timer = setTimeout(() => { socket.close(); reject(new Error("Codex App Server RPC timed out.")); }, 2_000);
    const fail = (error: unknown) => { clearTimeout(timer); socket.close(); reject(error instanceof Error ? error : new Error(String(error))); };
    const sendInterrupt = () => {
      phase = "interrupt";
      socket.send(JSON.stringify({ id: 2, method, params }));
    };
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "token-furnace", title: "Token Furnace", version: "0.1.11" } } }));
    socket.onerror = (error) => fail(error);
    socket.onclose = () => { if (phase === "interrupt") fail(new Error("Codex App Server closed before terminal confirmation.")); };
    socket.onmessage = (event) => {
      const message = parseRpcMessage(event.data);
      if (!message) return;
      if (phase === "initialize" && message.id === 1) {
        if (message.error) return fail(new Error("Codex App Server initialize failed."));
        socket.send(JSON.stringify({ method: "initialized", params: {} }));
        sendInterrupt();
      } else if (phase === "interrupt" && message.id === 2) {
        clearTimeout(timer);
        socket.close();
        resolve(message);
      }
    };
  });
}

function rpcOverUnixSocket(native: NativeTarget, env: Env, method: string, params: Record<string, unknown>): Promise<RpcMessage> {
  const endpoint = native.endpoint;
  const socketPath = decodeURIComponent(endpoint.slice("unix://".length));
  if (!socketPath || socketPath === "/") return Promise.reject(new Error("Codex Unix transport requires an explicit socket path."));
  const tokenEnv = native.auth?.tokenEnv ?? native.authEnv;
  return rpcOverSocket(() => createConnection(socketPath), "localhost", "/", tokenEnv ? safeAuthToken(env[tokenEnv]) : undefined, method, params, "Codex Unix App Server");
}

interface NativeSocket {
  write(data: string | Buffer): boolean;
  end(): void;
  destroy(): void;
  setTimeout(timeout: number, callback: () => void): this;
  on(event: "connect" | "close", listener: () => void): this;
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
}

function rpcOverNetworkSocket(endpoint: string, method: string, params: Record<string, unknown>, token: string, label: string): Promise<RpcMessage> {
  let url: URL;
  try { url = new URL(endpoint); } catch { return Promise.reject(new Error(`${label} endpoint is invalid.`)); }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return Promise.reject(new Error(`${label} requires ws:// or wss://.`));
  const port = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
  const socket = url.protocol === "wss:"
    ? connectTls({ host: url.hostname, port, servername: url.hostname })
    : createConnection({ host: url.hostname, port });
  return rpcOverSocket(() => socket, url.host, `${url.pathname || "/"}${url.search}`, token, method, params, label);
}

function rpcOverSocket(createSocket: () => NativeSocket, host: string, requestPath: string, token: string | undefined, method: string, params: Record<string, unknown>, label: string): Promise<RpcMessage> {
  return new Promise<RpcMessage>((resolve, reject) => {
    const socket = createSocket();
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    let phase: "initialize" | "interrupt" = "initialize";
    const key = randomBytes(16).toString("base64");
    let settled = false;
    const timer = setTimeout(() => { fail(new Error(`${label} RPC timed out.`)); }, 2_000);
    const finish = (error?: unknown, response?: RpcMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(response!);
    };
    const fail = (error: unknown) => finish(error);
    const sendRpc = (message: Record<string, unknown>) => socket.write(webSocketFrame(JSON.stringify(message)));
    const sendInterrupt = () => {
      phase = "interrupt";
      sendRpc({ id: 2, method, params });
    };
    const handle = (message: RpcMessage) => {
      if (phase === "initialize" && message.id === 1) {
        if (message.error) return fail(new Error(`${label} initialize failed.`));
        sendRpc({ method: "initialized", params: {} });
        sendInterrupt();
      } else if (phase === "interrupt" && message.id === 2) {
        finish(undefined, message);
      }
    };
    socket.setTimeout(2_000, () => fail(new Error(`${label} RPC timed out.`)));
    socket.on("error", fail);
    socket.on("close", () => { if (!settled) fail(new Error(`${label} closed before terminal confirmation.`)); });
    socket.on("connect", () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${token ? `Authorization: Bearer ${token}\r\n` : ""}\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString("utf8");
        if (!/^HTTP\/1\.[01] 101 /m.test(header)) return fail(new Error(`${label} rejected WebSocket upgrade.`));
        handshaken = true;
        buffer = buffer.subarray(end + 4);
        sendRpc({ id: 1, method: "initialize", params: { clientInfo: { name: "token-furnace", title: "Token Furnace", version: "0.1.11" } } });
      }
      while (handshaken) {
        const frame = readWebSocketFrame(buffer);
        if (!frame) return;
        buffer = Buffer.from(frame.rest);
        if (frame.opcode === 8) return fail(new Error(`${label} closed before terminal confirmation.`));
        if (frame.opcode === 9) { socket.write(webSocketFrame(frame.payload.toString("binary"), 10)); continue; }
        if (frame.opcode === 1) {
          const message = parseRpcMessage(frame.payload.toString("utf8"));
          if (message) handle(message);
        }
      }
    });
  });
}

function parseRpcMessage(value: unknown): RpcMessage | null {
  try {
    const text = typeof value === "string" ? value : value instanceof ArrayBuffer ? Buffer.from(value).toString("utf8") : "";
    const message = JSON.parse(text) as RpcMessage;
    return message && typeof message === "object" ? message : null;
  } catch { return null; }
}

function webSocketFrame(value: string, opcode = 1): Buffer {
  const payload = Buffer.from(value, "utf8");
  const mask = randomBytes(4);
  const header = payload.length < 126 ? Buffer.alloc(2) : payload.length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (payload.length < 126) header[1] = 0x80 | payload.length;
  else if (payload.length < 65_536) { header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, payload]);
}

function readWebSocketFrame(buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (buffer.length < 10) return null; const wide = buffer.readBigUInt64BE(2); if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Codex WebSocket frame is too large."); length = Number(wide); offset = 10; }
  const mask = masked ? 4 : 0;
  if (buffer.length < offset + mask + length) return null;
  const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += mask;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}

function discoverNativeProcesses(list: () => ProcessIdentity[], inspect: (pid: number) => ProcessIdentity | null, currentPid: number): { targets: ControlTarget[]; unverified: ControlPreview["unverified"] } {
  const targets: ControlTarget[] = [];
  const unverified: ControlPreview["unverified"] = [];
  const listed = list();
  const byPid = new Map(listed.map((identity) => [identity.pid, identity]));
  for (const identity of listed) {
    if (identity.pid === currentPid) continue;
    const identitySource = sourceForIdentity(identity);
    const env = identitySource || isShellExecutable(identity.executable ?? "") ? readProcEnv(identity.pid) : {};
    const markedSource = env.TOKEN_FURNACE_SOURCE;
    const source = validSource(markedSource) ? markedSource : identitySource;
    if (!source) continue;
    const owner = resolveNativeProcess(identity, source, inspect, byPid);
    if (markedSource === "claude" || markedSource === "codex" || markedSource === "opencode") {
      if (owner) {
        const verifiedOwner = inspect(owner.pid);
        if (verifiedOwner) targets.push(targetFromProcess(verifiedOwner, source, { ...env, ...readProcEnv(verifiedOwner.pid) }));
        else unverified.push({
          id: `unmanaged:${source}:${identity.pid}:${identity.processStartTime}`,
          source,
          provider: null,
          model: null,
          detail: `${source} owning runtime PID ${owner.pid} is no longer discoverable for ownership verification.`,
        });
      }
      else unverified.push({
        id: `unmanaged:${source}:${identity.pid}:${identity.processStartTime}`,
        source,
        provider: null,
        model: null,
        detail: `${source} label was found on PID ${identity.pid}, but its owning native runtime executable is unresolved.`,
      });
    } else {
      unverified.push({
        id: `unmanaged:${source}:${identity.pid}:${identity.processStartTime}`,
        source,
        provider: null,
        model: null,
        detail: `Unmanaged ${source} runtime discovered at PID ${identity.pid}; native hook/session ownership is unresolved.`,
      });
    }
  }
  return { targets, unverified };
}

function resolveNativeProcess(start: ProcessIdentity, source: Source, inspect: (pid: number) => ProcessIdentity | null, listed: Map<number, ProcessIdentity> = new Map()): ProcessIdentity | null {
  const seen = new Set<number>();
  let current: ProcessIdentity | null = start;
  while (current && current.pid > 1 && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (sourceForIdentity(current) === source && !isShellExecutable(current.executable ?? "")) return current;
    current = current.parentPid ? listed.get(current.parentPid) ?? inspect(current.parentPid) : null;
  }
  return null;
}

function targetFromProcess(identity: ProcessIdentity, source: Source, env: Record<string, string>): ControlTarget {
  return {
    id: env.TOKEN_FURNACE_SESSION_ID || `${source}:${identity.pid}:${identity.processStartTime}`,
    source,
    provider: env.TOKEN_FURNACE_PROVIDER || null,
    account: env.TOKEN_FURNACE_ACCOUNT || null,
    model: env.TOKEN_FURNACE_MODEL || null,
    pid: identity.pid,
    processStartTime: identity.processStartTime,
    ownerUid: identity.ownerUid,
    ownerIdentity: identity.ownerIdentity,
    ownerSid: identity.ownerSid,
    executable: identity.executable,
    sessionId: env.TOKEN_FURNACE_NATIVE_SESSION || null,
    native: env.TOKEN_FURNACE_NATIVE_ENDPOINT ? {
      kind: source === "opencode" ? "opencode" : "codex",
      endpoint: env.TOKEN_FURNACE_NATIVE_ENDPOINT,
      transport: env.TOKEN_FURNACE_NATIVE_TRANSPORT as NativeTarget["transport"],
      auth: source === "opencode"
        ? { scheme: "basic", usernameEnv: env.TOKEN_FURNACE_NATIVE_USERNAME_ENV || "OPENCODE_SERVER_USERNAME", passwordEnv: env.TOKEN_FURNACE_NATIVE_PASSWORD_ENV || "OPENCODE_SERVER_PASSWORD" }
        : env.TOKEN_FURNACE_NATIVE_AUTH_ENV ? { scheme: "bearer", tokenEnv: env.TOKEN_FURNACE_NATIVE_AUTH_ENV } : undefined,
      authEnv: env.TOKEN_FURNACE_NATIVE_AUTH_ENV,
      sessionId: env.TOKEN_FURNACE_NATIVE_SESSION,
      threadId: env.TOKEN_FURNACE_NATIVE_THREAD,
      turnId: env.TOKEN_FURNACE_NATIVE_TURN,
    } : undefined,
    exclusive: env.TOKEN_FURNACE_EXCLUSIVE === "1",
  };
}

function validSource(value: string | undefined): value is Source {
  return value === "claude" || value === "codex" || value === "opencode";
}

function sourceForExecutable(executable: string | null | undefined): Source | null {
  const name = (executable ?? "").split(/[\\/]/).pop()?.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, "") ?? "";
  if (name === "claude" || name.startsWith("claude-")) return "claude";
  if (name === "codex" || name.startsWith("codex-")) return "codex";
  if (name === "opencode" || name.startsWith("opencode-")) return "opencode";
  return null;
}

function sourceForIdentity(identity: ProcessIdentity): Source | null {
  return sourceForExecutable(identity.executable) ?? sourceForCommandLine(identity.commandLine);
}

function sourceForCommandLine(commandLine: string | null | undefined): Source | null {
  const value = commandLine ?? "";
  for (const source of ["claude", "codex", "opencode"] as const) {
    if (new RegExp(`(?:^|[\\\\/\\s"'])${source}(?:\\.exe)?(?:[\\s\\-/'"]|$)`, "i").test(value)) return source;
  }
  return null;
}

function isShellExecutable(executable: string): boolean {
  const name = executable.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return ["sh", "bash", "zsh", "fish", "dash", "ksh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(name);
}

function readProcEnv(pid: number): Record<string, string> {
  try {
    const result: Record<string, string> = {};
    const text = process.platform === "darwin"
      ? execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      : readFileSync(`/proc/${pid}/environ`).toString();
    for (const entry of text.split("\0")) {
      const split = entry.indexOf("=");
      if (split > 0 && entry.startsWith("TOKEN_FURNACE_")) result[entry.slice(0, split)] = entry.slice(split + 1);
    }
    if (process.platform === "darwin") {
      for (const match of text.matchAll(/(?:^|\s)(TOKEN_FURNACE_[A-Z0-9_]+)=([^\s]+)/g)) result[match[1]] = match[2];
    }
    return result;
  } catch { return {}; }
}

function readProcExecutable(pid: number): string | null {
  try { return realpathSync(`/proc/${pid}/exe`); } catch { return null; }
}

function readProcCommandLine(pid: number): string | null {
  try { return readFileSync(`/proc/${pid}/cmdline`).toString().replaceAll("\0", " ").trim() || null; } catch { return null; }
}

function isMissingProcessError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function inspectProcess(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return inspectWindowsProcess(pid);
  if (process.platform === "darwin") return inspectPsProcess(pid);
  if (!existsSync("/proc")) throw new Error("Linux process table /proc is unavailable.");
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) throw new Error(`Linux process ${pid} has malformed stat data.`);
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const parentPid = Number(fields[1]);
    const processStartTime = Number(fields[19]);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    if (!Number.isFinite(parentPid) || !Number.isFinite(processStartTime) || uid === undefined) throw new Error(`Linux process ${pid} has malformed identity data.`);
    return { pid, processStartTime, ownerUid: Number(uid), parentPid, executable: readProcExecutable(pid), commandLine: readProcCommandLine(pid) };
  } catch (error) {
    if (isMissingProcessError(error)) return null;
    throw new Error(`Linux process lookup failed for PID ${pid}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function listProcessIdentities(): ProcessIdentity[] {
  if (process.platform === "win32") return listWindowsProcesses(false, false);
  if (process.platform === "darwin") return listPsProcesses();
  if (!existsSync("/proc")) throw new Error("Linux process table /proc is unavailable.");
  return readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number).map(inspectProcess).filter((value): value is ProcessIdentity => value !== null);
}

function listNativeProcessIdentities(): ProcessIdentity[] {
  if (process.platform === "win32") return listWindowsProcesses(false, false);
  return listProcessIdentities();
}

function inspectPsProcess(pid: number): ProcessIdentity | null {
  const identityOutput = runPsQuery(["-p", String(pid), "-o", "pid=,ppid=,uid=,lstart=,comm="], pid);
  if (!identityOutput.trim()) return null;
  const commandOutput = runPsQuery(["-p", String(pid), "-o", "pid=,command="], pid);
  if (!commandOutput.trim()) return null;
  const rows = parsePsProcesses(identityOutput, commandOutput);
  if (rows.length !== 1) throw new Error(`macOS process ${pid} returned malformed identity data.`);
  return rows[0] ?? null;
}

function listPsProcesses(): ProcessIdentity[] {
  const identityOutput = runPsQuery(["-axo", "pid=,ppid=,uid=,lstart=,comm="]);
  const commandOutput = runPsQuery(["-axo", "pid=,command="]);
  return parsePsProcesses(identityOutput, commandOutput);
}

function runPsQuery(args: string[], missingPid?: number): string {
  try {
    return execFileSync("ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const result = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    if (missingPid !== undefined && result.status === 1 && !String(result.stdout ?? "") && !String(result.stderr ?? "")) return "";
    throw new Error(`macOS process query failed${missingPid === undefined ? "" : ` for PID ${missingPid}`}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parsePsProcesses(identityOutput: string, commandOutput: string): ProcessIdentity[] {
  const commands = new Map<number, string | null>();
  for (const rawLine of commandOutput.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const match = /^\s*(\d+)(?:\s+(.*))?$/.exec(line);
    if (!match) throw new Error("macOS process command output is malformed.");
    commands.set(Number(match[1]), match[2]?.trim() || null);
  }
  return identityOutput.split(/\r?\n/).flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!line) return [];
    const identity = parsePsLine(line);
    if (!identity) throw new Error("macOS process identity output is malformed.");
    return [{ ...identity, commandLine: commands.get(identity.pid) ?? null }];
  });
}

function parsePsLine(line: string): ProcessIdentity | null {
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line);
  if (!match) return null;
  const processStartTime = Date.parse(match[4].trim());
  if (!Number.isFinite(processStartTime)) return null;
  return { pid: Number(match[1]), parentPid: Number(match[2]), ownerUid: Number(match[3]), processStartTime, executable: match[5].trim(), commandLine: null };
}

function inspectWindowsProcess(pid: number): ProcessIdentity | null {
  const script = windowsProcessScript(`Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}'`);
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return parseWindowsOutput(output)[0] ?? null;
}

function listWindowsProcesses(nativeOnly: boolean, includeOwners = true): ProcessIdentity[] {
  const script = windowsProcessScript("Get-CimInstance Win32_Process", nativeOnly, includeOwners);
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return parseWindowsOutput(output);
}

function windowsProcessScript(query: string, nativeOnly = false, includeOwners = true): string {
  const filter = nativeOnly ? " | Where-Object { $_.ExecutablePath -match '(?i)claude|codex|opencode' -or $_.CommandLine -match '(?i)claude|codex|opencode' }" : "";
  const actionable = `${query}${filter} | Where-Object { [int]$_.ProcessId -gt 0 }`;
  const owner = includeOwners
    ? "$owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction Stop; $sid=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop; if([int]$owner.ReturnValue -ne 0 -or [int]$sid.ReturnValue -ne 0 -or !$sid.Sid){ throw \"CIM owner lookup failed for PID $($_.ProcessId).\" };"
    : "$owner=$null; $sid=$null;";
  return `$ErrorActionPreference='Stop'; $rows=@(${actionable} | ForEach-Object { if(-not $_.CreationDate){ throw \"CIM process start lookup failed for PID $($_.ProcessId).\" }; ${owner} [pscustomobject]@{ ProcessId=[int]$_.ProcessId; ParentProcessId=[int]$_.ParentProcessId; StartTime=[long]((([DateTime]$_.CreationDate).ToUniversalTime().ToFileTimeUtc()/10000)-11644473600000); ExecutablePath=$_.ExecutablePath; Domain=$owner.Domain; User=$owner.User; Sid=$sid.Sid; CommandLine=$_.CommandLine } }); $rows | ConvertTo-Json -Compress`;
}

function parseWindowsOutput(output: string): ProcessIdentity[] {
  if (!output.trim() || output.trim() === "[]") return [];
  const parsed = JSON.parse(output) as WindowsProcessRecord | WindowsProcessRecord[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (!rows.length) return [];
  return rows.map((row) => {
    const parsedRow = parseWindowsRecord(row);
    if (!parsedRow) throw new Error("Windows process query returned malformed identity data.");
    return parsedRow;
  });
}

interface WindowsProcessRecord {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  StartTime?: unknown;
  ExecutablePath?: unknown;
  Domain?: unknown;
  User?: unknown;
  Sid?: unknown;
  CommandLine?: unknown;
}

function parseWindowsRecord(row: WindowsProcessRecord): ProcessIdentity | null {
  const pid = Number(row.ProcessId);
  const parentPid = Number(row.ParentProcessId);
  const processStartTime = Number(row.StartTime);
  if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || !Number.isFinite(processStartTime) || processStartTime <= 0) return null;
  const domain = typeof row.Domain === "string" ? row.Domain : "";
  const user = typeof row.User === "string" ? row.User : "";
  const ownerIdentity = domain && user ? `${domain}\\${user}` : user || null;
  return {
    pid,
    parentPid,
    ownerUid: null,
    ownerIdentity,
    ownerSid: typeof row.Sid === "string" ? row.Sid : null,
    processStartTime,
    executable: typeof row.ExecutablePath === "string" ? row.ExecutablePath : null,
    commandLine: typeof row.CommandLine === "string" ? row.CommandLine : null,
  };
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

function terminateProcess(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    process.kill(pid, signal);
    return;
  }
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") args.push("/F");
  execFileSync("taskkill.exe", args, { stdio: "ignore" });
}

export function controlIdentity(target: ControlTarget): BudgetIdentity {
  return { source: target.source, provider: target.provider, model: target.model };
}
