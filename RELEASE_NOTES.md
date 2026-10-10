# Release notes

## 0.1.0 — preparation

First release of `token-furnace` as one npm package.

### Features

- Reads local Claude Code and Codex transcripts. Message text never leaves the machine.
- Terminal verdict, full text report, and `--json` for agents and scripts.
- `--html` writes a static report with the report JSON inlined.
- `serve` runs the live dashboard on `127.0.0.1`.
- `setup` installer: dry run by default, with `--apply`, `--verify`, `--rollback`, and `--aggressive`. Integrated and tested.
- `hook churn` PostToolUse hook.
- Disposable local SQLite cache. `--no-cache` skips it.
- Plan usage is on by default. `--no-plan-usage` disables the one network call.

### Requirements

- Node.js 22.13 or newer.

### Notes

- Publishing to npm is pending the package owner.
- The dashboard is a React + Vite + TypeScript single-file build (PRD-005). `--html` and `serve`
  both use it, with no external CDN links.
- The Node.js 24 smoke test passed: `npm pack`, a temporary install, and `npx` runs of the CLI,
  `--html`, and `serve` all matched. Node.js 22.13 is still under investigation.
