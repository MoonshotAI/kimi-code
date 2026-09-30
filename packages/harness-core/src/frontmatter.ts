import { load as loadYaml } from 'js-yaml';

export class FrontmatterError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FrontmatterError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, configurable: true });
    }
  }
}

export interface ParsedFrontmatter {
  readonly data: unknown;
  readonly body: string;
}

export interface ParsedFrontmatterFields {
  readonly fields: Record<string, string>;
  readonly body: string;
}

const FENCE = '---';

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) {
    return { data: null, body: text };
  }

  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (close === -1) {
    throw new FrontmatterError('Missing closing frontmatter fence');
  }

  const yamlText = lines.slice(1, close).join('\n').trim();
  const body = lines.slice(close + 1).join('\n');
  if (yamlText === '') {
    return { data: {}, body };
  }

  try {
    return { data: loadYaml(yamlText) ?? {}, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FrontmatterError(message, error);
  }
}

export function parseFrontmatterFields(text: string): ParsedFrontmatterFields {
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
