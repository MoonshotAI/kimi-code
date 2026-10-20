import { createFeature, useApp, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createFacadeToken, useExpose } from '@moonshot-ai/agent-core/kernel/index';
import { SessionSpaceError } from '@moonshot-ai/agent-core/session/index';

import { SessionExportError } from './errors';
import { exportSessionJournal } from './service';
import type { ExportSessionInput, ExportSessionResult } from './sessionExport';

export interface SessionExportFace {
  export(input: ExportSessionInput): Promise<ExportSessionResult>;
}

export const SessionExportRef = createFacadeToken<SessionExportFace>('sessionExport');

export interface CreateSessionExportProps {
  readonly version: string;
  readonly globalLogPath?: string;
  readonly desktopLogPath?: string;
  readonly wireProtocolVersion?: string;
}

export function createSessionExport(props: CreateSessionExportProps): Feature {
  if (props.version.trim().length === 0) {
    throw new SessionExportError(
      'session.export_missing_version',
      'Session export requires a host version.',
    );
  }
  return createFeature('sessionExport', {
    app() {
      const app = useApp();
      useExpose(SessionExportRef, {
        export: async (input) => {
          input.signal?.throwIfAborted();
          const record = await app.space.get(input.sessionId);
          if (record === undefined) {
            throw new SessionSpaceError(
              'not-found',
              `Session "${input.sessionId}" does not exist`,
            );
          }
          const live = app.sessions.get(input.sessionId);
          if (live !== undefined) {
            for (const agent of live.agents.values()) {
              await agent.flush().catch(() => {});
            }
          }
          const container = await app.space.open(input.sessionId);
          try {
            return await exportSessionJournal({
              request: input,
              summary: { id: record.id, title: record.title },
              version: props.version,
              wireProtocolVersion: props.wireProtocolVersion,
              journal: container.journal,
              globalLogPath: input.includeGlobalLog === true ? props.globalLogPath : undefined,
              desktopLogPath: input.includeDesktopLog === true ? props.desktopLogPath : undefined,
            });
          } finally {
            await container.journal.close().catch(() => {});
          }
        },
      });
    },
  });
}
