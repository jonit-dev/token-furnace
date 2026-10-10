# PRD-005 — React dashboard replaces `dashboard.html`

**Status:** COMPLETE — React single-file Vite + TypeScript dashboard landed; legacy page deleted; all acceptance criteria verified.
**Priority:** P2 — AC-1 and AC-4 remove the CDN dependency and type the dashboard against the `Report` contract.
**Complexity:** 6 (MEDIUM)
**Owner:** João
**Depends on:** PRD-003

## Context

- `web/legacy/dashboard.html` (737 lines, moved in PRD-003) is React 18 + `htm` + Tailwind 3.4 from `cdn.tailwindcss.com`, with no build.
- Components: `App`, `Dashboard`, `ActNow`, `ActiveSessions`, `KpiStrip`, `Leaks`/`LeakRow` (with `CopyButton` for the copy-to-Claude prompt), `Burndown`, `WeeklyQuota`/`WeekBar`, `Hourly`, `Checks`, `Sessions`, `Gauge`, `Spark`, `Tile`, `SourceToggle`, `SourceBadge`, `LevelTag`, `Updated`. Tabs come from `TABS`.
- Data: the inlined `/*REPORT*/null` for the first paint, then `fetch('/api/report')` every 60 seconds. A failed fetch keeps the old data and shows an offline tag. A second timer polls `/dashboard.html` for hot reload.

## Solution

- `web/`: Vite + React + TypeScript + Tailwind (build-time, no CDN). Output goes to `dist/web/index.html` with assets inlined, so `--html` stays one file.
- Port each legacy component to `web/src/components/`, with the same panels, texts, and colors. Props use the `Report` types from `src/core/model.ts`.
- `web/src/store.ts`: one Zustand store for UI state only: active tab, selected burn source, and online/offline. Report data stays in one `useReport()` hook: initial value from `window.__REPORT__`, then refresh every 60 seconds.
- Remove the `/dashboard.html` hot-reload poll. `vite dev` with a proxy to `token-furnace serve` covers development.
- `server.ts` and `--html` switch from `web/legacy/dashboard.html` to `dist/web/index.html`. The embedded placeholder is `window.__REPORT__ = /*REPORT*/null`; `renderHtml` replaces the `/*REPORT*/null` token with the report JSON, escaped for `</` as in Python.

## Acceptance Criteria

- [x] AC-1 [local]: `npm run build` produces `dist/web/index.html` with no external `<script>` or `<link>` URL. proof: `grep -cE 'src="https?:|href="https?:' dist/web/index.html` prints 0 — Evidence: built `dist/web/index.html` (275876 bytes); grep prints `0` (2026-10-10).
- [x] AC-2 [local]: Rendering `App` with the fixture `Report` shows every panel of the legacy page (Act now, active sessions, KPIs, leaks, burndown, weekly quota, hourly, checks, sessions). proof: `npx vitest run web/src/app.test.tsx` — Evidence: 6/6 pass, including "renders every legacy panel for the fixture report" (all labels plus gauge, quota, and hourly charts) (2026-10-10).
- [x] AC-3 [local]: The copy button puts the issue `prompt` on the clipboard. A failed refresh keeps the data and shows the offline tag. proof: `npx vitest run web/src/app.test.tsx` — Evidence: "copies the issue prompt to the clipboard" and "keeps the fixture totals and shows offline after a rejected refresh" pass (2026-10-10).
- [x] AC-4 [local]: `npx tsc --noEmit -p web` passes with the shared `Report` type and no `any`. proof: `npx tsc --noEmit -p web && grep -rn ": any" web/src` returns no lines — Evidence: `tsc --noEmit` and `tsc --noEmit -p web` both exit 0; `grep -rn ": any" web/src --include='*.ts' --include='*.tsx'` returns no lines (2026-10-10).
- [x] AC-5 [local]: `token-furnace serve` and an `--html` file both show the new dashboard with live data, side by side with a screenshot of the legacy page. proof: browser check, screenshots in the PR — Evidence: CLI `--html` file from the `buildFull` fixture opens over `file://` with the `snapshot` badge and every panel, zero console errors; `serve` on port 8780 renders the live report with working tabs. Legacy and new pages show identical text across all 3 tabs and identical geometry for all 8 chart SVGs at 1280x900. Screenshots: `.playwright-mcp/legacy-dashboard.png`, `.playwright-mcp/react-dashboard.png`, `.playwright-mcp/live-react-dashboard.png` (2026-10-10).
- [x] AC-6 [local]: `web/legacy/` is deleted. proof: `git ls-files web/legacy` prints nothing — Evidence: prints nothing (2026-10-10).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Live dashboard | `token-furnace serve` → `/` → `dist/web/index.html` | `web/legacy/dashboard.html`, deleted | AC-5 |
| Static report | `--html` → `dist/web/index.html` + inlined JSON | legacy page | AC-1, AC-5 |

## Execution Phases

#### Phase 1: Vite app shell
**Status:** COMPLETE
**Files:** `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/src/main.tsx`, `web/src/store.ts`, `web/src/use-report.ts`, `package.json` (dev dependencies and `build` script)
**Implementation:** Added `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `zustand`, `tailwindcss`, `vite-plugin-singlefile`, `@testing-library/react`, and `jsdom` as dev dependencies. Copied the Tailwind theme tokens from the legacy page config. The build emits one file with assets inlined.
**Verification:** `npm run build` — AC-1 pass.

#### Phase 2: Port the components
**Status:** COMPLETE
**Files:** `web/src/components/*.tsx`, `web/src/app.test.tsx`
**Implementation:** Ported each legacy component to JSX with the same markup and Tailwind classes.
**Verification:** `npx vitest run web/src/app.test.tsx` — AC-2 and AC-3 pass (6/6). `npx tsc --noEmit -p web` — AC-4 pass.

#### Phase 3: Switch over
**Status:** COMPLETE
**Files:** `src/server.ts`, `src/render/html.ts`, delete `web/legacy/`
**Implementation:** The server and `--html` load `dist/web/index.html` through `loadPage`, which fails with a clear message when the build is missing. Deleted `web/legacy/`.
**Verification:** Browser check — AC-5 pass. `git ls-files web/legacy` — AC-6 pass.


Integrated checks (2026-10-10, Node 24.16.0): build, root/web typecheck and all 82 tests across 13 files pass.
