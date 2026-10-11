import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentControl, type ControlTarget, type ProcessIdentity } from "../src/services/agent-control";

const testStoreRoot = mkdtempSync(join(tmpdir(), "tf-control-tests-"));
let testStoreNumber = 0;
const controls: AgentControl[] = [];
afterAll(() => rmSync(testStoreRoot, { recursive: true, force: true }));
afterEach(() => {
  closeControls();
});
function testStore(): string {
  return join(testStoreRoot, `${testStoreNumber++}.sqlite`);
}

function makeControl(options: ConstructorParameters<typeof AgentControl>[0] = {}): AgentControl {
  const control = new AgentControl(options);
  controls.push(control);
  return control;
}

function closeControls(): void {
  for (const control of controls.splice(0)) control.close();
}

function target(overrides: Partial<ControlTarget> = {}): ControlTarget {
  return {
    id: "session-1",
    source: "claude",
    provider: "anthropic",
    model: "claude-opus",
    pid: 4321,
    processStartTime: 10,
    ownerUid: 7,
    ...overrides,
  };
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("AgentControl", () => {
  it("does not signal a PID whose start identity changed", async () => {
    const signal = vi.fn();
    const inspect = vi.fn((): ProcessIdentity => ({ pid: 4321, processStartTime: 11, ownerUid: 7, parentPid: 1 }));
    const control = makeControl({ inspect, signal, currentUid: 7, storePath: testStore() });
    const outcome = await control.cancel(target(), true);
    expect(outcome.status).toBe("unresolved");
    expect(signal).not.toHaveBeenCalled();
  });

  it("matches canonical provider/model identity without substring aliases", () => {
    const control = makeControl({
      inspect: (pid) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1 }),
      currentUid: 7,
      signal: vi.fn(),
      storePath: testStore(),
    });
    control.register(target({ id: "opus", model: "claude-opus" }));
    control.register(target({ id: "sonnet", model: "claude-sonnet" }));
    expect(control.discover({ kind: "model", provider: "Anthropic", model: "Claude-Opus" }).map((item) => item.id)).toEqual(["opus"]);
  });

  it("refuses Token Furnace itself even when the PID is otherwise owned", async () => {
    const signal = vi.fn();
    const control = makeControl({
      inspect: (pid) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1 }),
      currentUid: 7,
      signal,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ pid: process.pid }), true);
    expect(outcome.status).toBe("unresolved");
    expect(signal).not.toHaveBeenCalled();
  });

  it("protects Token Furnace ancestors but permits a verified worker child", async () => {
    const signal = vi.fn();
    const currentPid = 9000;
    const identities = new Map<number, ProcessIdentity>([
      [currentPid, { pid: currentPid, processStartTime: 1, ownerUid: 7, parentPid: 8000 }],
      [8000, { pid: 8000, processStartTime: 2, ownerUid: 7, parentPid: 1 }],
      [7000, { pid: 7000, processStartTime: 3, ownerUid: 7, parentPid: currentPid }],
    ]);
    const control = makeControl({ currentPid, currentUid: 7, signal, graceMs: 0, inspect: (pid) => identities.get(pid) ?? null, storePath: testStore() });
    const ancestor = await control.cancel(target({ id: "ancestor", pid: 8000, processStartTime: 2, exclusive: true }), true);
    expect(ancestor.status).toBe("unresolved");
    expect(signal).not.toHaveBeenCalled();
    const child = await control.cancel(target({ id: "child", pid: 7000, processStartTime: 3, exclusive: true }), true);
    expect(child.status).toBe("unresolved");
    expect(signal).toHaveBeenCalledWith(7000, "SIGKILL");
  });

  it("does not report force termination until process exit is observed", async () => {
    const signal = vi.fn();
    const inspect = () => ({ pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1 });
    const control = makeControl({ inspect, signal, currentUid: 7, graceMs: 0, storePath: testStore() });
    const outcome = await control.cancel(target({ exclusive: true, nativeState: async () => true }), true);
    expect(outcome.status).toBe("unresolved");
    expect(outcome.detail).toMatch(/exit was not verified/i);
  });

  it("terminates verified owned descendants without widening to an unrelated sibling", async () => {
    const identities = new Map<number, ProcessIdentity>([
      [4321, { pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1 }],
      [4322, { pid: 4322, processStartTime: 11, ownerUid: 7, parentPid: 4321 }],
      [4333, { pid: 4333, processStartTime: 12, ownerUid: 7, parentPid: 1 }],
    ]);
    const signal = vi.fn((pid: number) => { identities.delete(pid); });
    const control = makeControl({
      currentPid: 9000,
      currentUid: 7,
      signal,
      inspect: (pid) => identities.get(pid) ?? null,
      listProcesses: () => [...identities.values()],
      graceMs: 100,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ pid: 4321, processStartTime: 10, exclusive: true }), true);
    expect(outcome.status).toBe("terminated");
    expect(signal.mock.calls.map(([pid]) => pid)).toEqual([4321, 4322]);
    expect(identities.has(4333)).toBe(true);
  });

  it("uses the owning OpenCode session and Basic auth before aborting", async () => {
    let busy = true;
    let aborts = 0;
    const authorization: string[] = [];
    const server = createServer((request, response) => {
      authorization.push(String(request.headers.authorization ?? ""));
      if (request.url === "/session/native-session" && request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "native-session" }));
      } else if (request.url === "/session/status" && request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ "native-session": { type: busy ? "busy" : "idle" } }));
      } else if (request.url === "/session/native-session/abort" && request.method === "POST") {
        busy = false;
        aborts++;
        response.statusCode = 200;
        response.end("ok");
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const inspect = () => ({ pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: "/usr/bin/opencode" });
      const control = makeControl({
        env: { HOME: testStoreRoot, OPENCODE_SERVER_PASSWORD: "secret" },
        inspect,
        currentUid: 7,
        currentPid: 9000,
        signal: vi.fn(),
        storePath: testStore(),
      });
      const registered = target({
        id: "native-session",
        source: "opencode",
        provider: "anthropic",
        model: "claude-sonnet",
        executable: "/usr/bin/opencode",
        native: { kind: "opencode", endpoint, transport: "http", sessionId: "native-session", auth: { scheme: "basic", passwordEnv: "OPENCODE_SERVER_PASSWORD" } },
      });
      expect(control.register(registered)).toBe(true);
      const selected = control.preview({ kind: "source", source: "opencode" }).targets[0];
      expect(selected).toBeDefined();
      const outcome = await control.cancel(selected!, false);
      expect(outcome.status).toBe("cancelled");
      expect(aborts).toBe(1);
      expect(authorization.length).toBeGreaterThanOrEqual(4);
      expect(new Set(authorization)).toEqual(new Set([`Basic ${Buffer.from("opencode:secret").toString("base64")}`]));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("force-stops a real owned child while an unrelated sibling remains live", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const control = makeControl({ currentUid: typeof process.getuid === "function" ? process.getuid() : null, graceMs: 1_000, storePath: testStore() });
    try {
      const identity = await new Promise<ProcessIdentity>((resolve, reject) => {
        const deadline = Date.now() + 2_000;
        const poll = () => {
          const current = child.pid ? control.processIdentity(child.pid) : null;
          if (current) return resolve(current);
          if (Date.now() >= deadline) return reject(new Error("real child identity was not discoverable"));
          setTimeout(poll, 25);
        };
        poll();
      });
      expect(child.pid).toBeDefined();
      expect(unrelated.pid).toBeDefined();
      expect(identity.ownerUid !== null || identity.ownerIdentity || identity.ownerSid).toBeTruthy();
      expect(control.register({ ...target({ id: "real-child", pid: child.pid!, processStartTime: identity.processStartTime, ownerUid: identity.ownerUid, ownerIdentity: identity.ownerIdentity, ownerSid: identity.ownerSid, executable: identity.executable, exclusive: true }) })).toBe(true);
      const outcome = await control.cancel({ ...target({ id: "real-child", pid: child.pid!, processStartTime: identity.processStartTime, ownerUid: identity.ownerUid, ownerIdentity: identity.ownerIdentity, ownerSid: identity.ownerSid, executable: identity.executable, exclusive: true }) }, true);
      expect(outcome.status).toBe("terminated");
      await waitForExit(child);
      expect(unrelated.exitCode).toBeNull();
    } finally {
      control.close();
      if (child.exitCode === null) child.kill("SIGKILL");
      if (unrelated.exitCode === null) unrelated.kill("SIGTERM");
      await Promise.all([waitForExit(child), waitForExit(unrelated)]);
    }
  });

  it("reloads durable owned registrations for a later preview", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-control-"));
    try {
      const statePath = join(root, "control.json");
      const inspect = (pid: number) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1 });
      const first = makeControl({ statePath, inspect, currentUid: 7, currentPid: 9000 });
      expect(first.register(target({ pid: 4321, exclusive: true }))).toBe(true);
      first.close();
      const second = makeControl({ statePath, inspect, currentUid: 7, currentPid: 9000 });
      expect(second.discover({ kind: "source", source: "claude" }).map((item) => item.id)).toEqual(["session-1"]);
      second.close();
    } finally {
      closeControls();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads registrations written after construction and merges concurrent writers", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-control-live-"));
    try {
      const storePath = join(root, "control.sqlite");
      const inspect = (pid: number) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1 });
      const serverStartedFirst = makeControl({ storePath, inspect, currentUid: 7, currentPid: 9000 });
      const hookOne = makeControl({ storePath, inspect, currentUid: 7, currentPid: 9001 });
      const hookTwo = makeControl({ storePath, inspect, currentUid: 7, currentPid: 9002 });
      expect(hookOne.register(target({ id: "hook-one", pid: 4321 }))).toBe(true);
      expect(hookTwo.register(target({ id: "hook-two", pid: 4322 }))).toBe(true);
      expect(serverStartedFirst.discover({ kind: "source", source: "claude" }).map((item) => item.id)).toEqual(["hook-one", "hook-two"]);
      serverStartedFirst.close(); hookOne.close(); hookTwo.close();
    } finally {
      closeControls();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads registrations from concurrent real hook processes after the server starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tf-control-hooks-"));
    const storePath = join(root, "state", "token-furnace", "control.sqlite");
    const cliPath = join(process.cwd(), "dist", "cli.js");
    const nativeWorkers = [
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "claude"], { stdio: "ignore" }),
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "claude"], { stdio: "ignore" }),
    ];
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    const control = makeControl({
      env: { ...process.env, HOME: root, TOKEN_FURNACE_STATE_HOME: join(root, "state") },
      storePath,
      currentUid,
    });
    try {
      expect(existsSync(cliPath)).toBe(true);
      const pids = nativeWorkers.map((worker) => worker.pid);
      expect(pids.every((pid): pid is number => typeof pid === "number")).toBe(true);
      const runHook = (pid: number, sessionId: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const hook = spawn(process.execPath, [cliPath, "hook", "budget", "--source", "claude"], {
          env: {
            ...process.env,
            HOME: root,
            TOKEN_FURNACE_STATE_HOME: join(root, "state"),
            TOKEN_FURNACE_CONFIG_HOME: join(root, "config"),
            TOKEN_FURNACE_CACHE_HOME: join(root, "cache"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        hook.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        hook.on("error", reject);
        hook.on("close", (code) => resolve({ code, output }));
        hook.stdin?.end(JSON.stringify({
          provider: "anthropic",
          model: "claude-opus",
          pid,
          session_id: sessionId,
          exclusive: true,
        }));
      });
      const results = await Promise.all(pids.map((pid, index) => runHook(pid!, `real-hook-${index}`)));
      expect(results.every((result) => result.code === 0 && /"allow":true/.test(result.output))).toBe(true);
      expect(control.discover({ kind: "source", source: "claude" }).map((item) => item.id)).toEqual(["real-hook-0", "real-hook-1"]);
    } finally {
      control.close();
      for (const worker of nativeWorkers) if (worker.exitCode === null) worker.kill("SIGKILL");
      await Promise.all(nativeWorkers.map(waitForExit));
      closeControls();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports same-user unmanaged native executables as unresolved instead of signalling them", () => {
    const identity: ProcessIdentity = { pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: "/usr/local/bin/claude" };
    const control = makeControl({
      inspect: (pid) => pid === 4321 ? identity : null,
      listProcesses: () => [identity],
      currentUid: 7,
      currentPid: 9000,
      storePath: testStore(),
    });
    const preview = control.preview({ kind: "source", source: "claude" });
    expect(preview.targets).toHaveLength(0);
    expect(preview.unverified[0]?.detail).toMatch(/unmanaged/i);
    control.close();
  });

  it("surfaces control-store write failures as unresolved state", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-control-failure-"));
    try {
      const control = makeControl({
        statePath: root,
        inspect: (pid) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1 }),
        currentUid: 7,
        currentPid: 9000,
      });
      expect(control.register(target())).toBe(false);
      expect(control.preview({ kind: "source", source: "claude" }).unverified.some((item) => item.id === "control-store")).toBe(true);
      control.close();
    } finally {
      closeControls();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
