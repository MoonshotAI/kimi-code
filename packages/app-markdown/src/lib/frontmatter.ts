// YAML frontmatter splitting, done before any markdown parsing.
//
// markstream/markdown-it has no frontmatter support: left intact, the opening
// `---` renders as an <hr> and the closing `---` becomes a setext underline
// that swallows the whole metadata block into a giant <h2>. We split the
// block off instead and render it as a plain meta block (see Markdown.vue).

export interface FrontmatterSplit {
  /** Raw YAML between the fences (fences excluded), or null when absent. */
  frontmatter: string | null;
  /** The document with the frontmatter block removed. */
  body: string;
}

// A closing line contains only `---` plus optional trailing whitespace.
const CLOSING_FENCE_RE = /^---[ \t]*$/;
// The opening fence is the same shape plus a line break — anything else
// (`------`, `---x`, a bare `---` at EOF) is not a fence.
const OPENING_FENCE_RE = /^---[ \t]*(?:\r\n|\n)/;

/** Split a leading YAML frontmatter block off `text`. */
export function splitFrontmatter(text: string): FrontmatterSplit {
  // The opening fence must start at byte 0 — a BOM or any leading whitespace
  // means it is just a horizontal rule / setext underline, not frontmatter.
  const opening = OPENING_FENCE_RE.exec(text);
  if (opening === null) return { frontmatter: null, body: text };
  let pos = opening[0].length;

  const contentStart = pos;
  while (pos <= text.length) {
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = text.length;
    let line = text.slice(pos, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (CLOSING_FENCE_RE.test(line)) {
      const frontmatter = text.slice(contentStart, pos);
      // An empty block (`---\n---`) is not metadata; leave the text alone.
      if (frontmatter === '') return { frontmatter: null, body: text };
      // The body starts after the closing line's newline (if any).
      const body = lineEnd < text.length ? text.slice(lineEnd + 1) : '';
      return { frontmatter, body };
    }
    if (lineEnd === text.length) break;
    pos = lineEnd + 1;
  }
  // No closing fence → not frontmatter.
  return { frontmatter: null, body: text };
}
