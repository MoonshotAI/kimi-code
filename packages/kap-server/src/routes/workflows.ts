/**
 * `/sessions/{session_id}/workflows*` REST routes — server-v2 port.
 *
 * Implements Dynamic Workflow REST endpoints on top of `agent-core-v2`:
 *
 *   GET  /sessions/{session_id}/workflows                     data: { items: WorkflowSummary[] }
 *   GET  /sessions/{session_id}/workflows/{name}              data: { workflow: WorkflowDetail | null }
 *   POST /sessions/{session_id}/workflows/run                 data: { runId, taskId, workflowName }
 *   GET  /sessions/{session_id}/workflows/runs                data: { items: WorkflowRunRecord[] }
 *   GET  /sessions/{session_id}/workflows/runs/{runId}        data: { run: WorkflowRunRecord | null }
 *   POST /sessions/{session_id}/workflows/runs/{runId}/cancel data: { cancelled: boolean }
 *   POST /sessions/{session_id}/workflows/save                data: { path, name }
 *   POST /sessions/{session_id}/workflows/reload              data: { workflows[], skipped[] }
 *
 * **Resolution**: `core` → `IWorkflowCatalogService` (App scope) directly.
 * For Session-scoped `IWorkflowRunService`, resolves via `ISessionIndex`
 * (existence, → 40401) → `ISessionLifecycleService` → `ensureMainAgent`.
 *
 * **Error mapping**:
 *   - unknown session   → 40401 (session.not_found)
 *   - workflow not found → 40406 (task.not_found, reused like tasks.ts)
 */

import {
  IAgentLifecycleService,
  IWorkflowCatalogService,
  IWorkflowRunService,
  ISessionIndex,
  ISessionLifecycleService,
  type Scope,
  MAIN_AGENT_ID,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { z } from 'zod';

import type { WorkflowDefinition, SkippedWorkflow } from '@moonshot-ai/agent-core-v2';
import type { WorkflowRunRecord } from '@moonshot-ai/agent-core-v2';

interface WorkflowsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

// --- Param schemas ----------------------------------------------------------

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionIdNameParamSchema = z.object({
  session_id: z.string().min(1),
  name: z.string().min(1),
});

const sessionIdRunIdParamSchema = z.object({
  session_id: z.string().min(1),
  runId: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

// --- Wire schemas -----------------------------------------------------------

const workflowPhaseMetaSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
});

const workflowSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  argumentHint: z.string().optional(),
  phases: z.array(workflowPhaseMetaSchema),
  path: z.string(),
  source: z.string(),
});

const workflowDetailSchema = workflowSummarySchema.extend({
  script: z.string(),
});

const listWorkflowsResponseSchema = z.object({
  items: z.array(workflowSummarySchema),
});

const getWorkflowResponseSchema = z.object({
  workflow: workflowDetailSchema.nullable(),
});

const runWorkflowBodySchema = z.object({
  name: z.string().optional(),
  script: z.string().optional(),
  args: z.string().optional(),
});

const runWorkflowResultSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  workflowName: z.string(),
});

const workflowRunStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);

const workflowRunRecordSchema = z.object({
  runId: z.string(),
  workflowName: z.string(),
  description: z.string(),
  phases: z.array(workflowPhaseMetaSchema),
  status: workflowRunStatusSchema,
  phase: z.string().optional(),
  phaseIndex: z.number().optional(),
  agentCalls: z.number(),
  logs: z.array(z.string()),
  error: z.string().optional(),
  resultJson: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  taskId: z.string().optional(),
  scriptPath: z.string().optional(),
  source: z.string(),
  script: z.string(),
  args: z.string(),
  callerAgentId: z.string(),
});

const listWorkflowRunsResponseSchema = z.object({
  items: z.array(workflowRunRecordSchema),
});

const getWorkflowRunResponseSchema = z.object({
  run: workflowRunRecordSchema.nullable(),
});

const cancelWorkflowRunResultSchema = z.object({
  cancelled: z.boolean(),
});

const saveWorkflowBodySchema = z.object({
  script: z.string(),
  scope: z.enum(['project', 'user']),
  overwrite: z.boolean().optional(),
});

const saveWorkflowResultSchema = z.object({
  path: z.string(),
  name: z.string(),
});

const skippedWorkflowSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

const reloadWorkflowsResultSchema = z.object({
  workflows: z.array(workflowSummarySchema),
  skipped: z.array(skippedWorkflowSchema),
});

// --- Helpers ----------------------------------------------------------------

type WireWorkflowSummary = z.infer<typeof workflowSummarySchema>;
type WireWorkflowDetail = z.infer<typeof workflowDetailSchema>;

function toWorkflowSummary(def: WorkflowDefinition): WireWorkflowSummary {
  return {
    name: def.meta.name,
    description: def.meta.description,
    whenToUse: def.meta.whenToUse,
    argumentHint: def.meta.argumentHint,
    phases: def.meta.phases.map((p) => ({ title: p.title, detail: p.detail })),
    path: def.path,
    source: def.source,
  };
}

function toWorkflowDetail(def: WorkflowDefinition): WireWorkflowDetail {
  return {
    ...toWorkflowSummary(def),
    script: def.script,
  };
}

// --- Session resolution -----------------------------------------------------

async function resolveSession(core: Scope, sid: string): Promise<'not_found' | 'ok'> {
  const summary = await core.accessor.get(ISessionIndex).get(sid);
  if (summary === undefined) return 'not_found';
  return 'ok';
}

// --- Registration -----------------------------------------------------------

export function registerWorkflowsRoutes(app: WorkflowsRouteHost, core: Scope): void {
  const catalog = core.accessor.get(IWorkflowCatalogService);

  // GET /sessions/{session_id}/workflows --------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/workflows',
      params: sessionIdParamSchema,
      success: { data: listWorkflowsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List workflows for a session',
      tags: ['workflows'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const status = await resolveSession(core, session_id);
      if (status === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }
      await catalog.ready;
      const items = catalog.list().map(toWorkflowSummary);
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<WorkflowsRouteHost['get']>[2]);

  // GET /sessions/{session_id}/workflows/{name} ------------------------
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/workflows/{name}',
      params: sessionIdNameParamSchema,
      success: { data: getWorkflowResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get a workflow by name',
      tags: ['workflows'],
    },
    async (req, reply) => {
      const { session_id, name } = req.params;
      const status = await resolveSession(core, session_id);
      if (status === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }
      await catalog.ready;
      const def = catalog.get(name);
      reply.send(okEnvelope({ workflow: def ? toWorkflowDetail(def) : null }, req.id));
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<WorkflowsRouteHost['get']>[2]);

  // POST /sessions/{session_id}/workflows/run --------------------------
  const runRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/workflows/run',
      params: sessionIdParamSchema,
      body: runWorkflowBodySchema,
      success: { data: runWorkflowResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Start a workflow run',
      tags: ['workflows'],
      operationId: 'runWorkflow',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const status = await resolveSession(core, session_id);
      if (status === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const session = core.accessor.get(ISessionLifecycleService).get(session_id);
      if (session === undefined) {
        // Session summary exists but is not live (closed) → cannot run
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} is not active`, req.id));
        return;
      }
      const agent = await ensureMainAgent(session);
      const runService = agent.accessor.get(IWorkflowRunService);

      const body = req.body as z.infer<typeof runWorkflowBodySchema>;
      const result = await runService.start({
        name: body.name,
        script: body.script,
        args: body.args ?? '',
        callerAgentId: MAIN_AGENT_ID,
      });

      // Read back the run record to get the workflowName populated by the service
      const record = runService.get(result.runId);
      const workflowName = record?.workflowName ?? body.name ?? 'inline';

      requestLog(req)?.info({ session_id, runId: result.runId }, 'workflow run started');
      reply.send(okEnvelope({ runId: result.runId, taskId: result.taskId, workflowName }, req.id));
    },
  );
  app.post(runRoute.path, runRoute.options, runRoute.handler as Parameters<WorkflowsRouteHost['post']>[2]);

  // GET /sessions/{session_id}/workflows/runs --------------------------
  const listRunsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/workflows/runs',
      params: sessionIdParamSchema,
      success: { data: listWorkflowRunsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List workflow runs for a session',
      tags: ['workflows'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const status = await resolveSession(core, session_id);
      if (status === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const session = core.accessor.get(ISessionLifecycleService).get(session_id);
      if (session === undefined) {
        reply.send(okEnvelope({ items: [] }, req.id));
        return;
      }
      const agent = session.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
      if (agent === undefined) {
        reply.send(okEnvelope({ items: [] }, req.id));
        return;
      }
      const runService = agent.accessor.get(IWorkflowRunService);
      const items = runService.list();
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(listRunsRoute.path, listRunsRoute.options, listRunsRoute.handler as Parameters<WorkflowsRouteHost['get']>[2]);

  // GET /sessions/{session_id}/workflows/runs/{runId} ------------------
  const getRunRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/workflows/runs/{runId}',
      params: sessionIdRunIdParamSchema,
      success: { data: getWorkflowRunResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TASK_NOT_FOUND]: {},
      },
      description: 'Get a workflow run by ID',
      tags: ['workflows'],
    },
    async (req, reply) => {
      const { session_id, runId } = req.params;
      const status = await resolveSession(core, session_id);
      if (status === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const runService = await resolveRunService(core, session_id);
      if (runService === undefined) {
        reply.send(okEnvelope({ run: null }, req.id));
        return;
      }
      const record = runService.get(runId);
      reply.send(okEnvelope({ run: record ?? null }, req.id));
    },
  );
  app.get(getRunRoute.path, getRunRoute.options, getRunRoute.handler as Parameters<WorkflowsRouteHost['get']>[2]);

  // POST /sessions/{session_id}/workflows/runs/{runId}/cancel ----------
  const cancelRunRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/workflows/runs/{runId}/cancel',
      params: sessionIdRunIdParamSchema,
      success: { data: cancelWorkflowRunResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TASK_NOT_FOUND]: {},
      },
      description: 'Cancel a workflow run',
      tags: ['workflows'],
      operationId: 'cancelWorkflowRun',
    },
    async (req, reply) => {
      const { session_id, runId } = req.params;
      const status = await resolveSession(core, session_id);
      if (status === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const runService = await resolveRunService(core, session_id);
      if (runService === undefined) {
        reply.send(
          errEnvelope(ErrorCode.TASK_NOT_FOUND, `workflow run ${runId} does not exist in session ${session_id}`, req.id),
        );
        return;
      }
      const cancelled = runService.cancel(runId);
      requestLog(req)?.info({ session_id, runId, cancelled }, 'workflow run cancelled');
      reply.send(okEnvelope({ cancelled }, req.id));
    },
  );
  app.post(cancelRunRoute.path, cancelRunRoute.options, cancelRunRoute.handler as Parameters<WorkflowsRouteHost['post']>[2]);

  // POST /sessions/{session_id}/workflows/save -------------------------
  const saveRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/workflows/save',
      params: sessionIdParamSchema,
      body: saveWorkflowBodySchema,
      success: { data: saveWorkflowResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Save a workflow script',
      tags: ['workflows'],
      operationId: 'saveWorkflow',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const status = await resolveSession(core, session_id);
      if (status === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const body = req.body as z.infer<typeof saveWorkflowBodySchema>;
      const saved = await catalog.save(body);
      // Reload the catalog and find the saved workflow to derive its name
      await catalog.reload();
      const workflows = catalog.list();
      const match = workflows.find((w) => w.path === saved.path);
      const name = match?.meta.name ?? saved.path.replace(/\.md$/, '').split('/').pop() ?? 'unknown';

      requestLog(req)?.info({ session_id, path: saved.path, name }, 'workflow saved');
      reply.send(okEnvelope({ path: saved.path, name }, req.id));
    },
  );
  app.post(saveRoute.path, saveRoute.options, saveRoute.handler as Parameters<WorkflowsRouteHost['post']>[2]);

  // POST /sessions/{session_id}/workflows/reload -----------------------
  const reloadRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/workflows/reload',
      params: sessionIdParamSchema,
      success: { data: reloadWorkflowsResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Reload workflow catalog from disk',
      tags: ['workflows'],
      operationId: 'reloadWorkflows',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const status = await resolveSession(core, session_id);
      if (status === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      await catalog.reload();
      const workflows = catalog.list().map(toWorkflowSummary);
      const skipped = catalog.skipped().map((s: SkippedWorkflow) => ({ path: s.path, reason: s.reason }));

      requestLog(req)?.info({ session_id, count: workflows.length, skipped: skipped.length }, 'workflows reloaded');
      reply.send(okEnvelope({ workflows, skipped }, req.id));
    },
  );
  app.post(reloadRoute.path, reloadRoute.options, reloadRoute.handler as Parameters<WorkflowsRouteHost['post']>[2]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionNotFound(sid: string, requestId: string): unknown {
  return errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${sid} does not exist`, requestId);
}

/**
 * Resolve the `IWorkflowRunService` for a session. Returns `undefined` when
 * the session is not live or has no main agent (same gap G10 pattern as tasks).
 */
async function resolveRunService(
  core: Scope,
  sid: string,
): Promise<IWorkflowRunService | undefined> {
  const session = core.accessor.get(ISessionLifecycleService).get(sid);
  if (session === undefined) return undefined;
  const agent = session.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
  if (agent === undefined) return undefined;
  return agent.accessor.get(IWorkflowRunService);
}
