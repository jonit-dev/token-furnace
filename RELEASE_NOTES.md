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
- The package smoke test passes on both Node.js 22.13 and Node.js 24.16: `npm pack`, a temporary
  install, and `npx --no-install` runs of the CLI, `--html`, and `serve` all match. The tarball
  contains the allowed application files, npm metadata and the license.
- The full Vitest suite (86 tests), the root and web typechecks, and the build pass.
