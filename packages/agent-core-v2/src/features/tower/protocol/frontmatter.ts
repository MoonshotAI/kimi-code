const FENCE = '---';

export function renderFrontmatter(fields: Readonly<Record<string, string>>): string {
  const lines = [FENCE];
  for (const [key, value] of Object.entries(fields)) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`frontmatter value for "${key}" must be single-line`);
    }
    lines.push(`${key}: ${value}`);
  }
  lines.push(FENCE);
  return lines.join('\n');
}

export function parseFrontmatter(text: string): {
  readonly fields: Record<string, string>;
  readonly body: string;
} {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return { fields: {}, body: text };
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (close === -1) return { fields: {}, body: text };

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    fields[key] = line.slice(separator + 1).trim();
  }
  return { fields, body: lines.slice(close + 1).join('\n').trim() };
}
