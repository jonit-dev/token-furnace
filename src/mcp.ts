/**
 * The MCP surface: one read-only tool over stdio JSON-RPC, so an agent can ask for this account's
 * banked resets without the loopback API. The answer is the same snapshot `GET /api/banked-resets`
 * serves, and nothing here redeems a credit.
 */

import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { Env } from "./sources/agent-source";
import { bankedResetsSnapshot } from "./services/banked-resets-client";

/** The protocol revisions this server speaks, newest first. A client's own one is echoed back. */
const PROTOCOL = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOL = {
  name: "banked_resets",
  title: "Banked resets",
  description:
    "Personal banked reset credits the Claude and Codex logins on this machine still hold: how many, when each one expires, and which tracked providers issue none. Read-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

type Message = { jsonrpc?: unknown; id?: unknown; method?: string; params?: Record<string, any> };

/**
 * One MCP message in, one reply out. A notification carries no id, so it gets no reply; an unknown
 * method or tool gets the JSON-RPC error a client expects instead of a silent drop.
 */
export async function answer(message: unknown, env: Env, now: Date): Promise<Record<string, unknown> | null> {
  const request = (message ?? {}) as Message;
  const id = request.id ?? null;
  if (typeof request.method !== "string" || id === null) return null; // a notification, or no request at all
  // The id is a string, a number, or null; the revision member is required. Anything else is not a
  // request this server can answer, so it gets the null-id error the specification asks for.
  if (request.jsonrpc !== "2.0" || (typeof id !== "string" && typeof id !== "number")) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } };
  }
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (request.method) {
    case "initialize": {
      const asked = request.params?.protocolVersion;
      return result({
        protocolVersion: typeof asked === "string" && PROTOCOL.includes(asked) ? asked : PROTOCOL[0],
        capabilities: { tools: {} },
        serverInfo: { name: "token-furnace", version: packageVersion() },
      });
    }
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: [TOOL] });
    case "tools/call": {
      // The name is compared, never printed: a client can send anything, including an object.
      if (request.params?.name !== TOOL.name) return error(-32602, "Unknown tool.");
      // The tool takes no arguments: anything else does not match the schema it advertised.
      const args = request.params?.arguments;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args) || Object.keys(args).length)) {
        return error(-32602, "This tool takes no arguments.");
      }
      const snapshot = await bankedResetsSnapshot(env, now, true);
      return result({ content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }], structuredContent: snapshot, isError: false });
    }
    default:
      return error(-32601, `Unknown method: ${request.method}`);
  }
}

/**
 * Serve MCP on a stream until it ends: one JSON-RPC message per line. A line that is not JSON is
 * answered with a parse error and the stream carries on, so one bad message cannot end the server.
 */
export async function mcp(env: Env, now: () => Date, input: NodeJS.ReadableStream, output: (line: string) => void): Promise<void> {
  const handle = async (line: string): Promise<void> => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      output(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }
    if (Array.isArray(message)) {
      // A batch is answered as a batch; the revisions before 2025-06-18 require it.
      if (!message.length) {
        output(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Empty batch." } }));
        return;
      }
      const replies = (await Promise.all(message.map(async (one) => await respond(one) ?? invalid(one))))
        .filter((reply) => reply !== null);
      if (replies.length) output(JSON.stringify(replies));
      return;
    }
    const reply = (await respond(message)) ?? invalid(message);
    if (reply) output(JSON.stringify(reply));
  };

  /** A batch element that answered nothing and was not a notification was not a request at all. */
  const invalid = (one: unknown): Record<string, unknown> | null => {
    const request = one as Record<string, unknown> | null;
    if (typeof request === "object" && request !== null && typeof request.method === "string" && !("id" in request)) {
      return null; // a notification in a batch is answered with nothing
    }
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } };
  };

  /** One message's reply, or an error for its own id when handling it throws. */
  const respond = async (message: unknown): Promise<Record<string, unknown> | null> => {
    try {
      return await answer(message, env, now());
    } catch {
      // One message cannot end the server; a client that sent it gets an error for its id.
      const id = (message as { id?: unknown } | null)?.id ?? null;
      return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error." } };
    }
  };
  // A chunk can split a multi-byte character: the decoder holds the bytes until it is whole.
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) await handle(line);
  }
  const tail = buffer + decoder.end();
  if (tail !== "") await handle(tail); // a last message with no trailing newline still counts
}

/** The package version, from src or from the bundle beside it. It is a label, so a miss is "0.0.0". */
function packageVersion(): string {
  for (const path of ["../package.json", "../../package.json"]) {
    try {
      return String(JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")).version ?? "0.0.0");
    } catch {
      continue;
    }
  }
  return "0.0.0";
}
