import { open } from 'node:fs/promises';

const FENCE = '---';
const FRONTMATTER_CHUNK_BYTES = 16 * 1024;

export function renderFrontmatter(fields: Readonly<Record<string, string | undefined>>): string {
  const lines = [FENCE];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
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

export async function readFrontmatterPrefix(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const decoder = new TextDecoder();
    const buffer = Buffer.allocUnsafe(FRONTMATTER_CHUNK_BYTES);
    let text = '';
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return text + decoder.decode();
      text += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      if (frontmatterTerminated(text)) return text;
    }
  } finally {
    await handle.close();
  }
}

function frontmatterTerminated(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return lines.length > 1;
  return lines.some((line, index) => index > 0 && line.trim() === FENCE);
}
