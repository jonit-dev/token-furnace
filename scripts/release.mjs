// Release: pnpm release [patch|minor|major|x.y.z] ["short note"]
// Checks, bumps the version, commits "chore(release): X with <note>", pushes, publishes to npm.
// Named "release", not "deploy": pnpm has a built-in `pnpm deploy` that would shadow a script.
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const [bump = "patch", note] = process.argv.slice(2);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: opts.show ? "inherit" : ["ignore", "pipe", "inherit"] }).trim();
const fail = (msg) => { console.error(`[release] ${msg}`); process.exit(1); };

if (sh("git", ["branch", "--show-current"]) !== "main") fail("run from the main branch");
if (sh("git", ["status", "--porcelain", "--untracked-files=no"])) fail("tracked files have uncommitted changes");
sh("git", ["pull", "--ff-only"], { show: true });

console.log("[release] typecheck + tests (tests build first)");
sh("npm", ["run", "typecheck"], { show: true });
sh("npm", ["test"], { show: true });

const answer = await createInterface({ input: process.stdin, output: process.stdout }).question(`[release] bump ${bump}, push and publish to npm as ${sh("npm", ["whoami"])}? [y/N] `);
if (answer.trim().toLowerCase() !== "y") fail("aborted, nothing changed");

const version = sh("npm", ["version", bump, "--no-git-tag-version"]).replace(/^v/, "");
sh("git", ["commit", "-am", `chore(release): ${version}${note ? ` with ${note}` : ""}`], { show: true });
sh("git", ["push"], { show: true });
sh("npm", ["publish"], { show: true });
console.log(`[release] published token-furnace@${version}`);
