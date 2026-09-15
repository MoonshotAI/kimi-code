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

  // `migrateOneSession` hard-fails without a context payload, so a session
  // lacking one is not migratable. Classify as `malformed` so it is surfaced
  // as a failure rather than entering the migration pipeline.
  if (ref.contextPath === undefined) return 'malformed';

  // Inspect the context payload to distinguish three cases:
  //  - real:    has user/assistant/tool rows → migratable.
  //  - empty:   parses but only carries markers (`_system_prompt` etc.) or is
  //             blank → an unused session, or one the user cleared/reverted
  //             in kimi-cli — UNLESS a custom title survives in state, which
  //             kimi-cli's Session.is_empty() honors as a listed session.
  //  - corrupt: every non-blank line failed to parse → a real data problem
  //             (truncated write, disk error). Route through `'real'` so the
  //             migration step can run, fail with a diagnostic reason, and
  //             surface it via `sessionsFailed` + `migration-errors.log` —
  //             classify-level `'malformed'` would silently absorb it into
  //             `sessionsSkippedMalformed`, which the result screen does not
  //             render and the error log does not include.
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
