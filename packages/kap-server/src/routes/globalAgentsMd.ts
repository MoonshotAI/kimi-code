import { join } from 'node:path';

import {
  ErrorCodes,
  IBootstrapOptions,
  IHostFileSystem,
  isError2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  globalAgentsMdResponseSchema,
  writeGlobalAgentsMdRequestSchema,
  type GlobalAgentsMdResponse,
} from '../protocol/rest-global-agents-md';

interface GlobalAgentsMdRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

async function readGlobalAgentsMd(core: Scope): Promise<GlobalAgentsMdResponse> {
  const path = join(core.accessor.get(IBootstrapOptions).homeDir, 'AGENTS.md');
  try {
    const content = await core.accessor.get(IHostFileSystem).readText(path);
    return { path, content, exists: true };
  } catch (error) {
    if (isError2(error) && error.code === ErrorCodes.OS_FS_NOT_FOUND) {
      return { path, content: '', exists: false };
    }
    throw error;
  }
}

function sendError(reply: { send(payload: unknown): unknown }, req: { id: string }, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  requestLog(req)?.error({ err: error }, 'global AGENTS.md request failed');
  if (isError2(error) && error.code === ErrorCodes.OS_FS_PERMISSION_DENIED) {
    reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, message, req.id));
    return;
  }
  if (isError2(error) && error.code === ErrorCodes.OS_FS_IS_DIRECTORY) {
    reply.send(errEnvelope(ErrorCode.FS_IS_DIRECTORY, message, req.id));
    return;
  }
  reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, message, req.id));
}

export function registerGlobalAgentsMdRoutes(app: GlobalAgentsMdRouteHost, core: Scope): void {
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/global-agents-md',
      success: { data: globalAgentsMdResponseSchema },
      errors: {
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_IS_DIRECTORY]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Read the global AGENTS.md from the server Kimi home directory',
      tags: ['config'],
      operationId: 'getGlobalAgentsMd',
    },
    async (req, reply) => {
      try {
        reply.send(okEnvelope(await readGlobalAgentsMd(core), req.id));
      } catch (error) {
        sendError(reply, req, error);
      }
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<GlobalAgentsMdRouteHost['get']>[2]);

  const writeRoute = defineRoute(
    {
      method: 'PUT',
      path: '/global-agents-md',
      body: writeGlobalAgentsMdRequestSchema,
      success: { data: globalAgentsMdResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_IS_DIRECTORY]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Write the global AGENTS.md in the server Kimi home directory',
      tags: ['config'],
      operationId: 'writeGlobalAgentsMd',
    },
    async (req, reply) => {
      try {
        const path = join(core.accessor.get(IBootstrapOptions).homeDir, 'AGENTS.md');
        const fs = core.accessor.get(IHostFileSystem);
        await fs.mkdir(core.accessor.get(IBootstrapOptions).homeDir, { recursive: true });
        await fs.writeText(path, req.body.content);
        reply.send(okEnvelope({ path, content: req.body.content, exists: true }, req.id));
      } catch (error) {
        sendError(reply, req, error);
      }
    },
  );
  app.put(writeRoute.path, writeRoute.options, writeRoute.handler as Parameters<GlobalAgentsMdRouteHost['put']>[2]);
}
