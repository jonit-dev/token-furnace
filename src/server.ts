/**
 * The live report: Express on 127.0.0.1, rebuilding the report on every request. burn.py serve()
 *
 * A Host header other than the loopback name and the port this server listens on gets 403, so a
 * DNS-rebinding page cannot read the report. No CORS headers go out.
 */

import type { Server } from "node:http";
import express from "express";
import { reportView } from "./core/analyze/view";
import { loadPage, renderHtml } from "./render/html";
import type { App } from "./compose";
import type { Source } from "./core/model";
import { planWeek } from "./services/usage-client";

export interface ServeOptions {
  days: number;
  source: Source | "all";
  /** Millions of weighted tokens, or null. */
  weeklyBudget: number | null;
  planUsage: boolean;
  port: number;
}

export interface LiveServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Serve until the process is stopped. Ctrl-C ends it. */
export async function serve(app: App, options: ServeOptions): Promise<void> {
  const live = await startServer(app, options);
  console.log(`Token Furnace live on ${live.url} (Ctrl-C to stop)`);
  await new Promise<void>(() => {}); // the server keeps the loop alive
}

/** Bind 127.0.0.1 and answer three routes. Port 0 asks the OS for a free port. */
export async function startServer(app: App, options: ServeOptions): Promise<LiveServer> {
  const page = loadPage();
  const web = express();
  web.disable("x-powered-by");

  web.use((req, res, next) => {
    const port = req.socket.localPort;
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    next();
  });

  web.get("/api/report", async (req, res) => {
    const report = await build(app, options, req.query);
    res.type("application/json").send(JSON.stringify(report ? reportView(report, app.now()) : null));
  });

  web.get("/dashboard.html", (_req, res) => {
    res.type("text/html").send(page); // the raw page, polled for hot reload: no rebuild
  });

  web.use(async (req, res) => {
    const report = await build(app, options, req.query);
    res.type("text/html").send(report ? renderHtml(report, app.now(), page) : "No assistant turns.");
  });

  const http = await new Promise<Server>((ready) => {
    const bound = web.listen(options.port, "127.0.0.1", () => ready(bound));
  });
  // Warm the parse cache after the port is bound, so the URL prints at once and early requests
  // queue on the socket. A cold scan of thousands of transcripts takes minutes.
  setImmediate(() => app.reports.refresh());
  const port = (http.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise((done) => http.close(() => done())) };
}

/** One report per request, from the transcripts as they are now. */
async function build(app: App, options: ServeOptions, query: Record<string, unknown>) {
  const now = app.now();
  const days = positiveInt(query.days, options.days);
  const source = query.source === "claude" || query.source === "codex" ? query.source : options.source;
  app.reports.refresh();
  return app.reports.getRaw(days, source, {
    weeklyBudget: options.weeklyBudget,
    planWeek: await planWeek(app.env, now, options.planUsage),
    now,
  });
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return parsed > 0 ? parsed : fallback;
}