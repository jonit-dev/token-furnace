import { readFileSync } from "node:fs";
import type { Source } from "../core/model";
import { canonicalIdentity, policyMatches, type BudgetIdentity, type BudgetScope } from "../core/budgets";

export interface ProcessIdentity {
  pid: number;
  processStartTime: number;
  ownerUid: number | null;
  parentPid: number | null;
}

export interface ControlTarget {
  id: string;
  source: Source;
  provider: string | null;
  model: string | null;
  pid: number;
  processStartTime: number;
  ownerUid: number | null;
  nativeCancel?: () => Promise<boolean>;
}

export interface ControlOutcome {
  targetId: string;
  status: "requested" | "cancelled" | "terminated" | "unresolved" | "failed";
  detail?: string;
}

export interface AgentControlOptions {
  inspect?: (pid: number) => ProcessIdentity | null;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  currentUid?: number | null;
  currentPid?: number;
}

/** Ownership-aware local control registry. Unregistered or unverifiable work is never signalled. */
export class AgentControl {
  private readonly targets = new Map<string, ControlTarget>();
  private readonly inspectProcess: (pid: number) => ProcessIdentity | null;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly currentUid: number | null;
  private readonly currentPid: number;

  constructor(options: AgentControlOptions = {}) {
    this.inspectProcess = options.inspect ?? inspectProcess;
    this.signalProcess = options.signal ?? ((pid, signal) => process.kill(pid, signal));
    this.currentUid = options.currentUid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : options.currentUid;
    this.currentPid = options.currentPid ?? process.pid;
  }

  register(target: ControlTarget): boolean {
    if (!target.id || !Number.isInteger(target.pid) || target.pid <= 0 || target.pid === this.currentPid) return false;
    this.targets.set(target.id, { ...target, provider: canonicalIdentity(target.provider), model: canonicalIdentity(target.model) });
    return true;
  }

  unregister(id: string): void {
    this.targets.delete(id);
  }

  discover(scope: BudgetScope): ControlTarget[] {
    return [...this.targets.values()].filter((target) => policyMatches({
      scope, mode: "off", unit: "tokens-total", limit: null, deadline: null,
    }, {
      source: target.source,
      provider: target.provider,
      model: target.model,
    }));
  }

  async cancel(target: ControlTarget, force = false): Promise<ControlOutcome> {
    const identity = this.inspectProcess(target.pid);
    if (!identity) return { targetId: target.id, status: "unresolved", detail: "Process is no longer discoverable." };
    if (target.pid === this.currentPid || this.isAncestor(identity.parentPid)) {
      return { targetId: target.id, status: "unresolved", detail: "Refused to target Token Furnace or an ancestor." };
    }
    if (identity.processStartTime !== target.processStartTime || identity.ownerUid !== target.ownerUid) {
      return { targetId: target.id, status: "unresolved", detail: "Process ownership or start identity changed." };
    }
    if (this.currentUid !== null && identity.ownerUid !== this.currentUid) {
      return { targetId: target.id, status: "unresolved", detail: "Process is not owned by the current user." };
    }
    if (!force && target.nativeCancel) {
      try {
        if (await target.nativeCancel()) return { targetId: target.id, status: "cancelled" };
      } catch (error) {
        return { targetId: target.id, status: "failed", detail: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      this.signalProcess(target.pid, force ? "SIGKILL" : "SIGTERM");
      return { targetId: target.id, status: force ? "terminated" : "requested" };
    } catch (error) {
      return { targetId: target.id, status: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(scope: BudgetScope, force = false): Promise<ControlOutcome[]> {
    const targets = this.discover(scope);
    const outcomes: ControlOutcome[] = [];
    for (const target of targets) outcomes.push(await this.cancel(target, force));
    return outcomes;
  }

  private isAncestor(parentPid: number | null): boolean {
    const seen = new Set<number>();
    let current = parentPid;
    while (current && current > 1 && !seen.has(current)) {
      if (current === this.currentPid) return true;
      seen.add(current);
      current = this.inspectProcess(current)?.parentPid ?? null;
    }
    return false;
  }
}

function inspectProcess(pid: number): ProcessIdentity | null {
  if (process.platform === "win32") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const parentPid = Number(fields[1]);
    const processStartTime = Number(fields[19]);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    if (!Number.isFinite(parentPid) || !Number.isFinite(processStartTime) || uid === undefined) return null;
    return { pid, processStartTime, ownerUid: Number(uid), parentPid };
  } catch {
    return null;
  }
}

export function controlIdentity(target: ControlTarget): BudgetIdentity {
  return { source: target.source, provider: target.provider, model: target.model };
}
