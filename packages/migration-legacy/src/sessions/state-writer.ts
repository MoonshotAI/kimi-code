import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { OldSessionState } from '../kimi-cli-schema.js';

export interface StateWriteInput {
  readonly oldState: Partial<OldSessionState>;
  readonly lastUserPrompt: string;
  readonly sourcePath: string;
  readonly oldSessionUuid: string;
  readonly wireProtocolFromOld: string | null;
  readonly createdAtMs: number;
}

export async function writeSessionState(sessionDir: string, input: StateWriteInput): Promise<void> {
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const customTitle = input.oldState.custom_title ?? null;
  const isCustomTitle =
    customTitle !== null && customTitle.length > 0 && !input.oldState.title_generated;
  const fallbackTitle = input.lastUserPrompt.slice(0, 50).trim();
  const candidateTitle = customTitle ?? fallbackTitle;
  const finalTitle = candidateTitle.length > 0 ? candidateTitle : 'Imported session';

  const wireMtimeS = input.oldState.wire_mtime ?? null;
  const updatedAt =
    wireMtimeS !== null && wireMtimeS !== undefined
      ? new Date(wireMtimeS * 1000).toISOString()
      : new Date(input.createdAtMs).toISOString();

  const meta = {
    createdAt: new Date(input.createdAtMs).toISOString(),
    updatedAt,
    title: finalTitle,
    isCustomTitle,
    lastPrompt: input.lastUserPrompt.slice(0, 200),
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
    },
    custom: {
      imported_from_kimi_cli: true,
      kimi_cli_source_path: input.sourcePath,
      kimi_cli_session_id: input.oldSessionUuid,
      kimi_cli_wire_protocol: input.wireProtocolFromOld,
      imported_at: new Date().toISOString(),
      archived: input.oldState.archived ?? false,
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
