import type { ILogService } from '#/_base/log/log';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type {
  AppendLogTruncation,
  IAppendLogStore,
} from '#/persistence/interface/appendLogStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

export interface WireJournalRepairServices {
  readonly appendLog: IAppendLogStore;
  readonly storage: IFileSystemStorageService;
  readonly log: ILogService;
  readonly telemetry: ITelemetryService;
}

export function wireJournalBackupKey(key: string): string {
  return `${key}.bak`;
}

export async function repairWireJournal(
  services: WireJournalRepairServices,
  scope: string,
  key: string,
  records: readonly unknown[],
  truncation: AppendLogTruncation,
): Promise<void> {
  const { appendLog, storage, log, telemetry } = services;
  let backupCreated = false;
  let outcome: 'repaired' | 'failed' = 'repaired';
  let droppedCount = 0;
  let repairError: unknown;
  try {
    const original = await storage.read(scope, key);
    if (original !== undefined) {
      droppedCount = Math.max(0, countJournalLines(original) - records.length);
      const backupKey = wireJournalBackupKey(key);
      if ((await storage.size(scope, backupKey)) === undefined) {
        await storage.write(scope, backupKey, original, { atomic: true });
        backupCreated = true;
      }
    }
    await appendLog.rewrite(scope, key, records);
  } catch (error) {
    outcome = 'failed';
    repairError = error;
  }
  log.warn('corrupted wire journal truncated to its valid prefix', {
    scope,
    key,
    lineNumber: truncation.lineNumber,
    reason: truncation.reason,
    outcome,
    droppedCount,
    backupCreated,
    error: repairError instanceof Error ? repairError.message : undefined,
  });
  telemetry.track2('wire_repair', {
    kind: truncation.reason,
    outcome,
    dropped_count: droppedCount,
    backup_created: backupCreated,
  });
}

function countJournalLines(data: Uint8Array): number {
  let lines = 0;
  let hasContent = false;
  for (const byte of data) {
    if (byte === 0x0a) {
      lines++;
      hasContent = false;
    } else {
      hasContent = true;
    }
  }
  return hasContent ? lines + 1 : lines;
}
