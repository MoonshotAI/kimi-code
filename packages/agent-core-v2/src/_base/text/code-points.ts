export function sliceOnCodePointBoundary(text: string, end: number): string {
  if (end >= text.length) return text;
  let boundary = end;
  // oxlint-disable-next-line unicorn/prefer-code-point -- raw UTF-16 halves are the point here
  if (boundary > 0 && isHighSurrogate(text.charCodeAt(boundary - 1))) boundary -= 1;
  return text.slice(0, boundary);
}

export function codePointBoundaryStart(text: string, start: number): number {
  if (
    start > 0 &&
    start < text.length &&
    // oxlint-disable-next-line unicorn/prefer-code-point -- raw UTF-16 halves are the point here
    isLowSurrogate(text.charCodeAt(start)) &&
    // oxlint-disable-next-line unicorn/prefer-code-point -- raw UTF-16 halves are the point here
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    return start + 1;
  }
  return start;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
