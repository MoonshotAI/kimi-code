// apps/kimi-web/src/lib/mermaidDirectives.ts
// Injects a `%%{init: {"htmlLabels": false}}%%` directive into every
// ```mermaid fence before the text reaches markstream.
//
// Why: markstream sanitizes mermaid's SVG via stream-markdown-parser's
// `replaceForeignObjectLabels`, which flattens each <foreignObject> label into
// a single-line SVG <text> (it only splits on literal <br>). Mermaid wraps
// long labels with CSS (max-width 200px soft wrap, no <br> in the DOM) and
// sizes the node rect to the WRAPPED label — so after flattening, the full
// single-line text renders centered on a rect sized for 200px and overflows
// both sides, overlapping adjacent nodes (worst with long CJK labels). With
// htmlLabels off, mermaid lays out native SVG text with real width-based line
// breaking (tspans), and the sanitizer has no foreignObject to flatten.
//
// The key MUST be the global `htmlLabels`, NOT `flowchart.htmlLabels`: in
// mermaid 11.15 the flowchart-scoped key is deprecated and silently shadowed
// by the global default — setting it changes nothing (verified empirically:
// the diagram still renders with foreignObject). The global key works both
// via mermaid.initialize() and via the init directive.
//
// Key invariant: the injected content must NOT start with `%%{`. markstream
// prepends its own `%%{init: {"theme": ...}}%%` only when the diagram code
// does not already start with a directive (`trimStart().startsWith("%%{")`),
// so the comment line comes first to keep its dark/light theme injection
// working. Mermaid merges multiple init directives, so both take effect.
//
// Fences are tracked CommonMark-style (same marker char, closing length >=
// opening length, backtick info strings cannot contain backticks) so a
// ```mermaid line that is the CONTENT of a longer enclosing fence (e.g. a
// ````markdown example) is left untouched — injecting there would rewrite
// user-visible sample text instead of a rendered diagram.

const INJECT_COMMENT = '%% kimi-web: htmlLabels=off (workaround for markstream flattening foreignObject soft-wraps)';
const INJECT_DIRECTIVE = '%%{init: {"htmlLabels": false}}%%';

const FENCE_LINE_RE = /^( {0,3})(`{3,}|~{3,})([^`]*)$/;

/**
 * Return `text` with the htmlLabels-off directive injected right after the
 * opening line of every real ```mermaid fence (``` or ~~~, up to 3 leading
 * spaces). Pure and idempotent over raw model text: callers always pass the
 * original markdown, so repeated renders never accumulate injections. Text
 * without mermaid fences is returned byte-for-byte unchanged.
 */
export function injectMermaidHtmlLabelsOff(text: string): string {
  if (!text.includes('mermaid')) return text;

  const lines = text.split(/(?<=\n)/);
  let openChar: '`' | '~' | null = null;
  let openLen = 0;
  const out: string[] = [];

  for (const line of lines) {
    out.push(line);
    const body = line.endsWith('\r\n') ? line.slice(0, -2) : line.endsWith('\n') ? line.slice(0, -1) : line;
    const m = FENCE_LINE_RE.exec(body);
    if (!m) continue;
    const [, indent = '', marks = '', info = ''] = m;
    const char = marks[0] as '`' | '~';

    if (openChar === null) {
      openChar = char;
      openLen = marks.length;
      if (info.trim() === 'mermaid') {
        const nl = line.endsWith('\r\n') ? '\r\n' : '\n';
        out.push(`${indent}${INJECT_COMMENT}${nl}${indent}${INJECT_DIRECTIVE}${nl}`);
      }
    } else if (char === openChar && marks.length >= openLen && info.trim() === '') {
      openChar = null;
      openLen = 0;
    }
  }

  return out.join('');
}
