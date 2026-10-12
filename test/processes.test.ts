import { expect, it } from "vitest";
import { parseHeadless } from "../src/services/processes";

const lines = (...l: string[]) => l.join("\n");

it("counts codex exec --ephemeral as a hidden run and other headless runs as visible", () => {
  const got = parseHeadless(lines(
    "/home/u/.local/bin/codex exec -m gpt-6.1-sol -c model_reasoning_effort=\"high\" --dangerously-bypass-approvals-and-sandbox --ephemeral --skip-git-repo-check -",
    "/usr/bin/codex exec --json do the thing",
    "opencode run -m opencode-go/glm-5 fix it",
    "claude -p summarize this",
    "claude -p --no-session-persistence quick",
  ));
  expect(got).toEqual({ hidden: { codex: 1, claude: 1 }, visible: { codex: 1, opencode: 1, claude: 1 } });
});

it("ignores interactive sessions, daemons, zombies, helpers and shells that only mention an agent", () => {
  const got = parseHeadless(lines(
    "/home/u/.local/bin/codex",
    "codex resume --last",
    "/x/bin/codex app-server daemon pid-update-loop",
    "/x/bin/codex-code-mode-host",
    "[codex] <defunct>",
    "opencode",
    "opencode serve --port 4096",
    "claude",
    "/usr/bin/zsh -c source snap.sh && codex exec --ephemeral -m x 'prompt'",
    "grep codex exec",
    "node /home/u/projects/app/server.js run",
    "",
  ));
  expect(got).toEqual({ hidden: {}, visible: {} });
});

it("sees agents started through node or bun and Windows-style quoted paths", () => {
  const got = parseHeadless(lines(
    "node /opt/lib/node_modules/@openai/codex/bin/codex.js exec --ephemeral hi",
    "bun /home/u/.bun/bin/opencode run hello",
    '"C:\\Program Files\\Codex\\codex.exe" exec --ephemeral "a prompt with exec in it"',
    '"C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd" run go',
  ));
  expect(got).toEqual({ hidden: { codex: 2 }, visible: { opencode: 2 } });
});

it("handles empty and garbage input", () => {
  expect(parseHeadless("")).toEqual({ hidden: {}, visible: {} });
  expect(parseHeadless("\u0000\n   \n'unterminated")).toEqual({ hidden: {}, visible: {} });
});
