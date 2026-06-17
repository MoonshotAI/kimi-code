import { FrontmatterError, parseFrontmatter } from '../skill/parser';
import type { ParsedOutputStyle } from './types';

export class OutputStyleParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OutputStyleParseError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause, configurable: true });
  }
}

export function parseOutputStyle(text: string, fallbackName: string): ParsedOutputStyle {
  let parsed;
  try { parsed = parseFrontmatter(text); }
  catch (error) {
    if (error instanceof FrontmatterError) throw new OutputStyleParseError(`Invalid frontmatter: ${error.message}`, error);
    throw error;
  }
  const fm = isRecord(parsed.data) ? parsed.data : {};
  const body = parsed.body.trim();
  if (body === '') throw new OutputStyleParseError('Output style body is empty');
  const name = nonEmptyString(fm['name']) ?? fallbackName;
  const description = nonEmptyString(fm['description']) ?? firstLine(body) ?? 'No description provided.';
  return { name, description, body };
}

function firstLine(body: string): string | undefined {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (line === undefined) return undefined;
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}
function nonEmptyString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
