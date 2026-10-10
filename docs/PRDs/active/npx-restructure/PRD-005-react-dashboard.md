# PRD-005 — React dashboard replaces `dashboard.html`

**Status:** NOT STARTED
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
- `server.ts` and `--html` switch from `web/legacy/dashboard.html` to `dist/web/index.html`. The placeholder becomes `window.__REPORT__ = null`, and the JSON is escaped for `</` as in Python.

## Acceptance Criteria

- [ ] AC-1 [local]: `npm run build` produces `dist/web/index.html` with no external `<script>` or `<link>` URL. proof: `grep -cE 'src="https?:|href="https?:' dist/web/index.html` prints 0 — Evidence: pending.
- [ ] AC-2 [local]: Rendering `App` with the fixture `Report` shows every panel of the legacy page (Act now, active sessions, KPIs, leaks, burndown, weekly quota, hourly, checks, sessions). proof: `npx vitest run web/src/app.test.tsx` — Evidence: pending.
- [ ] AC-3 [local]: The copy button puts the issue `prompt` on the clipboard. A failed refresh keeps the data and shows the offline tag. proof: `npx vitest run web/src/app.test.tsx` — Evidence: pending.
- [ ] AC-4 [local]: `npx tsc --noEmit -p web` passes with the shared `Report` type and no `any`. proof: `npx tsc --noEmit -p web && grep -rn ": any" web/src` returns no lines — Evidence: pending.
- [ ] AC-5 [local]: `token-furnace serve` and an `--html` file both show the new dashboard with live data, side by side with a screenshot of the legacy page. proof: browser check, screenshots in the PR — Evidence: pending.
- [ ] AC-6 [local]: `web/legacy/` is deleted. proof: `git ls-files web/legacy` prints nothing — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Live dashboard | `token-furnace serve` → `/` → `dist/web/index.html` | `web/legacy/dashboard.html`, deleted | AC-5 |
| Static report | `--html` → `dist/web/index.html` + inlined JSON | legacy page | AC-1, AC-5 |

## Execution Phases

#### Phase 1: Vite app shell
**Status:** NOT STARTED
**Files:** `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/src/main.tsx`, `web/src/store.ts`, `web/src/use-report.ts`, `package.json` (dev dependencies and `build` script)
**Implementation:** Add `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `zustand`, `tailwindcss`, `vite-plugin-singlefile`, `@testing-library/react`, and `jsdom` as dev dependencies. Copy the Tailwind theme tokens from the legacy page config.
**Verification:** `npm run build` — AC-1.

#### Phase 2: Port the components
**Status:** NOT STARTED
**Files:** `web/src/components/*.tsx`, `web/src/app.test.tsx`
**Implementation:** Read the legacy page one component at a time and port it. Keep the markup and Tailwind classes. Replace `htm` templates with JSX.
**Verification:** `npx vitest run web/src/app.test.tsx` — AC-2, AC-3. `npx tsc --noEmit -p web` — AC-4.

#### Phase 3: Switch over
**Status:** NOT STARTED
**Files:** `src/server.ts`, `src/render/html.ts`, delete `web/legacy/`
**Implementation:** Point the server and `--html` at the build output. Fail with a clear message if `dist/web/index.html` is missing.
**Verification:** Browser check — AC-5. `git ls-files web/legacy` — AC-6.
