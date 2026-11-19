import { codeFences } from './codeFences';

export interface MarkdownRenderPlan {
  renderCodeBlocksAsPre: boolean;
  codeFenceCount: number;
  codeChars: number;
}

const HEAVY_TEXT_CHARS = 120_000;
const HEAVY_CODE_CHARS = 60_000;
const HEAVY_CODE_FENCES = 32;
const HEAVY_SINGLE_FENCE_CHARS = 30_000;

export function markdownRenderPlan(text: string): MarkdownRenderPlan {
  let codeFenceCount = 0;
  let codeChars = 0;
  let longestFence = 0;
  for (const fence of codeFences(text)) {
    const length = fence.contentEnd - fence.contentStart;
    codeFenceCount += 1;
    codeChars += length;
    longestFence = Math.max(longestFence, length);
  }

  const heavy =
    text.length >= HEAVY_TEXT_CHARS ||
    codeChars >= HEAVY_CODE_CHARS ||
    codeFenceCount >= HEAVY_CODE_FENCES ||
    longestFence >= HEAVY_SINGLE_FENCE_CHARS;

  return {
    renderCodeBlocksAsPre: heavy,
    codeFenceCount,
    codeChars,
  };
}
