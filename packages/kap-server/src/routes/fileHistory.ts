import {
  IAgentFileHistoryService,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  fileHistoryChangesQuerySchema,
  fileHistoryChangesResponseSchema,
  fileHistoryContentQuerySchema,
  fileHistoryContentResponseSchema,
} from '../protocol/rest-file-history';
import { ensureMainAgent } from '../transport/mainAgent';

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

interface FileHistoryRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerFileHistoryRoutes(app: FileHistoryRouteHost, core: Scope): void {
  const changesRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/file-history/changes',
      params: sessionIdParamSchema,
      querystring: fileHistoryChangesQuerySchema,
      success: { data: fileHistoryChangesResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "List one turn's file changes from the turn-level file history",
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const agent = await ensureMainAgent(session);
      const history = agent.accessor.get(IAgentFileHistoryService);
      reply.send(
        okEnvelope(
          {
            changes: await history.changes(req.query.turn_id),
            enabled: history.enabled(),
            recorded: await history.turnRecorded(req.query.turn_id),
          },
          req.id,
        ),
      );
    },
  );
  app.get(
    changesRoute.path,
    changesRoute.options,
    changesRoute.handler as Parameters<FileHistoryRouteHost['get']>[2],
  );

  const contentRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/file-history/content',
      params: sessionIdParamSchema,
      querystring: fileHistoryContentQuerySchema,
      success: { data: fileHistoryContentResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "A file's content as captured at a turn's file-history checkpoint",
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const agent = await ensureMainAgent(session);
      const history = agent.accessor.get(IAgentFileHistoryService);
      const content = await history.contentAt(req.query.turn_id, req.query.path, req.query.phase);
      reply.send(okEnvelope({ content: content ?? null }, req.id));
    },
  );
  app.get(
    contentRoute.path,
    contentRoute.options,
    contentRoute.handler as Parameters<FileHistoryRouteHost['get']>[2],
  );
}
