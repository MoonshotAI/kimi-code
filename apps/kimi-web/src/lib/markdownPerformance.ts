export type MarkdownCodeRenderer = 'pre' | 'shiki';

export interface MarkdownRenderPlan {
  codeRenderer: MarkdownCodeRenderer;
  codeFenceCount: number;
  codeChars: number;
}

const HEAVY_TEXT_CHARS = 120_000;
const HEAVY_CODE_CHARS = 60_000;
const HEAVY_CODE_FENCES = 32;
const HEAVY_SINGLE_FENCE_CHARS = 30_000;
/** stream-diffs / Monaco layout can fail on a single ultra-long line (common
 *  in plain-text fences). Prefer the plain <pre> path so chat keeps a stable
 *  scrollable code block instead of falling through a broken highlighter. */
const HEAVY_SINGLE_LINE_CHARS = 512;

const CODE_FENCE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n)?\2(?=\n|$)/g;

function longestLineLength(code: string): number {
  let longest = 0;
  let start = 0;
  for (let i = 0; i <= code.length; i += 1) {
    if (i === code.length || code.charCodeAt(i) === 10 /* \n */) {
      longest = Math.max(longest, i - start);
      start = i + 1;
    }
  }
  return longest;
}

export function markdownRenderPlan(text: string): MarkdownRenderPlan {
  let codeFenceCount = 0;
  let codeChars = 0;
  let longestFence = 0;
  let longestLine = 0;
  CODE_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    const code = match[3] ?? '';
    codeFenceCount += 1;
    codeChars += code.length;
    longestFence = Math.max(longestFence, code.length);
    longestLine = Math.max(longestLine, longestLineLength(code));
  }

  const heavy =
    text.length >= HEAVY_TEXT_CHARS ||
    codeChars >= HEAVY_CODE_CHARS ||
    codeFenceCount >= HEAVY_CODE_FENCES ||
    longestFence >= HEAVY_SINGLE_FENCE_CHARS ||
    longestLine >= HEAVY_SINGLE_LINE_CHARS;

  return {
    codeRenderer: heavy ? 'pre' : 'shiki',
    codeFenceCount,
    codeChars,
  };
}
