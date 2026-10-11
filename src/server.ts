/**
 * The live report: Express on 127.0.0.1 with routing-controllers, rebuilding the report on every
 * request. burn.py serve(). Every route is a controller method: no vanilla routers.
 */

import type { Server } from "node:http";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import "reflect-metadata";
import express, { type Request, type Response } from "express";
import { Controller, Get, Post, Middleware, Param, Req, Res, useExpressServer, type ExpressMiddlewareInterface } from "routing-controllers";
import { reportView } from "./core/analyze/view";
import { loadPage, renderHtml } from "./render/html";
import { loadingPage } from "./render/loading";
import type { App } from "./compose";
import type { Source, Week } from "./core/model";
import { PROVIDERS } from "./core/providers";
import type { BudgetScope } from "./core/budgets";
import type { StopTargetOutcome } from "./services/budget-service";
import { controlTargetProof } from "./services/agent-control";
import { CONFIG_REPAIRS, type ConfigRepairId } from "./core/config-repairs";
import { installBudgetAdapters, pendingRepairs, runFixConfig } from "./setup/agents";
import { openCodeWeek, planReading, planWeek } from "./services/usage-client";
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
    controllers: [reportController(app, options, loadPage(), randomBytes(24).toString("base64url"))],
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
      http.close(() => { app.budgets.close(); app.control.close(); done(); });
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
function reportController(app: App, options: ServeOptions, page: string, mutationToken: string) {
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
    @Get("/api/budgets")
    async budgets(@Res() res: Response) {
      await refreshBudgetMeters(app, options.planUsage);
      return res.set("Cache-Control", "no-store").json({
        ...app.budgets.snapshot(budgetSources(app)),
        mutationToken,
      });
    }

    @Post("/api/budgets")
    saveBudgets(@Req() req: Request, @Res() res: Response) {
      const denied = budgetWriteError(req, mutationToken);
      if (denied) return res.status(denied.status).json({ error: denied.message });
      const expectedRevision = req.body?.expectedRevision;
      const policies = req.body?.policies;
      if (!Number.isInteger(expectedRevision) || !Array.isArray(policies)) {
        return res.status(400).json({ error: "Expected a revision and a policy list." });
      }
      try {
        const saved = app.budgets.savePolicies(policies, expectedRevision);
        seedBudgetUsage(app);
        return res.json(saved);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(/revision|stale/i.test(message) ? 409 : 400).json({ error: message });
      }
    }

    @Post("/api/budgets/enable")
    enableBudgets(@Req() req: Request, @Res() res: Response) {
      const denied = budgetWriteError(req, mutationToken);
      if (denied) return res.status(denied.status).json({ error: denied.message });
      if (req.body?.confirm !== true) return res.status(400).json({ error: "Enable enforcement requires explicit confirmation." });
      let output = "";
      const code = installBudgetAdapters(app.env, { apply: true }, { write: (text) => { output += text; } });
      return res.status(code === 0 ? 200 : 500).json({ ok: code === 0, output });
    }

    @Post("/api/budgets/enable-preview")
    previewBudgetAdapters(@Req() req: Request, @Res() res: Response) {
      const denied = budgetWriteError(req, mutationToken);
      if (denied) return res.status(denied.status).json({ error: denied.message });
      let output = "";
      const code = installBudgetAdapters(app.env, { apply: false }, { write: (text) => { output += text; } });
      return res.status(code === 0 ? 200 : 500).json({ ok: code === 0, output });
    }

    @Post("/api/budgets/stop-preview")
    stopPreview(@Req() req: Request, @Res() res: Response) {
      const denied = budgetWriteError(req, mutationToken);
      if (denied) return res.status(denied.status).json({ error: denied.message });
      try {
        const scope = stopScope(req.body?.scope);
        const control = app.control.preview(scope);
        return res.json({
          ...app.budgets.previewStop(scope, control.targets.map((target) => target.id), controlTargetProof(control.targets)),
          targets: control.targets.map((target) => ({ id: target.id, source: target.source, provider: target.provider, account: target.account ?? null, model: target.model, pid: target.pid, processStartTime: target.processStartTime, ownerUid: target.ownerUid, executable: target.executable })),
          unverified: control.unverified,
          collateral: control.collateral,
        });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }

    @Post("/api/budgets/stop")
    async stop(@Req() req: Request, @Res() res: Response) {
      const denied = budgetWriteError(req, mutationToken);
      if (denied) return res.status(denied.status).json({ error: denied.message });
      const preview = app.budgets.preview(req.body?.previewId);
      if (!preview || preview.fingerprint !== req.body?.fingerprint) return res.status(409).json({ error: "Stop preview is stale or already used." });
      if (req.body?.force && req.body?.forceConfirm !== true) return res.status(400).json({ error: "Force stop requires a fresh explicit confirmation." });
      const currentControl = app.control.preview(preview.scope);
      const currentTargetIds = currentControl.targets.map((target) => target.id).sort();
      if (JSON.stringify(currentTargetIds) !== JSON.stringify(preview.targetIds) || controlTargetProof(currentControl.targets) !== (preview.targetProof ?? controlTargetProof(currentControl.targets))) {
        return res.status(409).json({ error: "Stop preview targets changed; preview again." });
      }
      const initial: StopTargetOutcome[] = preview.targetIds.map((targetId) => ({ targetId, status: "requested" }));
      try {
        const operation = app.budgets.commitStop(preview.id, preview.fingerprint, initial);
        let outcomes: StopTargetOutcome[];
        try {
          outcomes = await app.control.stop(preview.scope, Boolean(req.body?.force));
        } catch (error) {
          outcomes = preview.targetIds.map((targetId) => ({
            targetId,
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          }));
        }
        const updated = app.budgets.updateOperation(operation.id, outcomes) ?? operation;
        return res.json(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(/stale|expired|used/i.test(message) ? 409 : 400).json({ error: message });
      }
    }

    @Get("/api/budgets/operations/:id")
    operation(@Param("id") id: string, @Res() res: Response) {
      const operation = app.budgets.operation(id);
      return operation ? res.set("Cache-Control", "no-store").json(operation) : res.status(404).json({ error: "Operation not found." });
    }

    @Post("/api/budgets/unlock")
    unlock(@Req() req: Request, @Res() res: Response) {
      const denied = budgetWriteError(req, mutationToken);
      if (denied) return res.status(denied.status).json({ error: denied.message });
      try {
        app.budgets.unlock(stopScope(req.body?.scope));
        return res.json({ ok: true });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }

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
      // A fresh install has no report yet, but the control surface is still useful.
      return res.type("text/html").send(report ? renderHtml(report, app.now(), page) : page);
    }
  }
  return ReportController;
}

function budgetSources(app: App) {
  const models = new Map<Source, Set<string>>();
  const providers = new Map<Source, Set<string>>();
  for (const session of app.repo.all()) {
    const sourceModels = models.get(session.source) ?? new Set<string>();
    const sourceProviders = providers.get(session.source) ?? new Set<string>();
    for (const turn of session.turns) {
      const model = turn.model.trim();
      if (!model) continue;
      sourceModels.add(model);
      const slash = model.indexOf("/");
      if (slash > 0) sourceProviders.add(model.slice(0, slash).trim().toLowerCase());
    }
    models.set(session.source, sourceModels);
    providers.set(session.source, sourceProviders);
  }
  for (const target of app.control.registered()) {
    if (target.provider) {
      const values = providers.get(target.source) ?? new Set<string>();
      values.add(target.provider);
      providers.set(target.source, values);
    }
  }
  for (const [source, observed] of app.budgets.observedProviders()) {
    const values = providers.get(source) ?? new Set<string>();
    for (const provider of observed) values.add(provider);
    providers.set(source, values);
  }
  return (Object.keys(PROVIDERS) as Source[]).map((source) => {
    const adapter = app.sources.find((candidate) => candidate.name === source);
    return {
      source,
      label: PROVIDERS[source].label,
      installed: Boolean(adapter && existsSync(adapter.root())),
      models: [...(models.get(source) ?? [])].sort(),
      providers: [...(providers.get(source) ?? [])].sort(),
    };
  });
}

function seedBudgetUsage(app: App): void {
  const events: Array<{ scope: BudgetScope; amount: number; eventId: string; at: Date }> = [];
  for (const session of app.repo.all()) {
    for (const [index, turn] of session.turns.entries()) {
      const amount = turn.baseIn + turn.cacheRead + turn.cacheWrite + turn.output;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const eventId = `transcript:${session.path}:${index}:${turn.when.getTime()}`;
      events.push({ scope: { kind: "source", source: session.source }, amount, eventId, at: turn.when });
      const slash = turn.model.indexOf("/");
      if (slash > 0 && slash < turn.model.length - 1) {
        const provider = turn.model.slice(0, slash);
        const model = turn.model.slice(slash + 1);
        events.push({ scope: { kind: "provider", provider }, amount, eventId: `${eventId}:provider`, at: turn.when });
        events.push({ scope: { kind: "model", provider, model }, amount, eventId: `${eventId}:model`, at: turn.when });
      }
    }
  }
  if (events.length) app.budgets.seedRecentUsage(events);
}

async function refreshBudgetMeters(app: App, network: boolean): Promise<void> {
  const now = app.now();
  const [plan, open] = await Promise.all([
    planReading(app.env, now, network),
    openCodeWeek(app.env, now, network),
  ]);
  const codex = app.sources.find((source) => source.name === "codex")?.weekReading?.(now)
    ?? app.sources.find((source) => source.name === "codex")?.week?.(now) ?? null;
  const meters = [
    plan ? { id: "anthropic:weekly", source: "claude" as const, provider: "anthropic", account: plan.account ?? null, usedPercentagePoints: plan.used, resetAt: plan.resets, observedAt: validObservedAt(plan.observedAt), authoritative: plan.authoritative ?? true, window: plan.window } : null,
    codex ? { id: "openai:weekly", source: "codex" as const, provider: "openai", account: codex.account ?? null, usedPercentagePoints: codex.used, resetAt: codex.resets, observedAt: validObservedAt(codex.observedAt), authoritative: codex.authoritative ?? true, window: codex.window } : null,
    open ? { id: "opencode-go:weekly", source: "opencode" as const, provider: "opencode-go", account: open.account ?? null, usedPercentagePoints: open.used, resetAt: open.resets, observedAt: validObservedAt(open.observedAt), authoritative: open.authoritative ?? true, window: open.window } : null,
  ].filter((meter): meter is NonNullable<typeof meter> => meter !== null);
  if (meters.length) app.budgets.setMeters(meters);
}

function validObservedAt(value: Date | undefined): Date {
  return value && Number.isFinite(value.getTime()) ? value : new Date(0);
}

function budgetWriteError(req: Request, mutationToken: string): { status: number; message: string } | null {
  if (!sameOrigin(req)) return { status: 403, message: "Save from this dashboard." };
  if (req.headers["x-token-furnace-mutation"] !== mutationToken) return { status: 403, message: "Missing or invalid mutation token." };
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return { status: 415, message: "Budget writes require application/json." };
  return null;
}

function stopScope(value: unknown): BudgetScope {
  if (!value || typeof value !== "object") throw new Error("Stop scope is required.");
  const scope = value as Record<string, unknown>;
  if (scope.kind === "source" && (scope.source === "claude" || scope.source === "codex" || scope.source === "opencode")) return { kind: "source", source: scope.source };
  if (scope.kind === "provider" && typeof scope.provider === "string" && scope.provider.trim()) return { kind: "provider", provider: scope.provider };
  if (scope.kind === "model" && typeof scope.provider === "string" && typeof scope.model === "string" && scope.provider.trim() && scope.model.trim()) return { kind: "model", provider: scope.provider, model: scope.model };
  throw new Error("Stop scope is unsupported.");
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
