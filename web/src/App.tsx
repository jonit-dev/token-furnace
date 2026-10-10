import { useReport } from "./use-report";

// This is a temporary shell. The component port replaces the loading line.
export function App() {
  useReport();

  return (
    <div className="max-w-7xl mx-auto px-4 pb-3">
      <header className="py-2.5 border-b border-line">
        <h1 className="font-heading text-lg font-bold tracking-tight">Token Furnace</h1>
      </header>
      <main className="mt-3 text-muted">Loading...</main>
    </div>
  );
}
