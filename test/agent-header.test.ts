/**
 * The Claude request has to name Claude Code: without the header Anthropic answers
 * `ineligible_reason: "cli_version"` and the credits card goes unavailable. The version comes from
 * `claude --version`, so a probe that fails must not poison the process for good.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const CLOCK = Date.UTC(2027, 0, 15, 12, 0, 0);
const probe = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (command: string, args: string[], options: unknown, done: Function) => probe(command, args, options, done),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  // The probe result hangs off the global object so a reloaded module does not ask twice: clear it.
  delete (globalThis as Record<string, unknown>).__tokenFurnaceClaudeAgent;
  probe.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ seven_day: null, cedar_ember: null }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function machine(): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), "tf-agent-"));
  const claude = join(root, "claude");
  const cache = join(root, "cache");
  mkdirSync(claude, { recursive: true });
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "unit-token" } }));
  return { root, env: { CLAUDE_CONFIG_DIR: claude, XDG_CACHE_HOME: cache, HOME: root, PATH: process.env.PATH } };
}

/** The `User-Agent` a call sent, or undefined when it sent none. */
function agent(call: unknown[]): unknown {
  return (call[1] as { headers: Record<string, unknown> }).headers["User-Agent"];
}

it("names Claude Code from the installed version", async () => {
  const { env, root } = machine();
  probe.mockImplementation((_command, _args, _options, done) => done(null, "2.1.332 (Claude Code)\n"));
  const { claudeBankedResets } = await import("../src/services/usage-client");

  await claudeBankedResets(env, new Date(CLOCK), true);
  await claudeBankedResets(env, new Date(CLOCK + 6 * 60_000), true);

  expect(agent(fetchMock.mock.calls[0])).toBe("claude-cli/2.1.332 (external, cli)");
  expect(probe).toHaveBeenCalledTimes(1); // once per process, not once per call
  rmSync(root, { recursive: true, force: true });
});

it("names the file before the request, so a profile that moves mid-flight cannot be misfiled", async () => {
  const { env, root } = machine();
  probe.mockImplementation((_command, _args, _options, done) => done(null, "2.1.332 (Claude Code)\n"));
  // A second profile, and a request that only answers after CLAUDE_CONFIG_DIR has moved to it.
  const second = join(root, "second");
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "unit-token" } }));
  let answer = (): void => {};
  const gate = new Promise<void>((done) => {
    answer = done;
  });
  fetchMock.mockImplementation(async () => {
    await gate;
    return new Response(JSON.stringify({ seven_day: null, cedar_ember: { eligible: true, grants: [] } }), { status: 200 });
  });
  const { claudeBankedResets } = await import("../src/services/usage-client");

  const first = claudeBankedResets(env, new Date(CLOCK), true);
  await new Promise((next) => setTimeout(next, 0)); // let the request go out
  env.CLAUDE_CONFIG_DIR = second;
  answer();
  await first;

  const files = readdirSync(join(String(env.XDG_CACHE_HOME), "token-furnace", "banked"));
  expect(files).toHaveLength(1); // one file: the home this call started for, not the one it ended in
  rmSync(root, { recursive: true, force: true });
});

it("uses the keychain for the default home even when it is named explicitly", async () => {
  const { env, root } = machine();
  // The default home, named explicitly: the keychain login is this account's.
  const home = join(root, ".claude");
  mkdirSync(home, { recursive: true });
  env.HOME = root;
  env.CLAUDE_CONFIG_DIR = home; // and no credentials file in it, so only the keychain can answer
  probe.mockImplementation((command, _args, _options, done) => {
    done(null, command === "security" ? JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }) : "2.1.332 (Claude Code)\n");
  });
  const { planWeek } = await import("../src/services/usage-client");

  await planWeek(env, new Date(CLOCK), true); // CLAUDE_CONFIG_DIR is set, and it is ~/.claude

  expect(probe.mock.calls.some((call) => call[0] === "security")).toBe(true); // the keychain was asked
  expect(String((fetchMock.mock.calls[0]?.[1] as any)?.headers?.Authorization)).toBe("Bearer keychain-token");
  rmSync(root, { recursive: true, force: true });
});

it("uses the keychain when the default home is named explicitly and does not exist", async () => {
  const { env, root } = machine();
  // macOS: the login lives in the keychain and there is no ~/.claude directory at all.
  const home = join(root, ".claude"); // never created: there is no ~/.claude on this machine
  probe.mockImplementation((command, _args, _options, done) => {
    done(null, command === "security" ? JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }) : "2.1.332 (Claude Code)\n");
  });
  const bare = { ...env, HOME: root, CLAUDE_CONFIG_DIR: home } as NodeJS.ProcessEnv;
  const { claudeBankedResets, planWeek } = await import("../src/services/usage-client");

  expect((await claudeBankedResets(bare, new Date(CLOCK), true)).state).not.toBe("no_login");
  expect(probe.mock.calls.some((call) => call[0] === "security")).toBe(true); // the keychain answered
  // And the week reads through the same login, a minute later (the retry gate).
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ seven_day: { utilization: 12, resets_at: new Date(CLOCK + 86_400_000).toISOString() } }), { status: 200 }));
  expect((await planWeek(bare, new Date(CLOCK + 61_000), true))!.used).toBe(12);
  expect(String((fetchMock.mock.calls.at(-1)![1] as any).headers.Authorization)).toBe("Bearer keychain-token");
  rmSync(root, { recursive: true, force: true });
});

it("does not treat a `..` detour through the default home as the default home", async () => {
  const { env, root } = machine();
  const home = join(root, ".claude");
  mkdirSync(join(home, ".credentials.json", ".."), { recursive: true }); // the default home exists
  const detour = `${home}/missing/..`; // and this path names it, without existing itself
  probe.mockImplementation((_command, _args, _options, done) => done(null, "2.1.332 (Claude Code)\n"));
  const { claudeBankedResets } = await import("../src/services/usage-client");

  const resets = await claudeBankedResets({ ...env, HOME: root, CLAUDE_CONFIG_DIR: detour }, new Date(CLOCK), true);

  expect(resets.state).toBe("no_login");
  expect(fetchMock).not.toHaveBeenCalled(); // the neighbouring profile was never asked
  rmSync(root, { recursive: true, force: true });
});

it("still answers from the keychain when there is no ~/.claude at all", async () => {
  const { env, root } = machine();
  // No credentials file and no explicit home: the macOS keychain is the only login left.
  const bare = { ...env, CLAUDE_CONFIG_DIR: undefined, HOME: join(root, "no-claude") } as NodeJS.ProcessEnv;
  probe.mockImplementation((_command, _args, _options, done) => done(null, "2.1.332 (Claude Code)\n"));
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ seven_day: null, cedar_ember: null }), { status: 200 }));
  const { claudeBankedResets } = await import("../src/services/usage-client");

  // Without a keychain entry here the request is not made, but the answer is "unavailable", not
  // "no_login": the home was never the thing that decided.
  expect((await claudeBankedResets(bare, new Date(CLOCK), true)).state).toBe("unavailable");
  rmSync(root, { recursive: true, force: true });
});

it("reads nothing for an explicit home that does not exist, even when only the week is wanted", async () => {
  const { env, root } = machine();
  probe.mockImplementation((_command, _args, _options, done) => done(null, "2.1.332 (Claude Code)\n"));
  const { planWeek } = await import("../src/services/usage-client");
  const configured = `${env.CLAUDE_CONFIG_DIR}/missing/..`; // the neighbour exists, the path does not

  expect(await planWeek({ ...env, CLAUDE_CONFIG_DIR: configured }, new Date(CLOCK), true)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled(); // no credentials were read through an invalid path
  expect(existsSync(join(String(env.XDG_CACHE_HOME), "token-furnace", "banked"))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

it("answers no_login when the configured home does not exist, even beside a real profile", async () => {
  const { env, root } = machine();
  const configured = `${env.CLAUDE_CONFIG_DIR}/missing/..`; // a string join, so `..` stays
  probe.mockImplementation((_command, _args, _options, done) => done(null, "2.1.332 (Claude Code)\n"));
  const { claudeBankedResets } = await import("../src/services/usage-client");

  const resets = await claudeBankedResets({ ...env, CLAUDE_CONFIG_DIR: configured }, new Date(CLOCK), true);

  expect(resets.state).toBe("no_login");
  expect(fetchMock).not.toHaveBeenCalled(); // and the neighbouring account was never asked
  rmSync(root, { recursive: true, force: true });
});

it("does not save a cli_version refusal as if it were the account's balance", async () => {
  const { env, root } = machine();
  probe.mockImplementation((_command, _args, _options, done) => done(null, "2.1.332 (Claude Code)\n"));
  fetchMock.mockResolvedValue(new Response(JSON.stringify({
    seven_day: null,
    cedar_ember: { eligible: false, ineligible_reason: "cli_version", grants: [] },
  }), { status: 200 }));
  const { claudeBankedResets } = await import("../src/services/usage-client");

  await claudeBankedResets(env, new Date(CLOCK), true);

  // The refusal is in this process's memory, but nothing says the account has no credits.
  const dir = join(String(env.XDG_CACHE_HOME), "token-furnace", "banked");
  expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]); // nothing was saved
  rmSync(root, { recursive: true, force: true });
});

it("stops probing when there is no claude on the machine at all", async () => {
  const { env, root } = machine();
  const missing = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  probe.mockImplementation((_command, _args, _options, done) => done(missing));
  const { claudeBankedResets } = await import("../src/services/usage-client");

  await claudeBankedResets(env, new Date(CLOCK), true);
  await claudeBankedResets(env, new Date(CLOCK + 6 * 60_000), true);

  expect(probe).toHaveBeenCalledTimes(1); // no install is an answer, not a failure to retry
  rmSync(root, { recursive: true, force: true });
});

it("tries a wedged probe once more, then stops asking", async () => {
  const { env, root } = machine();
  const wedged = Object.assign(new Error("Command failed: claude --version"), { killed: true, signal: "SIGTERM" });
  probe.mockImplementation((_command, _args, _options, done) => done(wedged));
  const { claudeBankedResets } = await import("../src/services/usage-client");

  for (let i = 0; i < 4; i++) await claudeBankedResets(env, new Date(CLOCK + i * 6 * 60_000), true);

  expect(probe).toHaveBeenCalledTimes(2); // one timeout, one second look, and then no more
  expect(agent(fetchMock.mock.calls[0])).toBeUndefined(); // a failed probe sends the plain request
  rmSync(root, { recursive: true, force: true });
});

it("does not ask again when claude answers with a failure", async () => {
  const { env, root } = machine();
  probe.mockImplementation((_command, _args, _options, done) => done(Object.assign(new Error("exit 1"), { code: 1 })));
  const { claudeBankedResets } = await import("../src/services/usage-client");

  for (let i = 0; i < 3; i++) await claudeBankedResets(env, new Date(CLOCK + i * 6 * 60_000), true);

  expect(probe).toHaveBeenCalledTimes(1); // an install that says no is an answer
  rmSync(root, { recursive: true, force: true });
});
