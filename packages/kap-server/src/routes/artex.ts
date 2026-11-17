import {
  Error2,
  ErrorCodes,
  IArtexSessionService,
  IArtexWorkStoreProvider,
  IFlagService,
  IWorkspaceService,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  artexControlBodySchema,
  artexExportQuerySchema,
  artexStartBodySchema,
  artexWorkspaceQuerySchema,
} from '../protocol/rest-artex';
import { isArtexRouteEnabled } from '../services/artex/artexGate';
import { createArtexGlobalFacade } from '../services/artex/artexGlobalFacade';
import { z } from 'zod';

interface ArtexRouteHost {
  get(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (req: { id: string; params: unknown; query?: unknown; body?: unknown }, reply: {
      send(payload: unknown): unknown;
    }) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (req: { id: string; params: unknown; query?: unknown; body?: unknown }, reply: {
      send(payload: unknown): unknown;
    }) => Promise<void> | void,
  ): unknown;
}

type RouteReply = { send(payload: unknown): unknown };

function sendArtexDisabled(reply: RouteReply, requestId: string): void {
  void reply.send(errEnvelope(ErrorCode.ARTEX_NOT_ENABLED, 'ARTEX is not enabled', requestId));
}

function routeQuery(req: unknown): Record<string, unknown> {
  if (typeof req !== 'object' || req === null || !('query' in req)) return {};
  const query = (req as { query?: unknown }).query;
  if (typeof query !== 'object' || query === null) return {};
  return query as Record<string, unknown>;
}

function explorationIdFromQuery(req: unknown): number | undefined {
  const q = routeQuery(req) as { exploration_id?: number };
  return q.exploration_id;
}

async function withSessionArtex(
  core: Scope,
  sessionId: string,
  req: { id: string },
  reply: RouteReply,
  run: (svc: IArtexSessionService) => Promise<void>,
): Promise<void> {
  if (!isArtexRouteEnabled(core)) {
    sendArtexDisabled(reply, req.id);
    return;
  }
  const handle = await resumeSessionById(core.accessor, sessionId);
  if (handle === undefined) {
    void reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, req.id));
    return;
  }
  let svc: IArtexSessionService;
  try {
    svc = handle.accessor.get(IArtexSessionService);
  } catch {
    sendArtexDisabled(reply, req.id);
    return;
  }
  await run(svc);
}

async function resolveWorkDir(
  core: Scope,
  query: { workspace_id?: string; cwd?: string },
): Promise<string | undefined> {
  if (query.cwd !== undefined && query.cwd !== '') return query.cwd;
  if (query.workspace_id === undefined) return undefined;
  const ws = await core.accessor.get(IWorkspaceService).get(query.workspace_id);
  return ws?.root;
}

function globalFacade(core: Scope) {
  return createArtexGlobalFacade({
    flags: core.accessor.get(IFlagService),
    workProvider: core.accessor.get(IArtexWorkStoreProvider),
  });
}

function mount(
  app: ArtexRouteHost,
  route: ReturnType<typeof defineRoute>,
): void {
  const registrar = route.method === 'POST' ? app.post.bind(app) : app.get.bind(app);
  registrar(route.path, route.options, route.handler as Parameters<ArtexRouteHost['get']>[2]);
}

export function registerArtexRoutes(app: ArtexRouteHost, core: Scope): void {
  const sessionIdParams = z.object({ session_id: z.string().min(1) });
  const sp = (suffix: string) => `/sessions/{session_id}/artex${suffix}`;

  mount(
    app,
    defineRoute(
      {
        method: 'GET',
        path: sp('/status'),
        params: sessionIdParams,
        tags: ['artex'],
        description: 'ARTEX exploration status',
      },
      async (req, reply) => {
        const { session_id } = req.params as { session_id: string };
        await withSessionArtex(core, session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.status(explorationIdFromQuery(req)), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      {
        method: 'POST',
        path: sp('/start'),
        params: sessionIdParams,
        body: artexStartBodySchema,
        tags: ['artex'],
      },
      async (req, reply) => {
        const { session_id } = req.params as { session_id: string };
        const body = req.body as z.infer<typeof artexStartBodySchema>;
        await withSessionArtex(core, session_id, req, reply, async (svc) => {
          void reply.send(
            okEnvelope(
              await svc.start({
                goal: body.goal,
                description: body.description,
                explorationId: body.exploration_id,
              }),
              req.id,
            ),
          );
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      {
        method: 'POST',
        path: sp('/control'),
        params: sessionIdParams,
        body: artexControlBodySchema,
        tags: ['artex'],
      },
      async (req, reply) => {
        const { session_id } = req.params as { session_id: string };
        const body = req.body as z.infer<typeof artexControlBodySchema>;
        await withSessionArtex(core, session_id, req, reply, async (svc) => {
          void reply.send(
            okEnvelope(
              await svc.control({ action: body.action, explorationId: body.exploration_id }),
              req.id,
            ),
          );
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/graph'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.graph(explorationIdFromQuery(req)), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/activity'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.activity(routeQuery(req) as never), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/findings'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.findings(explorationIdFromQuery(req)), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      {
        method: 'GET',
        path: sp('/findings/export'),
        params: sessionIdParams,
        querystring: artexExportQuerySchema,
        tags: ['artex'],
      },
      async (req, reply) => {
        const query = artexExportQuerySchema.parse(routeQuery(req));
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(
            okEnvelope(
              await svc.exportReport({ format: query.format, explorationId: query.exploration_id }),
              req.id,
            ),
          );
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/goals'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.goals(explorationIdFromQuery(req)), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/constraints'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.constraints(explorationIdFromQuery(req)), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/scope'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.scope(explorationIdFromQuery(req)), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/credentials'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.credentials(explorationIdFromQuery(req)), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/coverage'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.coverage(explorationIdFromQuery(req)), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/target-pins'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.targetPins(routeQuery(req) as never), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/traffic'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.trafficSearch(routeQuery(req) as never), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/traffic/hosts'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          void reply.send(okEnvelope(await svc.trafficHosts(), req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/traffic/exchange'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          const trafficId = ((routeQuery(req) as { traffic_id?: string }).traffic_id) ?? '';
          const raw = await svc.trafficExchange(trafficId);
          if (raw === undefined) {
            void reply.send(
              errEnvelope(ErrorCode.ARTEX_TRAFFIC_NOT_FOUND, `traffic ${trafficId} not found`, req.id),
            );
            return;
          }
          void reply.send(okEnvelope(raw, req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/traffic/blob'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          const q = routeQuery(req) as { hash?: string; offset?: number; length?: number };
          const raw = await svc.trafficBlob(q.hash ?? '', q.offset, q.length);
          if (raw === undefined) {
            void reply.send(errEnvelope(ErrorCode.ARTEX_TRAFFIC_NOT_FOUND, 'blob not found', req.id));
            return;
          }
          void reply.send(
            okEnvelope({ data_base64: raw.data.toString('base64'), total: raw.total }, req.id),
          );
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      { method: 'GET', path: sp('/tokens'), params: sessionIdParams, tags: ['artex'] },
      async (req, reply) => {
        await withSessionArtex(core, (req.params as { session_id: string }).session_id, req, reply, async (svc) => {
          const graph = await svc.graph(explorationIdFromQuery(req));
          void reply.send(okEnvelope({ token_rollup: graph.tokenRollup }, req.id));
        });
      },
    ),
  );

  mount(
    app,
    defineRoute(
      {
        method: 'GET',
        path: '/artex/companies',
        querystring: artexWorkspaceQuerySchema,
        tags: ['artex'],
      },
      async (req, reply) => {
        if (!isArtexRouteEnabled(core)) {
          sendArtexDisabled(reply, req.id);
          return;
        }
        const workDir = await resolveWorkDir(core, artexWorkspaceQuerySchema.parse(routeQuery(req)));
        if (workDir === undefined) {
          void reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'cwd or workspace_id required', req.id));
          return;
        }
        const facade = globalFacade(core);
        void reply.send(
          okEnvelope(
            await (facade as { listCompanies(workDir: string): Promise<unknown> }).listCompanies(
              workDir,
            ),
            req.id,
          ),
        );
      },
    ),
  );

  mount(
    app,
    defineRoute(
      {
        method: 'GET',
        path: '/artex/assets',
        querystring: artexWorkspaceQuerySchema,
        tags: ['artex'],
      },
      async (req, reply) => {
        if (!isArtexRouteEnabled(core)) {
          sendArtexDisabled(reply, req.id);
          return;
        }
        const workDir = await resolveWorkDir(core, artexWorkspaceQuerySchema.parse(routeQuery(req)));
        if (workDir === undefined) {
          void reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'cwd or workspace_id required', req.id));
          return;
        }
        const facade = globalFacade(core);
        void reply.send(
          okEnvelope(
            await (facade as { listAssets(workDir: string): Promise<unknown> }).listAssets(workDir),
            req.id,
          ),
        );
      },
    ),
  );
}

export function resolveArtexPseudoService(core: Scope, serviceName: string): object | undefined {
  if (serviceName !== 'artexGlobalFacade') return undefined;
  if (!isArtexRouteEnabled(core)) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'ARTEX is not enabled');
  }
  return globalFacade(core) as object;
}