import {
  createFeature,
  SessionSpaceError,
  useApp,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import { createToken, useExpose } from '@moonshot-ai/agent-core/kernel/index';

import { SessionExportError } from './errors';
import { exportSessionDirectory } from './service';
import type { ExportSessionInput, ExportSessionResult } from './sessionExport';

export interface SessionExportFace {
  export(input: ExportSessionInput): Promise<ExportSessionResult>;
}

export const SessionExportRef = createToken<SessionExportFace>('sessionExport');

export interface CreateSessionExportProps {
  readonly version: string;
  readonly sessionDir: (sessionId: string) => string | undefined;
  readonly globalLogPath?: string;
  readonly desktopLogPath?: string;
  readonly wireProtocolVersion?: string;
}

export function createSessionExport(props: CreateSessionExportProps): FeatureSpec {
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
          const sessionDir = props.sessionDir(input.sessionId);
          if (sessionDir === undefined) {
            throw new SessionExportError(
              'session.export_not_found',
              `Session "${input.sessionId}" has no exportable directory.`,
              { details: { sessionId: input.sessionId } },
            );
          }
          return exportSessionDirectory({
            request: input,
            summary: { id: record.id, title: record.title },
            version: props.version,
            wireProtocolVersion: props.wireProtocolVersion,
            sessionDir,
            globalLogPath: input.includeGlobalLog === true ? props.globalLogPath : undefined,
            desktopLogPath: input.includeDesktopLog === true ? props.desktopLogPath : undefined,
          });
        },
      });
    },
  });
}
