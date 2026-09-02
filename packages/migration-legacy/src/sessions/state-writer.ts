import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  SESSION_META_VERSION,
  type SessionTitleKind,
} from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';

import type { OldSessionState } from '../kimi-cli-schema.js';
import { IMPORT_FORMAT_VERSION } from './turn-structure.js';

export interface StateWriteInput {
  readonly oldState: Partial<OldSessionState>;
  readonly sessionId: string;
  readonly workdirPath: string;
  readonly lastUserPrompt: string;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly sourcePath: string;
  readonly oldSessionUuid: string;
  readonly wireProtocolFromOld: string | null;
  readonly createdAtMs: number;
  readonly subagentIds?: readonly string[];
}

export async function writeSessionState(sessionDir: string, input: StateWriteInput): Promise<void> {
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const customTitle = input.oldState.custom_title ?? null;
  const titleGenerated = input.oldState.title_generated === true;
  const isCustomTitle = customTitle !== null && customTitle.length > 0 && !titleGenerated;
  const fallbackTitle = input.lastUserPrompt.slice(0, 50).trim();
  const candidateTitle = customTitle ?? fallbackTitle;
  const finalTitle = candidateTitle.length > 0 ? candidateTitle : 'Imported session';
  const titleKind: SessionTitleKind = isCustomTitle
    ? 'custom'
    : titleGenerated
      ? 'generated'
      : 'replaceable';

  const wireMtimeMs =
    input.oldState.wire_mtime !== null && input.oldState.wire_mtime !== undefined
      ? input.oldState.wire_mtime * 1000
      : undefined;
  const archivedAtMs =
    input.oldState.archived_at !== null && input.oldState.archived_at !== undefined
      ? input.oldState.archived_at * 1000
      : undefined;

  const meta = {
    id: input.sessionId,
    version: SESSION_META_VERSION,
    cwd: input.workdirPath,
    createdAt: input.createdAtMs,
    updatedAt: wireMtimeMs ?? input.createdAtMs,
    archived: input.oldState.archived ?? false,
    archivedAt: archivedAtMs,
    title: finalTitle,
    titleKind,
    isCustomTitle,
    lastPrompt: input.lastUserPrompt.slice(0, 200),
    lastTurnReason: input.lastTurnReason,
    additionalDirs:
      input.oldState.additional_dirs?.length === 0
        ? undefined
        : input.oldState.additional_dirs,
    agents: {
      main: {
        // kimi-core's `Session.resume()` treats `agents.main.homedir` as the
        // agent's *record directory* — where it reads `wire.jsonl`. The
        // migrator writes the translated history to
        // `<sessionDir>/agents/main/wire.jsonl`, so this must point there,
        // NOT at the user's project workdir.
        homedir: join(sessionDir, 'agents', 'main'),
        type: 'main',
        parentAgentId: null,
      },
      ...Object.fromEntries(
        (input.subagentIds ?? []).map((agentId) => [
          agentId,
          {
            homedir: join(sessionDir, 'agents', agentId),
            type: 'sub',
            parentAgentId: 'main',
            labels: { parentAgentId: 'main' },
          },
        ]),
      ),
    },
    custom: {
      imported_from_kimi_cli: true,
      import_format_version: IMPORT_FORMAT_VERSION,
      kimi_cli_source_path: input.sourcePath,
      kimi_cli_session_id: input.oldSessionUuid,
      kimi_cli_wire_protocol: input.wireProtocolFromOld,
      imported_at: new Date().toISOString(),
      auto_archive_exempt: input.oldState.auto_archive_exempt ?? false,
      vscode_legacy_approval:
        input.oldState.approval === undefined
          ? undefined
          : {
              yolo: input.oldState.approval.yolo ?? false,
              afk: input.oldState.approval.afk ?? false,
            },
    },
  };

  await writeFile(join(sessionDir, 'state.json'), JSON.stringify(meta, null, 2), 'utf-8');
}
