/**
 * A parse worker: it receives `{ id, source, path }`, parses the transcript and posts the result
 * back. The main thread keeps the event loop, the repository and the HTTP server.
 */

import { parentPort, workerData } from "node:worker_threads";
import type { ParsedFile } from "./core/model";
import { ClaudeSource } from "./sources/claude";
import { CodexSource } from "./sources/codex";
import type { AgentSource, Env } from "./sources/agent-source";

const env = (workerData as { env: Env }).env;
const sources: Record<string, AgentSource> = { claude: new ClaudeSource(env), codex: new CodexSource(env) };

export type ParseRequest = { id: number; source: string; path: string };
export type ParseReply = { id: number; parsed: ParsedFile } | { id: number; error: string };

parentPort?.on("message", (request: ParseRequest) => {
  let reply: ParseReply;
  try {
    reply = { id: request.id, parsed: sources[request.source].parse(request.path) };
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  parentPort?.postMessage(reply);
});
