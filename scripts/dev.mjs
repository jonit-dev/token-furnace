// Dev: tsup watch rebuilds the CLI and restarts the API server (8765); vite serves the page with HMR (5173).
// Vite proxies /api to the server, see web/vite.config.ts. Works under pnpm, yarn and npm.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// The server needs a built page. A first run has none, so build once.
if (!existsSync("dist/web/index.html")) {
  console.log("[dev] no dist/web yet, running a full build first");
  const pm = process.env.npm_execpath;
  const build = pm ? spawnSync(process.execPath, [pm, "run", "build"], { stdio: "inherit" }) : spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  if (build.status !== 0) process.exit(1);
}

const bin = (name) => `node_modules/.bin/${name}`;
const children = [
  // --no-clean keeps dist/web, which the server serves.
  spawn(bin("tsup"), ["--watch", "--no-clean", "--onSuccess", "node dist/cli.js serve"], { stdio: "inherit" }),
  spawn(bin("vite"), ["--config", "web/vite.config.ts", "--open"], { stdio: "inherit" }),
];
console.log("[dev] page http://localhost:5173 (HMR), API http://127.0.0.1:8765 (restarts on src/ change). Ctrl+C stops both.");

const stop = () => children.forEach((child) => child.kill());
for (const child of children) child.on("exit", () => { stop(); process.exit(); });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
