
export interface ReadOutput {
  contents: string[];
  lineNumbers: number[];
}

const LINE_RE = /^(\d+)\t(.*)$/;

export function parseReadOutput(lines: string[]): ReadOutput | null {
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
