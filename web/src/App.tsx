import { useEffect, type ReactNode } from "react";
import type { Burn, Report, Source } from "../../src/core/model";
import { useReport } from "./use-report";
import { useUi, type Tab } from "./store";
import { FixConfig } from "./components/fix-config";
import { Icon } from "./components/icons";
import { Updated } from "./components/ui";
import { Dashboard } from "./components/panels";
import { Checks, Leaks, Sessions } from "./components/tables";
import { Tips } from "./components/tips";

const TABS: [Tab, string][] = [
  ["dashboard", "Dashboard"],
  ["checkup", "Checkup"],
  ["sessions", "Sessions"],
  ["tips", "Tips"],
];

// Old hashes keep working.
const TAB_ALIAS: Record<string, Tab> = { leaks: "checkup", baseline: "checkup", details: "sessions" };

export function App() {
  const report = useReport();
  const tab = useUi((state) => state.tab);
  const setTab = useUi((state) => state.setTab);
  const source = useUi((state) => state.source);
  const setSource = useUi((state) => state.setSource);
  const online = useUi((state) => state.online);

  useEffect(() => {
    const apply = () => {
      const raw = location.hash.slice(1);
      const wanted = TAB_ALIAS[raw] ?? raw;
      setTab(TABS.find(([id]) => id === wanted)?.[0] ?? "dashboard");
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [setTab]);

  const r: Partial<Report> = report ?? {};
  const burns: Partial<Record<Source, Burn>> = r.burns ?? (r.burn ? { claude: r.burn } : {});
  const sources = Object.keys(burns) as Source[];
  const current = sources.includes(source) ? source : sources[0];
  const burn = current ? burns[current] : undefined;
  const hours = r.checkHours ?? 24;
  const days = r.days ?? 0;

  const bodies: Record<Tab, ReactNode> = {
    dashboard: <Dashboard r={r} burn={burn} sources={sources} source={current} onSource={setSource} />,
    checkup: (
      <div className="space-y-3">
        <Checks rows={r.baseline ?? []} hours={hours} days={days} />
        <Leaks issues={r.issues ?? []} hours={hours} />
      </div>
    ),
    sessions: <Sessions r={r} />,
    tips: <Tips />,
  };
  const filePage = location.protocol !== "http:" && location.protocol !== "https:";
  const linkClass = filePage
    ? "bg-chip text-muted"
    : online
      ? "bg-ok/10 text-ok"
      : "bg-hot/10 text-hot";

  return (
    <div className="max-w-7xl mx-auto px-4 pb-3">
      <header className="flex flex-wrap items-stretch gap-x-5 border-b border-line">
        <a href="#dashboard" className="flex items-center gap-2 py-2.5" aria-label="Token Furnace - Dashboard">
          <Icon name="Flame" size={20} className="text-accent glow" />
          <h1 className="font-heading text-lg font-bold tracking-tight">Token Furnace</h1>
        </a>
        <nav className="flex order-last w-full sm:order-none sm:w-auto">
          {TABS.map(([id, name]) => (
            <a
              key={id}
              href={`#${id}`}
              className={`flex items-center px-3 text-sm -mb-px border-b-2 ${
                id === tab ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {name}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted py-2.5">
          <FixConfig />
          <span className={`px-2 py-0.5 rounded ${linkClass}`}>
            {filePage ? "snapshot" : online ? "live" : "offline"}
          </span>
          <Updated iso={r.generated} />
          <span>· {days}-day window</span>
        </div>
      </header>
      <main className="mt-3">
        {report || filePage ? bodies[tab] : <p className="text-sm text-muted py-6">Loading report…</p>}
      </main>
    </div>
  );
}
