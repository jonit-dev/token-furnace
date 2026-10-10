/**
 * The page `/` serves while the first scan runs: self-contained, so it needs no bundle. It polls
 * /api/status and reloads into the dashboard when the scan is done.
 */
export function loadingPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token Furnace: scanning</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { width: min(30rem, 90vw); text-align: center; }
  .spin { width: 3rem; height: 3rem; margin: 0 auto 1.25rem; border: 4px solid #8884; border-top-color: #e8590c;
          border-radius: 50%; animation: turn 0.9s linear infinite; }
  @keyframes turn { to { transform: rotate(360deg); } }
  .bar { height: 0.75rem; background: #8883; border-radius: 0.4rem; overflow: hidden; }
  .bar > div { height: 100%; width: 0; background: #e8590c; transition: width 0.4s; }
  small { opacity: 0.7; }
</style></head><body><main>
  <div class="spin" role="status" aria-label="Scanning"></div>
  <h1>Scanning your transcripts</h1>
  <p>Please wait. The first scan reads every Claude Code and Codex session once.</p>
  <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div id="fill"></div></div>
  <p id="text">Starting...</p>
  <small id="time"></small>
</main>
<script>
  const fill = document.getElementById("fill"), text = document.getElementById("text"), time = document.getElementById("time");
  const fmt = (n) => n.toLocaleString();
  async function tick() {
    try {
      const s = await (await fetch("/api/status", { cache: "no-store" })).json();
      if (s.phase === "ready") return location.reload();
      const pct = s.bytesTotal ? Math.min(99, Math.round((100 * s.bytesDone) / s.bytesTotal)) : 0;
      fill.style.width = pct + "%";
      text.textContent = s.filesTotal ? fmt(s.filesDone) + " of " + fmt(s.filesTotal) + " files (" + pct + "%)" : "Looking for transcripts...";
      if (s.startedAt) time.textContent = Math.round((Date.now() - s.startedAt) / 1000) + " s elapsed";
    } catch { /* the server is busy or restarting: try again */ }
    setTimeout(tick, 1000);
  }
  tick();
</script></body></html>`;
}
