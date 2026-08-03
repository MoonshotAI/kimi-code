import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';
import type { EngineSessionRecord } from '#/cli/native-session-adapter';

import type { SessionRow } from '#/tui/components/dialogs/session-picker';

export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
): SessionRow[] {
  return sessions
    .filter((session) => currentSessionHasContent || session.id !== currentSessionId)
    .map((session) => ({
      id: session.id,
      title: session.title ?? null,
      last_prompt: session.lastPrompt ?? null,
      work_dir: session.workDir,
      updated_at: session.updatedAt ?? session.createdAt ?? 0,
      metadata: session.metadata,
    }));
}

/**
 * Adapt engine persisted-session records (SDK `SessionSummary` parity, but
 * ISO-8601 string timestamps on the wire) into picker rows. Same shape and
 * current-session filtering as `sessionRowsForPicker`, so the merged harness +
 * native lists render identically.
 */
export function nativeSessionRowsForPicker(
  records: readonly EngineSessionRecord[],
  workDir: string,
  currentSessionId: string,
  currentSessionHasContent: boolean,
): SessionRow[] {
  return records
    .filter((record) => currentSessionHasContent || record.id !== currentSessionId)
    .map((record) => ({
      id: record.id,
      title: record.title || null,
      work_dir: record.work_dir || workDir,
      updated_at: engineTimestampToMs(record.updated_at),
    }));
}

/** Engine wire timestamps are ISO-8601 strings; `SessionRow.updated_at`
 *  expects epoch milliseconds like the SDK's filesystem-stat timestamps. */
function engineTimestampToMs(value: string | undefined): number {
  const ms = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}
