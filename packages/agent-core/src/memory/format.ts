import { basename } from 'pathe';

import { z } from 'zod';

import { FrontmatterError, parseFrontmatter } from '../skill/parser';
import { isValidSlug } from './slug';
import type { MemoryEntry, MemoryRecord, MemoryScope } from './types';

export const MEMORY_BODY_MAX_BYTES = 4 * 1024;

const RecordSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(['user', 'feedback', 'project', 'reference']),
});

export function parseMemoryFile(
  scope: MemoryScope,
  path: string,
  text: string,
): MemoryEntry | undefined {
  const slug = basename(path).replace(/\.md$/, '');
  if (!isValidSlug(slug)) return undefined;

  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (error) {
    if (error instanceof FrontmatterError) return undefined;
    throw error;
  }

  if (!isRecord(parsed.data)) return undefined;
  const validated = RecordSchema.safeParse(parsed.data);
  if (!validated.success) return undefined;

  if (validated.data.name !== slug) return undefined;

  const body = parsed.body.trim();
  if (Buffer.byteLength(body, 'utf8') > MEMORY_BODY_MAX_BYTES) return undefined;

  const record: MemoryRecord = validated.data;
  return { record, body, scope, path };
}

export function renderMemoryFile(record: MemoryRecord, body: string): string {
  return `---\nname: ${record.name}\ndescription: ${record.description}\ntype: ${record.type}\n---\n\n${body.trim()}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
