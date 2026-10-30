/**
 * A parse worker: it receives `{ id, source, path }`, parses the transcript and posts the result
 * back. The main thread keeps the event loop, the repository and the HTTP server.
 */

import { parentPort, workerData } from "node:worker_threads";
import type { ParsedFile, ProviderId } from "./core/model";
import { createSources } from "./sources";
import type { Env } from "./sources/agent-source";

const env = (workerData as { env: Env }).env;
const sources = new Map(createSources(env).map((source) => [source.name, source]));

export type ParseRequest = { id: number; source: ProviderId; path: string };
export type ParseReply = { id: number; parsed: ParsedFile } | { id: number; error: string };

parentPort?.on("message", (request: ParseRequest) => {
  let reply: ParseReply;
  try {
    const source = sources.get(request.source);
    if (!source) throw new Error(`Unknown source: ${request.source}`);
    reply = { id: request.id, parsed: source.parse(request.path) };
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  parentPort?.postMessage(reply);
});
