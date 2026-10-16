import { join } from 'node:path';

import {
  getLiveSessionById,
  IBootstrapService,
  IHostFileSystem,
  listSessionRuntimeEntries,
  type Scope,
  type SessionMeta,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface ExternalSessionsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const externalSessionItemSchema = z.object({
  session_id: z.string(),
  workspace_id: z.string(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  source: z.string().nullable(),
  last_prompt: z.string().nullable(),
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  active: z.boolean(),
  live_here: z.boolean(),
  process: z.enum(['server', 'cli', 'cli-print']),
  pid: z.number().int(),
  started_at: z.string().nullable(),
  stopped_at: z.string().nullable(),
});

const externalSessionsResponseSchema = z.object({
  items: z.array(externalSessionItemSchema),
});

export function registerExternalSessionsRoutes(app: ExternalSessionsRouteHost, core: Scope): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/external-sessions',
      success: { data: externalSessionsResponseSchema },
      errors: {},
      description:
        'Sessions running in (or recently ended in) other local processes (CLI print runs, TUI) that share this home directory, discovered from session runtime heartbeat files. Server-hosted sessions are excluded. active = heartbeat fresh within 20s; stopped entries are retained for 48h.',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const bootstrap = core.accessor.get(IBootstrapService);
      const hostFs = core.accessor.get(IHostFileSystem);
      const entries = listSessionRuntimeEntries(bootstrap.sessionsDir);
      const items = [];
      for (const { record, active } of entries) {
        const meta = await readSessionStateMeta(
          hostFs,
          join(bootstrap.sessionsDir, record.workspaceId, record.sessionId, 'state.json'),
        );
        const source = meta?.custom?.['source'];
        items.push({
          session_id: record.sessionId,
          workspace_id: record.workspaceId,
          title: meta?.title ?? null,
          cwd: meta?.cwd ?? null,
          source: typeof source === 'string' && source.length > 0 ? source : null,
          last_prompt: meta?.lastPrompt ?? null,
          last_turn_reason: meta?.lastTurnReason ?? null,
          created_at:
            meta?.createdAt === undefined ? null : new Date(meta.createdAt).toISOString(),
          updated_at:
            meta?.updatedAt === undefined ? null : new Date(meta.updatedAt).toISOString(),
          active,
          live_here: getLiveSessionById(core.accessor, record.sessionId) !== undefined,
          process: record.process,
          pid: record.pid,
          started_at: new Date(record.startedAt).toISOString(),
          stopped_at:
            record.stoppedAt === undefined ? null : new Date(record.stoppedAt).toISOString(),
        });
      }
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<ExternalSessionsRouteHost['get']>[2]);
}

async function readSessionStateMeta(
  hostFs: IHostFileSystem,
  statePath: string,
): Promise<SessionMeta | undefined> {
  let text: string;
  try {
    text = await hostFs.readText(statePath);
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as SessionMeta;
    return parsed === null || typeof parsed !== 'object' ? undefined : parsed;
  } catch {
    return undefined;
  }
}
