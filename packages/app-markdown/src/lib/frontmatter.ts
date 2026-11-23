
export interface FrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

const CLOSING_FENCE_RE = /^---[ \t]*$/;
const OPENING_FENCE_RE = /^---[ \t]*(?:\r\n|\n)/;

export function splitFrontmatter(text: string): FrontmatterSplit {
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
      if (frontmatter === '') return { frontmatter: null, body: text };
      const body = lineEnd < text.length ? text.slice(lineEnd + 1) : '';
      return { frontmatter, body };
    }
    if (lineEnd === text.length) break;
    pos = lineEnd + 1;
  }
  return { frontmatter: null, body: text };
}
