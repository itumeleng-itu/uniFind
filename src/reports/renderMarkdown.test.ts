import { describe, expect, it } from "vitest";
import { renderReportMarkdown } from "./renderMarkdown";

describe("phase 7: renderReportMarkdown", () => {
  it("escapes a literal script tag instead of rendering it live", () => {
    const html = renderReportMarkdown("Your interest in <script>alert(1)</script> is noted.");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an injected attribute-breakout attempt", () => {
    const html = renderReportMarkdown('"><img src=x onerror=alert(1)>');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("renders headings, bold text, and lists", () => {
    const html = renderReportMarkdown("# Summary\n\nYou are **well suited** to Computer Science.\n\n- BSc CS\n- BSc IT");
    expect(html).toContain("<h1>Summary</h1>");
    expect(html).toContain("<strong>well suited</strong>");
    expect(html).toContain("<ul><li>BSc CS</li><li>BSc IT</li></ul>");
  });

  it("renders a safe http(s) link as an anchor", () => {
    const html = renderReportMarkdown("Apply at [the bursary page](https://example.org/apply).");
    expect(html).toContain('<a href="https://example.org/apply" rel="noopener noreferrer">the bursary page</a>');
  });

  it("does not turn a javascript: URL into a clickable link", () => {
    const html = renderReportMarkdown("Click [here](javascript:alert(1)) now.");
    expect(html).not.toContain("<a href");
    expect(html).toContain("here");
  });

  it("splits blank-line-separated text into separate paragraphs", () => {
    const html = renderReportMarkdown("First paragraph.\n\nSecond paragraph.");
    expect(html).toBe("<p>First paragraph.</p>\n<p>Second paragraph.</p>");
  });
});
