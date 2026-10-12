import { useApp, useInject } from '@moonshot-ai/agent-core';

import { FilesRef } from '#/features/files/index';
import { MediaLibraryRef } from '#/features/media/index';

import { useHttpRoute } from '../feature';
import { ErrorCode, param, sendErr } from '../route/http';
import { sendBinaryFile, type BinaryFile } from './files';

export function useSessionMediaRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.media.download',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/media/:file_id`,
    handler: async (request, response) => {
      const app = useApp();
      const library = useInject(MediaLibraryRef).value;
      const files = useInject(FilesRef).value;
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
      if (library === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.MEDIA_UNAVAILABLE,
          'session media is unavailable (media feature is not installed)',
        );
        return;
      }
      let file: BinaryFile | undefined = await library.open(fileId);
      if (file === undefined) {
        const staged = await files?.open(fileId);
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
