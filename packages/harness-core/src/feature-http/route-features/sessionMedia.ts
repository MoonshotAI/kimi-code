import { useApp } from '#/app/index';
import { useInject } from '#/kernel/index';

import { FilesRef, KimiFileRegistryRef } from '#/features/files/index';

import { sessionFacade, unitsReady, useHttpRoute, useRootUnit } from '../scope';
import { ErrorCode, param, sendErr } from '../route/http';
import { sendBinaryFile, type BinaryFile } from './files';

export function useSessionMediaRoutes(prefix: string): void {
  const app = useApp();
  const root = useRootUnit();
  const files = useInject(FilesRef);
  useHttpRoute({
    id: 'sessions.media.download',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/media/:file_id`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      const fileId = param(request, 'file_id');
      if (sessionId === undefined || fileId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const record = await app.space.get(sessionId);
      if (record === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, 'session not found');
        return;
      }
      await unitsReady(root);
      const registry = sessionFacade(root, KimiFileRegistryRef, sessionId);
      if (registry === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.MEDIA_UNAVAILABLE,
          'session media is unavailable (files feature is not installed)',
        );
        return;
      }
      const stored = await registry.open(`kimi-file://${fileId}`);
      let file: BinaryFile | undefined =
        stored === undefined
          ? undefined
          : {
              name: stored.meta.name,
              mediaType: stored.meta.media_type,
              size: stored.meta.size,
              stream: (range) => stored.stream(range),
            };
      if (file === undefined) {
        const staged = await files.value?.open(fileId);
        if (staged !== undefined) {
          file = {
            name: staged.meta.name,
            mediaType: staged.meta.media_type,
            size: staged.meta.size,
            stream: (range) => staged.stream(range),
          };
        }
      }
      if (file === undefined) {
        sendErr(request, response, ErrorCode.FILE_NOT_FOUND, 'file not found');
        return;
      }
      sendBinaryFile(request, response, file, `"${sessionId}-${fileId}-${file.size}"`);
    },
  });
}
