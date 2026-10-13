// Dev: tsup watch rebuilds the CLI and restarts the API server (8766); vite serves the page with HMR (5173).
// Vite proxies /api to the server, see web/vite.config.ts. Works under pnpm, yarn and npm.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ok = (v) => { const [a, b] = v.replace(/^v/, "").split(".").map(Number); return a > 22 || (a === 22 && b >= 13); };
if (!ok(process.versions.node)) {
  // The shell's Node is too old (server needs node:sqlite). Re-run under the newest nvm Node that fits.
  const root = join(process.env.NVM_DIR ?? join(homedir(), ".nvm"), "versions/node");
  const found = existsSync(root) ? readdirSync(root).filter(ok).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] : undefined;
  if (!found) { console.error(`[dev] Node ${process.versions.node} is too old and no nvm Node >=22.13 found. Install one: nvm install 24`); process.exit(1); }
  const nodeDir = join(root, found, "bin");
  console.log(`[dev] shell Node ${process.versions.node} is too old, using ${found}`);
  const re = spawnSync(join(nodeDir, "node"), process.argv.slice(1), { stdio: "inherit", env: { ...process.env, PATH: `${nodeDir}:${process.env.PATH}` } });
  process.exit(re.status ?? 1);
}

// The server needs a built page. A first run has none, so build once.
if (!existsSync("dist/web/index.html")) {
  console.log("[dev] no dist/web yet, running a full build first");
  const pm = process.env.npm_execpath;
  const build = pm ? spawnSync(process.execPath, [pm, "run", "build"], { stdio: "inherit" }) : spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  if (build.status !== 0) process.exit(1);
}

// Own API port, so a normal `token-furnace serve` on 8765 does not clash.
const API_PORT = 8766;
const bin = (name) => `node_modules/.bin/${name}`;
const children = [
  // --no-clean keeps dist/web, which the server serves.
  spawn(bin("tsup"), ["--watch", "--no-clean", "--onSuccess", `node dist/cli.js serve --port ${API_PORT}`], { stdio: "inherit" }),
  spawn(bin("vite"), ["--config", "web/vite.config.ts", "--open"], { stdio: "inherit", env: { ...process.env, TF_API_PORT: String(API_PORT) } }),
];
console.log(`[dev] page http://localhost:5173 (HMR), API http://127.0.0.1:${API_PORT} (restarts on src/ change). Ctrl+C stops both.`);

const stop = () => children.forEach((child) => child.kill());
for (const child of children) child.on("exit", () => { stop(); process.exit(); });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
