function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function renderInline(line: string): string {
  return line
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[(.+?)\]\((.+?)\)/g, (match, text: string, url: string) =>
      isSafeUrl(url) ? `<a href="${url}" rel="noopener noreferrer">${text}</a>` : text,
    );
}

// Renders a small, deliberately limited subset of markdown -- headings,
// bold text, links, and lists -- as HTML. The model echoes the learner's
// own free-text "interests" field back into the report, so every character
// of the input is HTML-escaped *before* any markdown syntax is
// interpreted: a literal "<script>" typed as an interest (or produced by
// the model quoting it) becomes inert text, never a live tag, regardless of
// what shape the rest of the content takes.
export function renderReportMarkdown(markdown: string): string {
  const escaped = escapeHtml(markdown);
  const lines = escaped.split("\n");

  const htmlBlocks: string[] = [];
  let listItems: string[] = [];
  let paragraphLines: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    htmlBlocks.push(`<ul>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    listItems = [];
  };

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    htmlBlocks.push(`<p>${paragraphLines.map(renderInline).join(" ")}</p>`);
    paragraphLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.length === 0) {
      flushList();
      flushParagraph();
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushList();
      flushParagraph();
      const level = headingMatch[1].length;
      htmlBlocks.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    const listMatch = /^[-*]\s+(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }
  flushList();
  flushParagraph();

  return htmlBlocks.join("\n");
}
