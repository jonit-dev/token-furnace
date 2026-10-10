/**
 * The live report: Express on 127.0.0.1 with routing-controllers, rebuilding the report on every
 * request. burn.py serve(). Every route is a controller method: no vanilla routers.
 */

import type { Server } from "node:http";
import "reflect-metadata";
import express, { type Request, type Response } from "express";
import { Controller, Get, Post, Middleware, Req, Res, useExpressServer, type ExpressMiddlewareInterface } from "routing-controllers";
import { reportView } from "./core/analyze/view";
import { loadPage, renderHtml } from "./render/html";
import { loadingPage } from "./render/loading";
import type { App } from "./compose";
import type { Source, Week } from "./core/model";
import { CONFIG_REPAIRS, type ConfigRepairId } from "./core/config-repairs";
import { runFixConfig } from "./setup/agents";
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
  console.log("The first scan reads every transcript once. The page shows its progress.");
  await new Promise<void>(() => {}); // the server keeps the loop alive
}

/** Bind 127.0.0.1 and answer the routes. Port 0 asks the OS for a free port. */
export async function startServer(app: App, options: ServeOptions): Promise<LiveServer> {
  const web = express();
  web.disable("x-powered-by");
  useExpressServer(web, {
    controllers: [reportController(app, options, loadPage())],
    middlewares: [LoopbackHostOnly],
    defaultErrorHandler: true,
    classTransformer: false,
    validation: false,
  });

  const http = await new Promise<Server>((ready) => {
    const bound = web.listen(options.port, "127.0.0.1", () => ready(bound));
  });
  // Scan after the port is bound. The scan yields, so requests are answered while it runs.
  warm(app);
  const port = (http.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise((done) => http.close(() => done())) };
}

/**
 * A Host header other than the loopback name and the port this server listens on gets 403, so a
 * DNS-rebinding page cannot read the report. No CORS headers go out.
 */
@Middleware({ type: "before", priority: 100 })
class LoopbackHostOnly implements ExpressMiddlewareInterface {
  use(req: Request, res: Response, next: (error?: unknown) => void): void {
    const port = req.socket.localPort;
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    next();
  }
}

/** The routes, closed over the app they serve. The catch-all page is declared last. */
function reportController(app: App, options: ServeOptions, page: string) {
  // The last quota reading this server saw. It lives in memory, so a no-cache server still shows
  // real utilization without a disk write, and it expires when its week resets.
  let quota: Week | null = null;
  let fetching: Promise<void> | null = null;

  /** The reading for this request: the snapshot while its week runs, else the saved file. No network. */
  const plan = (now: Date): Promise<Week | null> =>
    quota && quota.resets > now ? Promise.resolve(quota) : planWeek(app.env, now, false);

  /** Refresh after the response. One call at a time; the client's own gate stops a second call. */
  const refresh = (): void => {
    fetching ??= planWeek(app.env, app.now(), true)
      .then((week) => {
        if (week && week.resets > app.now()) quota = week;
      })
      .catch(() => {}) // a failed call keeps the reading
      .finally(() => {
        fetching = null;
      });
  };

  /** One report per request, from the transcripts as they are now. The network refresh runs after. */
  async function build(query: Record<string, unknown>) {
    const now = app.now();
    const days = positiveInt(query.days, options.days);
    const source = query.source === "claude" || query.source === "codex" ? query.source : options.source;
    rescan(app); // the answer is the report we have now; the next poll sees the new scan
    const report = app.reports.getRaw(days, source, {
      weeklyBudget: options.weeklyBudget,
      planWeek: await plan(now),
      now,
    });
    if (options.planUsage) setImmediate(refresh); // after this response: the keychain read must not block it
    return report;
  }

  @Controller()
  class ReportController {
    @Post("/api/fix-config")
    fixConfig(@Req() req: Request, @Res() res: Response) {
      const origin = req.headers.origin;
      if (req.headers["x-token-furnace-confirm"] !== "true" ||
          (origin && origin !== `http://${req.headers.host}`)) {
        return res.status(403).json({ error: "Confirm configuration changes from this dashboard." });
      }
      const selection = req.headers["x-token-furnace-repairs"];
      const repairs = typeof selection === "string" ? (selection ? selection.split(",") : []) : undefined;
      if (selection !== undefined && (typeof selection !== "string" || repairs?.some((id) => !CONFIG_REPAIRS.some((repair) => repair.id === id)))) {
        return res.status(400).json({ error: "Unknown configuration repair selection." });
      }
      let output = "";
      const code = runFixConfig(app.env, { write: (text) => { output += text; } }, {
        includeDepth: req.headers["x-token-furnace-include-depth"] === "true",
        repairs: repairs as ConfigRepairId[] | undefined,
      });
      return res.status(code === 0 ? 200 : 500).json({ ok: code === 0, output });
    }

    @Get("/api/status")
    status(@Res() res: Response) {
      if (!app.reports.hasScanned) warm(app);
      return res.set("Cache-Control", "no-store").json(app.reports.progress);
    }

    @Get("/api/report")
    async report(@Req() req: Request, @Res() res: Response) {
      if (!app.reports.hasScanned) {
        warm(app);
        return res.status(202).json({ status: "scanning", progress: app.reports.progress });
      }
      const report = await build(req.query);
      return res.type("application/json").send(JSON.stringify(report ? reportView(report, app.now()) : null));
    }

    @Get("/dashboard.html")
    dashboard(@Res() res: Response) {
      return res.type("text/html").send(page); // the raw page, polled for hot reload: no rebuild
    }

    @Get(/.*/)
    async index(@Req() req: Request, @Res() res: Response) {
      if (!app.reports.hasScanned) {
        warm(app);
        return res.type("text/html").send(loadingPage()); // the first scan takes minutes: show progress
      }
      const report = await build(req.query);
      return res.type("text/html").send(report ? renderHtml(report, app.now(), page) : "No assistant turns.");
    }
  }
  return ReportController;
}

/** Start or join the scan without waiting. A failed scan is logged, not an unhandled rejection. */
function warm(app: App): void {
  app.reports.refresh().catch((error) => console.error("token-furnace: scan failed:", error));
}

/** Rescan in the background when the last scan is over 5 s old. A request never waits for it. */
function rescan(app: App): void {
  if (Date.now() - app.reports.progress.updatedAt > 5_000) warm(app);
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return parsed > 0 ? parsed : fallback;
}