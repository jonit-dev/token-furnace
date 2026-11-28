import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reportView } from "../core/analyze/view";
import type { RawReport } from "../core/model";

/** The built React page: next to the bundle in dist/, or in dist/ when running from src. */
const PAGE = ["./web/index.html", "../../dist/web/index.html"];

/** The raw page, which the server serves for hot reload and the CLI embeds. */
export function loadPage(): string {
  for (const path of PAGE) {
    try {
      return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    } catch {
      continue;
    }
  }
  throw new Error("Built page dist/web/index.html not found. Run `npm run build`.");
}

/** The built page with the report embedded, for a static file or the first paint. burn.py:1498 */
export function renderHtml(report: RawReport, now: Date, page = loadPage()): string {
  // Every `<` goes in as `\u003c`, which JSON reads back as the same character: no text a session
  // title or a provider's credit title carries can close the script tag or open an HTML comment
  // that would swallow the page after it.
  const data = JSON.stringify(reportView(report, now)).replace(/</g, "\\u003c");
  return page.replace("/*REPORT*/null", () => data);
}