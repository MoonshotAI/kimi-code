import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { useInject } from '@moonshot-ai/agent-core/kernel/index';

import {
  SessionExportError,
  SessionExportRef,
} from '#/features/sessionExport/index';

import { useHttpRoute } from '../scope';
import { ErrorCode, param, sendErr, sendFacadeErr } from '../route/http';

export function useSessionExportRoutes(prefix: string): void {
  const facade = useInject(SessionExportRef);
  useHttpRoute({
    id: 'sessions.export',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/export`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const body = readSessionExportInput(request.body);
      if (body === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          'desktop must be a boolean and web_log must be a string',
        );
        return;
      }
      const current = facade.value;
      if (current === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.SESSION_EXPORT_UNAVAILABLE,
          'session export is unavailable (sessionExport feature is not installed)',
        );
        return;
      }
      const tempDir = await mkdtemp(join(tmpdir(), 'kimi-session-export-'));
      try {
        const result = await current.export({
          sessionId,
          outputPath: join(tempDir, 'session.zip'),
          includeGlobalLog: true,
          includeDesktopLog: body.desktop,
          webLog: body.webLog,
        });
        const archive = await stat(result.zipPath);
        response.status(200);
        response.setHeader('content-type', 'application/zip');
        response.setHeader(
          'content-disposition',
          `attachment; filename="kimi-session-${sanitizeSessionId(sessionId)}.zip"`,
        );
        response.setHeader('content-length', archive.size);
        response.setHeader('cache-control', 'no-store');
        const stream = createReadStream(result.zipPath);
        stream.once('close', () => {
          void rm(tempDir, { recursive: true, force: true }).catch(() => {});
        });
        stream.pipe(response);
      } catch (error) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        if (sendFacadeErr(request, response, error)) return;
        if (error instanceof SessionExportError) {
          sendErr(request, response, ErrorCode.INTERNAL_ERROR, error.message);
          return;
        }
        throw error;
      }
    },
  });
}

function readSessionExportInput(body: unknown): { desktop?: boolean; webLog?: string } | undefined {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { [key: string]: unknown };
  const input: { desktop?: boolean; webLog?: string } = {};
  if (record['desktop'] !== undefined) {
    if (typeof record['desktop'] !== 'boolean') return undefined;
    input.desktop = record['desktop'];
  }
  if (record['web_log'] !== undefined) {
    if (typeof record['web_log'] !== 'string') return undefined;
    input.webLog = record['web_log'];
  }
  return input;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'session';
}
