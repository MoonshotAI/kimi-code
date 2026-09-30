import { useApp } from '@moonshot-ai/agent-core';

import {
  SessionTitleRef,
  type SessionTitleSource,
} from '#/features/kimi/sessionTitle/index';

import { useHttpRoute } from '../feature';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';

export function useSessionTitleRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.titleGenerate',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/title/generate`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required', 400);
        return;
      }
      const input = readTitleGenerateInput(request.body);
      if (input === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          'source must be one of user_prompts, first_turn, digest',
          400,
        );
        return;
      }
      const session = useApp().get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
        return;
      }
      const facade = session.resolve(SessionTitleRef);
      const title = facade === undefined ? undefined : await facade.generateTitle(input);
      if (title === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.SESSION_TITLE_UNAVAILABLE,
          'session title generation is unavailable (no managed OAuth login, no prompt yet, or the backend request failed)',
          409,
        );
        return;
      }
      sendOk(request, response, { title });
    },
  });
}

function readTitleGenerateInput(
  body: unknown,
): { force?: boolean; source?: SessionTitleSource } | undefined {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { [key: string]: unknown };
  const input: { force?: boolean; source?: SessionTitleSource } = {};
  if (record['force'] !== undefined) {
    if (typeof record['force'] !== 'boolean') return undefined;
    input.force = record['force'];
  }
  if (record['source'] !== undefined) {
    const source = record['source'];
    if (source !== 'user_prompts' && source !== 'first_turn' && source !== 'digest') {
      return undefined;
    }
    input.source = source;
  }
  return input;
}
