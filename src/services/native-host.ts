import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentControl, MANAGED_ENDPOINT_PREFIX, type ControlTarget, type NativeRequest, type ProcessIdentity } from "./agent-control";
import type { Env } from "../sources/agent-source";

export interface ManagedThread {
  prompt: string;
  model?: string;
  provider?: string;
}

export interface ManagedNativeOptions {
  source: "claude" | "codex";
  prompt: string;
  model?: string;
  /** Codex model provider for the first thread (for example `openai` or `openrouter`). */
  provider?: string;
  /** Additional Codex threads in the same app-server, each with its own model. */
  threads?: ManagedThread[];
  cwd?: string;
  /** Extra native CLI arguments, passed through unchanged (permissions, config overrides). */
  nativeArgs?: string[];
  env: Env;
  control: AgentControl;
  write?: (line: string) => void;
}

/**
 * Runs one real installed native host whose stdio this process owns. Every session, Claude task
 * and Codex thread is registered with its actual native IDs and models; Token Furnace stops reach
 * it through control-store requests that this host relays as native `stop_task`, `interrupt` or
 * `turn/interrupt`. Terminal states are recorded only from the native host's own events.
 */
export async function runManagedNative(options: ManagedNativeOptions): Promise<number> {
  return options.source === "codex" ? runCodexHost(options) : runClaudeHost(options);
}

interface HostContext {
  hostId: string;
  endpoint: string;
  identity: ProcessIdentity;
  control: AgentControl;
  emit: (event: Record<string, unknown>) => void;
}

function baseTarget(context: HostContext, source: "claude" | "codex", id: string): ControlTarget {
  const { identity } = context;
  return {
    id, source, provider: null, model: null,
    pid: identity.pid, processStartTime: identity.processStartTime,
    ownerUid: identity.ownerUid, ownerIdentity: identity.ownerIdentity, ownerSid: identity.ownerSid,
    executable: identity.executable,
  };
}

async function startHost(options: ManagedNativeOptions, command: string, args: string[]): Promise<{ child: ChildProcess; context: HostContext } | { code: number }> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "inherit"] });
  const forward = (signal: NodeJS.Signals) => () => { if (child.exitCode === null) child.kill(signal); };
  process.once("SIGINT", forward("SIGINT"));
  process.once("SIGTERM", forward("SIGTERM"));
  const identity = await waitForIdentity(options.control, child);
  if (!identity) {
    child.kill("SIGTERM");
    process.stderr.write(`Token Furnace could not verify the ${options.source} host process identity.\n`);
    return { code: await waitForChild(child) || 1 };
  }
  const hostId = randomUUID();
  const emit = (event: Record<string, unknown>) => write(JSON.stringify({ type: "token_furnace", hostId, ...event }));
  return { child, context: { hostId, endpoint: `${MANAGED_ENDPOINT_PREFIX}${hostId}`, identity, control: options.control, emit } };
}

function register(context: HostContext, target: ControlTarget): void {
  if (!context.control.register(target)) throw new Error(`Token Furnace could not register managed target ${target.id}.`);
  context.emit({ event: "registered", targetId: target.id, source: target.source, provider: target.provider, model: target.model, sessionId: target.sessionId ?? null, native: target.native ?? null, pid: target.pid });
}

function pollRequests(context: HostContext, handle: (request: NativeRequest) => void): () => void {
  const timer = setInterval(() => {
    for (const request of context.control.nativeRequests(context.hostId)) {
      context.control.resolveNativeRequest(request.targetId, "sent", "Relayed to the native host.");
      handle(request);
    }
  }, 200);
  return () => clearInterval(timer);
}

function lines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  let buffer = "";
  stream?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line) onLine(line);
    }
  });
}

// ---------------------------------------------------------------- Claude

/** Upstream provider configured for this Claude process: env given to the host, then user settings `env`. */
export function claudeUpstreamProvider(env: Env): string | null {
  let settingsEnv: Record<string, unknown> = {};
  try {
    const dir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { env?: Record<string, unknown> };
    if (settings.env && typeof settings.env === "object") settingsEnv = settings.env;
  } catch { /* no user settings */ }
  const value = (name: string): string | undefined => {
    const fromSettings = settingsEnv[name];
    return typeof fromSettings === "string" && fromSettings ? fromSettings : env[name] || undefined;
  };
  if (/^(1|true)$/i.test(value("CLAUDE_CODE_USE_BEDROCK") ?? "")) return "amazon-bedrock";
  if (/^(1|true)$/i.test(value("CLAUDE_CODE_USE_VERTEX") ?? "")) return "google-vertex";
  const base = value("ANTHROPIC_BASE_URL");
  if (!base) return "anthropic";
  let host: string;
  try { host = new URL(base).hostname.toLowerCase(); } catch { return null; }
  if (host === "api.anthropic.com") return "anthropic";
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  return null; // An unknown custom upstream stays unresolved rather than guessed.
}

interface ClaudeTask { taskId: string; toolUseId: string | null; targetId: string; model: string | null; done: boolean }

async function runClaudeHost(options: ManagedNativeOptions): Promise<number> {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    ...(options.model ? ["--model", options.model] : []), ...(options.nativeArgs ?? [])];
  const started = await startHost(options, "claude", args);
  if ("code" in started) return started.code;
  const { child, context } = started;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const provider = claudeUpstreamProvider({ ...process.env, ...options.env });
  const mainId = `managed:claude:${context.hostId}`;
  let sessionId: string | null = null;
  let mainModel: string | null = null;
  let resultSeen = false;
  let stdinOpen = true;
  let requestSeq = 0;
  const tasks = new Map<string, ClaudeTask>();
  const pendingControl = new Map<string, string>(); // control request id -> target id
  const mainRequested = { value: false };
  const send = (message: Record<string, unknown>) => { if (stdinOpen) child.stdin?.write(`${JSON.stringify(message)}\n`); };
  const control = (targetId: string, request: Record<string, unknown>) => {
    const requestId = `tf-${++requestSeq}`;
    pendingControl.set(requestId, targetId);
    send({ type: "control_request", request_id: requestId, request });
  };
  const native = (taskId?: string) => ({ kind: "claude" as const, endpoint: context.endpoint, transport: "store" as const, ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}) });
  const registerMain = () => register(context, { ...baseTarget(context, "claude", mainId), provider, model: mainModel, sessionId, native: native(), exclusive: true });
  const registerTask = (task: ClaudeTask) => register(context, { ...baseTarget(context, "claude", task.targetId), provider, model: task.model, sessionId, native: native(task.taskId) });
  const running = () => [...tasks.values()].filter((task) => !task.done);
  const maybeFinish = () => {
    if (resultSeen && running().length === 0 && stdinOpen) { stdinOpen = false; child.stdin?.end(); }
  };

  registerMain();
  const stopPolling = pollRequests(context, (request) => {
    if (request.targetId === mainId) {
      mainRequested.value = true;
      control(mainId, { subtype: "interrupt" });
      for (const task of running()) control(task.targetId, { subtype: "stop_task", task_id: task.taskId });
      return;
    }
    const task = [...tasks.values()].find((candidate) => candidate.targetId === request.targetId);
    if (!task) context.control.resolveNativeRequest(request.targetId, "failed", "Target is not owned by this Claude host.");
    else if (task.done) context.control.resolveNativeRequest(request.targetId, "completed", "Native task had already finished.");
    else control(task.targetId, { subtype: "stop_task", task_id: task.taskId });
  });

  send({ type: "user", message: { role: "user", content: options.prompt } });

  lines(child.stdout, (line) => {
    write(line);
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    if (event.type === "system" && subtype === "init") {
      sessionId = stringValue(event.session_id) ?? sessionId;
      mainModel = stringValue(event.model) ?? mainModel;
      registerMain();
    } else if (event.type === "system" && subtype === "task_started") {
      const taskId = stringValue(event.task_id);
      if (!taskId || tasks.has(taskId)) return;
      const task: ClaudeTask = { taskId, toolUseId: stringValue(event.tool_use_id), targetId: `${mainId}:task:${taskId}`, model: null, done: false };
      tasks.set(taskId, task);
      // Only agent tasks run model requests; shell tasks are tracked for completion but stop with their owner.
      if (stringValue(event.subagent_type)) registerTask(task);
    } else if (event.type === "system" && subtype === "task_notification") {
      const task = tasks.get(stringValue(event.task_id) ?? "");
      if (!task || task.done) return;
      task.done = true;
      const status = event.status === "stopped" ? "stopped" : event.status === "completed" ? "completed" : "failed";
      context.control.resolveNativeRequest(task.targetId, status, `Native task_notification status=${String(event.status)}.`);
      context.control.unregister(task.targetId);
      context.emit({ event: "task-finished", targetId: task.targetId, taskId: task.taskId, status: event.status });
      maybeFinish();
    } else if (event.type === "assistant") {
      const message = recordValue(event.message);
      const model = stringValue(message?.model);
      const parent = stringValue(event.parent_tool_use_id);
      if (!model) return;
      if (!parent) {
        if (model !== mainModel) { mainModel = model; registerMain(); }
        return;
      }
      // A child's identity is the model its own native assistant messages report, never the parent's.
      const task = [...tasks.values()].find((candidate) => candidate.toolUseId === parent);
      if (task && task.model !== model) { task.model = model; registerTask(task); }
    } else if (event.type === "control_response") {
      const response = recordValue(event.response);
      const targetId = pendingControl.get(stringValue(response?.request_id) ?? "");
      if (targetId && response?.subtype === "error") {
        context.control.resolveNativeRequest(targetId, "failed", `Native control error: ${String(response.error ?? "unknown")}`);
      }
    } else if (event.type === "result") {
      resultSeen = true;
      if (mainRequested.value) for (const task of running()) control(task.targetId, { subtype: "stop_task", task_id: task.taskId });
      maybeFinish();
    }
  });

  const code = await waitForChild(child);
  stopPolling();
  // Process exit is verified termination for anything still bound to this host.
  for (const targetId of [mainId, ...[...tasks.values()].filter((task) => !task.done).map((task) => task.targetId)]) {
    context.control.resolveNativeRequest(targetId, "stopped", "Native host process exited."); // no-op without a request
    context.control.unregister(targetId);
  }
  context.emit({ event: "exit", code });
  return code;
}

// ---------------------------------------------------------------- Codex

interface CodexThread { threadId: string; targetId: string; turnId: string | null; done: boolean; root: boolean }

async function runCodexHost(options: ManagedNativeOptions): Promise<number> {
  const started = await startHost(options, "codex", ["app-server", ...(options.nativeArgs ?? [])]);
  if ("code" in started) return started.code;
  const { child, context } = started;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const rpc = new StdioRpc(child);
  const threads = new Map<string, CodexThread>();
  let failed = false;
  const targetFor = (thread: Record<string, unknown>, root: boolean): CodexThread | null => {
    const threadId = stringValue(thread.id);
    if (!threadId) return null;
    const entry = threads.get(threadId) ?? { threadId, targetId: `managed:codex:${context.hostId}:${threadId}`, turnId: null, done: false, root };
    threads.set(threadId, entry);
    register(context, {
      ...baseTarget(context, "codex", entry.targetId),
      provider: stringValue(thread.modelProvider), model: stringValue(thread.model), sessionId: threadId,
      native: { kind: "codex", endpoint: context.endpoint, transport: "store", sessionId: threadId, threadId, ...(entry.turnId ? { turnId: entry.turnId } : {}) },
    });
    return entry;
  };
  const settle = () => {
    if ([...threads.values()].some((thread) => thread.root) && [...threads.values()].every((thread) => thread.done)) rpc.close();
  };

  rpc.onNotification = (method, params) => {
    write(JSON.stringify({ method, params }));
    if (method === "thread/started") {
      const thread = recordValue(params.thread);
      const parent = stringValue(thread?.parentThreadId);
      if (thread && parent && threads.has(parent)) targetFor(thread, false);
    } else if (method === "turn/started") {
      const entry = threads.get(stringValue(params.threadId) ?? "");
      const turnId = stringValue(recordValue(params.turn)?.id);
      if (entry && turnId) {
        entry.turnId = turnId;
        entry.done = false;
        void refreshThread(rpc, entry, targetFor);
      }
    } else if (method === "turn/completed") {
      const entry = threads.get(stringValue(params.threadId) ?? "");
      const turn = recordValue(params.turn);
      if (!entry || stringValue(turn?.id) !== entry.turnId) return;
      entry.done = true;
      const status = turn?.status === "interrupted" ? "stopped" : turn?.status === "completed" ? "completed" : "failed";
      if (status === "failed" && entry.root) failed = true;
      context.control.resolveNativeRequest(entry.targetId, status, `Native turn/completed status=${String(turn?.status)}.`);
      context.control.unregister(entry.targetId);
      context.emit({ event: "turn-finished", targetId: entry.targetId, threadId: entry.threadId, status: turn?.status });
      settle();
    }
  };

  const stopPolling = pollRequests(context, (request) => {
    const entry = [...threads.values()].find((candidate) => candidate.targetId === request.targetId);
    if (!entry) { context.control.resolveNativeRequest(request.targetId, "failed", "Target is not owned by this Codex host."); return; }
    if (entry.done) { context.control.resolveNativeRequest(request.targetId, "completed", "Native turn had already finished."); return; }
    if (!entry.turnId) { context.control.resolveNativeRequest(request.targetId, "failed", "No active native turn to interrupt."); return; }
    rpc.request("turn/interrupt", { threadId: entry.threadId, turnId: entry.turnId }).then((response) => {
      if (response.error) context.control.resolveNativeRequest(request.targetId, "failed", `Native turn/interrupt error: ${JSON.stringify(response.error)}`);
    }, (error: unknown) => context.control.resolveNativeRequest(request.targetId, "failed", String(error)));
  });

  try {
    const initialize = await rpc.request("initialize", { clientInfo: { name: "token-furnace", title: "Token Furnace managed host", version: "1" } });
    if (initialize.error) throw new Error(`Codex app-server initialize failed: ${JSON.stringify(initialize.error)}`);
    rpc.notify("initialized", {});
    const specs: ManagedThread[] = [{ prompt: options.prompt, model: options.model, provider: options.provider }, ...(options.threads ?? [])];
    for (const spec of specs) {
      const response = await rpc.request("thread/start", {
        cwd: options.cwd ?? process.cwd(), ...(spec.model ? { model: spec.model } : {}), ...(spec.provider ? { modelProvider: spec.provider } : {}),
      });
      const result = recordValue(response.result);
      const thread = recordValue(result?.thread);
      if (response.error || !thread) throw new Error(`Codex thread/start failed: ${JSON.stringify(response.error ?? response.result)}`);
      // The response's resolved model/provider is authoritative over the thread summary.
      const entry = targetFor({ ...thread, model: result?.model ?? thread.model, modelProvider: result?.modelProvider ?? thread.modelProvider }, true);
      if (!entry) throw new Error("Codex thread/start returned no thread ID.");
      const turnResponse = await rpc.request("turn/start", { threadId: entry.threadId, input: [{ type: "text", text: spec.prompt }] });
      const turnId = stringValue(recordValue(recordValue(turnResponse.result)?.turn)?.id);
      if (turnResponse.error || !turnId) throw new Error(`Codex turn/start failed: ${JSON.stringify(turnResponse.error ?? turnResponse.result)}`);
      if (!entry.turnId) {
        entry.turnId = turnId;
        targetFor({ ...thread, id: entry.threadId, model: result?.model ?? thread.model, modelProvider: result?.modelProvider ?? thread.modelProvider }, true);
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    failed = true;
    rpc.close();
  }
  const code = await waitForChild(child);
  stopPolling();
  for (const entry of threads.values()) {
    if (!entry.done) context.control.resolveNativeRequest(entry.targetId, "stopped", "Native host process exited."); // no-op without a request
    context.control.unregister(entry.targetId);
  }
  context.emit({ event: "exit", code });
  return failed ? 1 : code;
}

async function refreshThread(rpc: StdioRpc, entry: CodexThread, targetFor: (thread: Record<string, unknown>, root: boolean) => CodexThread | null): Promise<void> {
  try {
    const response = await rpc.request("thread/read", { threadId: entry.threadId, includeTurns: false });
    const thread = recordValue(recordValue(response.result)?.thread);
    if (thread) targetFor(thread, entry.root);
  } catch { /* the earlier registration remains valid */ }
}

class StdioRpc {
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();
  private closed = false;

  constructor(private readonly child: ChildProcess) {
    lines(child.stdout, (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { return; }
      if (message.method && message.id !== undefined) {
        // A server request (approval, elicitation): never grant implicitly.
        this.send({ id: message.id, error: { code: -32601, message: "Token Furnace managed host does not answer native approval requests." } });
      } else if (message.method) {
        this.onNotification(message.method, recordValue(message.params) ?? {});
      } else if (typeof message.id === "number") {
        this.pending.get(message.id)?.(message);
      }
    });
    child.once("exit", () => {
      this.closed = true;
      for (const resolve of this.pending.values()) resolve({ error: { message: "Codex app-server exited." } });
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<RpcMessage> {
    if (this.closed) return Promise.resolve({ error: { message: "Codex app-server exited." } });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, (message) => { this.pending.delete(id); resolve(message); });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void { this.send({ method, params }); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin?.end();
    setTimeout(() => { if (this.child.exitCode === null) this.child.kill("SIGTERM"); }, 2_000).unref();
  }

  private send(message: Record<string, unknown>): void { if (!this.child.stdin?.destroyed) this.child.stdin?.write(`${JSON.stringify(message)}\n`); }
}

// ---------------------------------------------------------------- shared

async function waitForIdentity(control: AgentControl, child: ChildProcess): Promise<ProcessIdentity | null> {
  if (!child.pid) return null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const identity = control.processIdentity(child.pid);
    if (identity) return identity;
    if (child.exitCode !== null) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return control.processIdentity(child.pid);
}

function waitForChild(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}

interface RpcMessage { id?: number | string; result?: unknown; error?: unknown; method?: string; params?: unknown }
function recordValue(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
