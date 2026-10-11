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
import { pendingRepairs, runFixConfig } from "./setup/agents";
import { openCodeWeek, planWeek } from "./services/usage-client";
import { resetsSnapshot } from "./services/resets-client";
import {
  deliver, loadSettings, mergeSettings, publicSettings, runAlerts, saveSettings,
  type DeliveryResult,
} from "./services/notifications";

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

/** The refresh that runs on its own, without a browser tab asking for it. */
const TICK_MS = 60_000;

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
  web.use(express.json({ limit: "16kb" }));
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
  // The notification loop runs in the server, not in a tab: it stops with the server and one run at a time.
  const ticker = { running: false };
  const timer = setInterval(() => {
    if (ticker.running) return; // a slow run is never joined by a second one
    ticker.running = true;
    notifyTick(app, options.planUsage, options.weeklyBudget).catch(() => {}).finally(() => { ticker.running = false; });
  }, TICK_MS);
  timer.unref();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((done) => {
      clearInterval(timer);
      http.close(() => done());
    }),
  };
}

/**
 * One pass of the notification loop: refresh the shared reset feed, then send what the conditions
 * earned. Off means no polling at all. Utilization is the same week.used percent the report shows
 * (reportView burns.used copies it); the tick reads the weeks directly so a quiet transcript
 * window cannot zero it, with the network call gated by each client's own cache.
 * planUsage false (--no-plan-usage) never fetches quota: only the saved reading is used.
 */
export async function notifyTick(app: App, planUsage = true, weeklyBudget: number | null = null): Promise<{ alerts: unknown; delivered: DeliveryResult[] }> {
  const now = app.now();
  const settings = loadSettings(app.env);
  if (!settings.enabled) return { alerts: [], delivered: [] };
  const snapshot = await resetsSnapshot(now);
  const [plan, open] = await Promise.all([
    planWeek(app.env, now, planUsage),
    openCodeWeek(app.env, now, planUsage),
  ]);
  const codex = app.sources.find((source) => source.name === "codex")?.week?.(now) ?? null;
  const usage: Record<string, number | null> = {
    claude: plan?.used ?? null,
    codex: codex?.used ?? null,
    opencode: open?.used ?? null,
  };
  let report = null;
  if (settings.conditions.sessionSpike) {
    await app.reports.refresh();
    report = app.reports.getReport(7, "all", { now, weeklyBudget, planWeek: plan, opencodeWeek: open });
  }
  return runAlerts(app.env, { now, feed: snapshot.feed, fresh: !snapshot.stale, usage, settings, report });
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

/**
 * A write has to come from this dashboard. A browser sends Origin on every POST and Sec-Fetch-Site
 * with every fetch; a cross-site page cannot fake either into this loopback origin.
 */
function sameOrigin(req: Request): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
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
    fetching ??= Promise.all([planWeek(app.env, app.now(), true), openCodeWeek(app.env, app.now(), true)])
      .then(([week]) => {
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
    const source = query.source === "claude" || query.source === "codex" || query.source === "opencode" ? query.source : options.source;
    rescan(app); // the answer is the report we have now; the next poll sees the new scan
    const report = app.reports.getRaw(days, source, {
      weeklyBudget: options.weeklyBudget,
      planWeek: await plan(now),
      opencodeWeek: await openCodeWeek(app.env, now, false),
      now,
    });
    if (options.planUsage) setImmediate(refresh); // after this response: the keychain read must not block it
    return report;
  }

  @Controller()
  class ReportController {
    @Get("/api/fix-config")
    pendingFixes(@Res() res: Response) {
      const live = app.reports.live("all"); // repairs for agents that are not installed are not offered
      const pending = pendingRepairs(app.env).filter((id) => live.some((agent) => id.startsWith(`${agent}-`)));
      return res.set("Cache-Control", "no-store").json({ pending });
    }

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

    @Get("/api/resets")
    async resets(@Res() res: Response) {
      // The shared cache answers; a cold one fetches once and every later request reads that.
      const snapshot = await resetsSnapshot(app.now());
      return res.set("Cache-Control", "no-store").json(snapshot);
    }

    @Get("/api/notifications")
    notifications(@Res() res: Response) {
      return res.set("Cache-Control", "no-store").json(publicSettings(loadSettings(app.env)));
    }

    @Post("/api/notifications")
    saveNotifications(@Req() req: Request, @Res() res: Response) {
      if (!sameOrigin(req)) return res.status(403).json({ error: "Save from this dashboard." });
      const { settings, error } = mergeSettings(app.env, req.body);
      if (error) return res.status(400).json({ error });
      saveSettings(app.env, settings);
      return res.json(publicSettings(settings));
    }

    @Post("/api/notifications/test")
    async testNotifications(@Req() req: Request, @Res() res: Response) {
      if (!sameOrigin(req)) return res.status(403).json({ error: "Send from this dashboard." });
      const settings = loadSettings(app.env);
      const results = await deliver(app.env, settings, "Token Furnace",
        "Test notification from Token Furnace. Alerts are working.");
      const ok = results.length > 0 && results.every((result) => result.ok);
      // Empty means no channel is on: neither a delivery nor a suppression.
      const skipped = results.length > 0 && results.every((result) => result.skipped);
      return res.status(ok || skipped || results.length === 0 ? 200 : 502).json({
        ok,
        skipped,
        // Status only: an error string never carries the destination URL or the token.
        results: results.map((result) => ({ channel: result.channel, ok: result.ok, error: result.error })),
      });
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
