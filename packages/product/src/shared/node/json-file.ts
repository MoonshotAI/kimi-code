import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { z } from 'zod';

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function tempPathFor(filePath: string): string {
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return join(dirname(filePath), `.${basename(filePath)}.${nonce}.tmp`);
}

export async function readJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return schema.parse(JSON.parse(raw) as unknown);
}

export async function writeJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  value: T,
): Promise<void> {
  const parsed = schema.parse(value);
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = tempPathFor(filePath);
  try {
    await writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export function writeJsonFileSync<T>(filePath: string, schema: z.ZodType<T>, value: T): void {
  const parsed = schema.parse(value);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = tempPathFor(filePath);
  try {
    writeFileSync(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw error;
  }
}
