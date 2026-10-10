import { Worker } from "node:worker_threads";
import type { ParsedFile, Source } from "../core/model";
import type { Env } from "../sources/agent-source";
import type { ParseReply } from "../scan-worker";

/** Parsing runs in worker threads. Each worker holds its own sources, built from the same env. */
export class ParsePool {
  private readonly workers: Worker[];
  private readonly pending = new Map<number, { resolve: (p: ParsedFile) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private failure: Error | null = null;
  private closing = false;

  constructor(url: URL, env: Env, size: number) {
    this.workers = Array.from({ length: size }, () => {
      const worker = new Worker(url, { workerData: { env } });
      worker.on("message", (reply: ParseReply) => {
        const task = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        if ("error" in reply) task?.reject(new Error(reply.error));
        else task?.resolve(reply.parsed);
      });
      worker.on("error", (error) => this.failAll(error));
      worker.on("exit", (code) => {
        if (!this.closing) this.failAll(new Error(`Worker exited with code ${code}`));
      });
      return worker;
    });
  }

  /** The caller keeps one request in flight per worker, so a big file never queues a small one. */
  parse(worker: number, source: Source, path: string): Promise<ParsedFile> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.workers[worker].postMessage({ id, source, path });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }

  private failAll(error: Error): void {
    this.failure = this.failure ?? error;
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }
}
