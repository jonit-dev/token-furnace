/** The MCP surface: one read-only tool over stdio JSON-RPC, answering the same snapshot as HTTP. */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answer, mcp } from "../src/mcp";

const NOW = new Date(1_800_000_000_000);
const roots: string[] = [];

/** A machine with no Claude login, no Codex home and a cache of its own: nothing can reach the network. */
function env(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "tf-mcp-"));
  roots.push(root);
  const cache = join(root, "cache");
  mkdirSync(cache, { recursive: true });
  return { CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), XDG_CACHE_HOME: cache };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, params?: unknown, id: unknown = 1) => answer({ jsonrpc: "2.0", id, method, params }, env(), NOW);

describe("the MCP handshake", () => {
  it("answers initialize with the client's own protocol revision and the tool capability", async () => {
    const reply = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "1" } });

    expect(reply).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "token-furnace" } },
    });
    expect((reply!.result as { serverInfo: { version: string } }).serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("falls back to its newest revision for one it does not speak", async () => {
    const reply = await call("initialize", { protocolVersion: "1999-01-01" });
    expect((reply!.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  it("replies to a notification with nothing", async () => {
    expect(await answer({ jsonrpc: "2.0", method: "notifications/initialized" }, env(), NOW)).toBeNull();
    expect(await answer({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }, env(), NOW)).toBeNull();
  });

  it("lists one read-only tool with an empty argument schema", async () => {
    const reply = await call("tools/list");
    const tools = (reply!.result as { tools: Record<string, any>[] }).tools;

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "banked_resets", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } });
    expect(tools[0].description).toMatch(/banked reset credits/i);
  });

  it("refuses a malformed envelope: a bad id type, or no revision at all", async () => {
    expect(await answer({ jsonrpc: "2.0", id: {}, method: "ping" }, env(), NOW))
      .toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } });
    expect(await answer({ id: 5, method: "ping" }, env(), NOW))
      .toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } });
    expect(await answer({ jsonrpc: "1.0", id: 5, method: "ping" }, env(), NOW)).toMatchObject({ error: { code: -32600 } });
    expect(await answer({ jsonrpc: "2.0", id: "a", method: "ping" }, env(), NOW)).toMatchObject({ result: {} }); // a string id is fine
  });

  it("answers ping and refuses an unknown method by id", async () => {
    expect(await call("ping", undefined, 7)).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(await call("resources/read")).toMatchObject({ id: 1, error: { code: -32601 } });
  });
});

describe("the banked_resets tool", () => {
  it("answers the same snapshot the HTTP API serves, with the unsupported providers named", async () => {
    const reply = await call("tools/call", { name: "banked_resets", arguments: {} });
    const result = reply!.result as { content: { type: string; text: string }[]; structuredContent: any; isError: boolean };

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent); // the text is the payload
    expect(result.structuredContent.fetchedAt).toBe(NOW.toISOString());
    expect(Object.keys(result.structuredContent.providers).sort()).toEqual(["agy", "claude", "codex", "opencode"]);
    expect(result.structuredContent.providers.claude).toMatchObject({ state: "unavailable", availableCount: 0 });
    expect(result.structuredContent.providers.codex).toMatchObject({ state: "no_login", availableCount: 0 });
    expect(result.structuredContent.providers.opencode.state).toBe("unsupported");
    expect(result.structuredContent.providers.agy.state).toBe("unsupported");
  });

  it("refuses a tool it does not have, whatever the client sends as its name", async () => {
    expect(await call("tools/call", { name: "redeem_reset", arguments: {} })).toMatchObject({ error: { code: -32602 } });
    // A name that cannot be turned into a string must not throw on the way to the error.
    expect(await call("tools/call", { name: { toString: null } })).toMatchObject({ error: { code: -32602 } });
  });

  it("refuses arguments the tool never advertised", async () => {
    expect(await call("tools/call", { name: "banked_resets", arguments: { unexpected: true } })).toMatchObject({ error: { code: -32602 } });
    expect(await call("tools/call", { name: "banked_resets", arguments: "nope" })).toMatchObject({ error: { code: -32602 } });
    expect(await call("tools/call", { name: "banked_resets", arguments: [] })).toMatchObject({ error: { code: -32602 } });
    expect((await call("tools/call", { name: "banked_resets", arguments: {} }))!.result).toBeTruthy(); // an empty object is fine
  });

  it("never redeems anything: the surface has one tool and no consume call", async () => {
    const tools = ((await call("tools/list"))!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["banked_resets"]);
  });
});

describe("the stdio loop", () => {
  it("answers each line, skips notifications, and survives a line that is not JSON", async () => {
    const lines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "not json at all",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ];
    const out: string[] = [];

    await mcp(env(), () => NOW, Readable.from([`${lines.join("\n")}`]), (line) => out.push(line));

    expect(out).toHaveLength(3); // the notification answered nothing
    expect(JSON.parse(out[0]).id).toBe(1);
    expect(JSON.parse(out[1])).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect(JSON.parse(out[2]).result.tools).toHaveLength(1);
  });

  it("answers every line that is not JSON, including an empty one", async () => {
    const out: string[] = [];
    // A trailing newline is how a line ends, so it is not a line of its own; the two in the middle are.
    await mcp(env(), () => NOW, Readable.from([" \n", "\n", '{"jsonrpc":"2.0","id":4,"method":"ping"}\n']), (line) => out.push(line));

    expect(JSON.parse(out[0])).toMatchObject({ id: null, error: { code: -32700 } });
    expect(JSON.parse(out[1])).toMatchObject({ id: null, error: { code: -32700 } });
    expect(JSON.parse(out[2])).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
    expect(out).toHaveLength(3);
  });

  it("answers a line that is not a request with a null-id error", async () => {
    const out: string[] = [];
    await mcp(env(), () => NOW, Readable.from(["1\n", "null\n", '{"jsonrpc":"2.0","id":3,"method":"ping"}\n']), (line) => out.push(line));

    expect(JSON.parse(out[0])).toMatchObject({ id: null, error: { code: -32600 } });
    expect(JSON.parse(out[1])).toMatchObject({ id: null, error: { code: -32600 } });
    expect(JSON.parse(out[2])).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("answers a batch with a batch, and an empty one with an error", async () => {
    const out: string[] = [];
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" }, // a notification in a batch gets no reply
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    await mcp(env(), () => NOW, Readable.from([`${JSON.stringify(batch)}\n${JSON.stringify([])}\n`]), (line) => out.push(line));

    const replies = JSON.parse(out[0]);
    expect(Array.isArray(replies)).toBe(true);
    expect(replies.map((reply: { id: number }) => reply.id)).toEqual([1, 2]);
    expect(JSON.parse(out[1])).toMatchObject({ id: null, error: { code: -32600 } });

    // An element that is not a request at all is answered too, beside the one that is.
    out.length = 0;
    await mcp(env(), () => NOW, Readable.from([`${JSON.stringify([1, { jsonrpc: "2.0", id: 7, method: "ping" }])}\n`]), (line) => out.push(line));
    const mixed = JSON.parse(out[0]);
    expect(mixed).toHaveLength(2);
    expect(mixed[0]).toMatchObject({ id: null, error: { code: -32600 } });
    expect(mixed[1]).toMatchObject({ id: 7, result: {} });
  });

  it("answers a last message that has no trailing newline", async () => {
    const out: string[] = [];
    await mcp(env(), () => NOW, Readable.from(['{"jsonrpc":"2.0","id":9,"method":"ping"}']), (line) => out.push(line));
    expect(JSON.parse(out[0])).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
  });

  it("keeps a multi-byte request id whole when its bytes arrive in separate chunks", async () => {
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: "é", method: "ping" })}\n`, "utf8");
    const split = bytes.indexOf(Buffer.from("é", "utf8")) + 1; // inside the two-byte character
    const out: string[] = [];

    await mcp(env(), () => NOW, Readable.from([bytes.subarray(0, split), bytes.subarray(split)]), (line) => out.push(line));

    expect(JSON.parse(out[0]).id).toBe("é");
  });

  it("answers an error for the request whose handling throws, and keeps going", async () => {
    const out: string[] = [];
    const broken = Readable.from([
      `${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "banked_resets" } })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" })}\n`,
    ]);
    // A snapshot that rejects stands in for anything that can go wrong inside a tool.
    vi.doMock("../src/services/banked-resets-client", () => ({ bankedResetsSnapshot: async () => { throw new Error("boom"); } }));
    vi.resetModules();
    const { mcp: failing } = await import("../src/mcp");

    await failing(env(), () => NOW, broken, (line) => out.push(line));

    expect(JSON.parse(out[0])).toMatchObject({ id: 5, error: { code: -32603 } });
    expect(JSON.parse(out[1])).toEqual({ jsonrpc: "2.0", id: 6, result: {} });
  });

  it("reads nothing from the network when the tool has no login to read", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("the tool must not fetch without a login");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const out: string[] = [];

    await mcp(env(), () => NOW, Readable.from([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "banked_resets" } })}\n`,
    ]), (line) => out.push(line));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(out[0]).result.structuredContent.providers.codex.state).toBe("no_login");
  });
});
