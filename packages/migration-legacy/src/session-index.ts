import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { SessionIndexLine } from '@moonshot-ai/agent-core-v2/app/workspace/workspaceAlias';

import { targetSessionIndex } from './paths.js';

export async function appendSessionIndexEntry(
  targetHome: string,
  entry: SessionIndexLine,
): Promise<void> {
  const path = targetSessionIndex(targetHome);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf-8');
}

export async function ensureSessionIndexEntry(
  targetHome: string,
  entry: SessionIndexLine,
): Promise<void> {
  const path = targetSessionIndex(targetHome);
  if (await hasSessionIndexEntry(path, entry.sessionId)) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf-8');
}

async function hasSessionIndexEntry(path: string, sessionId: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { sessionId?: unknown }).sessionId === sessionId
      ) {
        return true;
      }
    } catch {}
  }
  return false;
}
