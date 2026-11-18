import { readdir, readFile } from 'node:fs/promises';

import { analyzeContextContent } from './translator.js';
import { readMergedSessionState, type LegacySessionRef } from './source.js';

export type SessionClass = 'placeholder' | 'empty' | 'malformed' | 'real';

export async function classifyLegacySession(ref: LegacySessionRef): Promise<SessionClass> {
  if (ref.sessionDir !== undefined) {
    let entries: string[];
    try {
      entries = await readdir(ref.sessionDir);
    } catch {
      return 'malformed';
    }
    if (entries.length === 0 && ref.flatContextFile === undefined) return 'empty';
    if (entries.length === 1 && entries[0] === 'test') return 'placeholder';
  } else if (ref.contextPath === undefined) {
    return 'malformed';
  }

  if (ref.contextPath === undefined) return 'malformed';

  let contextText: string;
  try {
    contextText = await readFile(ref.contextPath, 'utf-8');
  } catch {
    return 'malformed';
  }
  const content = analyzeContextContent(contextText.split(/\r?\n/));
  if (content === 'real' || content === 'corrupt') return 'real';

  const state = await readMergedSessionState(ref.sessionDir);
  if (typeof state.custom_title === 'string' && state.custom_title.length > 0) {
    return 'real';
  }
  return 'empty';
}
