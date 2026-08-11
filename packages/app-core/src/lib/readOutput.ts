// packages/app-core/src/lib/readOutput.ts
// Parses the Read tool's output for display.

export interface ReadOutput {
  /** File content lines with the line-number prefixes stripped. */
  contents: string[];
  /** Real file line number per content line, taken from the prefixes. */
  lineNumbers: number[];
}

const LINE_RE = /^(\d+)\t(.*)$/;

/**
 * The Read tool renders each output line as `<line-number>\t<content>`. Split
 * the prefix off so the content can be syntax-highlighted (a number inside
 * the text would derail the tokenizer) and the numbers shown as a gutter.
 * Returns null when ANY line misses the pattern (error messages, non-text
 * files, format drift) — callers fall back to the raw output.
 */
export function parseReadOutput(lines: string[]): ReadOutput | null {
  // normalizeToolOutput splits the result string on '\n', so a trailing
  // newline in that string leaves one phantom empty line that is not a read
  // line — drop exactly one. A real numbered blank line (`2\t`) is unaffected.
  const rows = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  if (rows.length === 0) return null;
  const contents: string[] = [];
  const lineNumbers: number[] = [];
  for (const line of rows) {
    const m = LINE_RE.exec(line);
    if (!m) return null;
    lineNumbers.push(Number(m[1]));
    contents.push(m[2] ?? '');
  }
  return { contents, lineNumbers };
}
