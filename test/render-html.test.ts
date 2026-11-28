/** The static page: the report JSON goes in whole, whatever text a transcript or a provider put in it. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport } from "../src/core/analyze/report";
import { renderHtml } from "../src/render/html";
import { buildFull } from "./fixtures/build";
import { fixedNow, harnessEnv, reportInput } from "./harness";

const PAGE = "<script>window.__REPORT__ = /*REPORT*/null;</script>";
const now = fixedNow();
const root = mkdtempSync(join(tmpdir(), "tf-html-"));
buildFull(root, now);

/** The report the page embeds, read back out of the script it was written into. */
function embedded(html: string): Record<string, any> {
  const start = html.indexOf("window.__REPORT__ = ") + "window.__REPORT__ = ".length;
  return JSON.parse(html.slice(start, html.lastIndexOf(";</script>")));
}

describe("renderHtml", () => {
  it("embeds a provider's own text literally, even when it looks like a replacement pattern", () => {
    const report = buildReport(reportInput(harnessEnv(root, now), now, 7, null, "all"))!;
    const title = "free $' and $& and </script> reset";
    report.bankedResets = snapshot(title);

    const html = renderHtml(report, now, PAGE);

    // `$'` and `$&` are literal text, and the escaped closing tag is the only one before the end.
    expect(embedded(html).bankedResets.providers.claude.grants[0].title).toBe(title);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it("cannot let an HTML comment in a title swallow the page after the script", () => {
    const report = buildReport(reportInput(harnessEnv(root, now), now, 7, null, "all"))!;
    const title = "<!--<script> and </script> both";
    report.bankedResets = snapshot(title);

    const html = renderHtml(report, now, PAGE);

    expect(embedded(html).bankedResets.providers.claude.grants[0].title).toBe(title);
    expect(html).not.toContain("<!--"); // nothing in the JSON can open a comment or a tag
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.endsWith(";</script>")).toBe(true);
  });
});

/** One Claude credit whose title is the text under test. */
function snapshot(title: string) {
  return {
    fetchedAt: now.toISOString(),
    providers: {
      claude: {
        source: "api.anthropic.com", availableCount: 1, nextExpiresAt: null, fetchedAt: null, stale: false, state: "ok" as const,
        grants: [{ id: "full-reset-1", title, description: "", status: "available", remaining: 1, total: 1, scope: "Weekly limits", grantedAt: null, expiresAt: null }],
      },
    },
  };
}
