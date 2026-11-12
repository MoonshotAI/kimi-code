import {
  IWorkspaceService,
  readTowerProjection,
  type Scope,
  type TowerProjection,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  towerProjectionResponseSchema,
  type TowerProjectionResponse,
} from '../protocol/rest-tower';
import { workspaceIdParamSchema } from '../protocol/rest-workspace';

interface TowerRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerTowerRoutes(app: TowerRouteHost, core: Scope): void {
  const getTowerProjectionRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces/{workspace_id}/tower',
      params: workspaceIdParamSchema,
      success: { data: towerProjectionResponseSchema },
      errors: {
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description:
        'Read-only snapshot of the tower mission-control projection for a workspace (missions, roster liveness, recent activity)',
      tags: ['tower'],
      operationId: 'getTowerProjection',
    },
    async (req, reply) => {
      const { workspace_id } = req.params;
      const ws = await core.accessor.get(IWorkspaceService).get(workspace_id);
      if (ws === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }
      const projection = await readTowerProjection(ws.root);
      reply.send(okEnvelope(toWireTowerProjection(projection), req.id));
    },
  );
  app.get(
    getTowerProjectionRoute.path,
    getTowerProjectionRoute.options,
    getTowerProjectionRoute.handler as Parameters<TowerRouteHost['get']>[2],
  );
}

export function toWireTowerProjection(projection: TowerProjection): TowerProjectionResponse {
  return {
    status: projection.status,
    has_content: projection.hasContent,
    base: projection.base,
    mode: projection.mode,
    recovered_at: projection.recoveredAt,
    mission_counts: { ...projection.missionCounts },
    workers_live: projection.workersLive,
    reviewers_live: projection.reviewersLive,
    roster_total: projection.rosterTotal,
    open_missions: projection.openMissions.map((mission) => ({
      id: mission.id,
      title: mission.title,
      kind: mission.kind,
      status: mission.status,
      owner: mission.owner,
      branch: mission.branch,
      scope: [...mission.scope],
      tasks_done: mission.tasksDone,
      tasks_total: mission.tasksTotal,
      blockers: mission.blockers,
      latest_note_preview: mission.latestNotePreview,
      live_workers: mission.liveWorkers,
    })),
    recent_closed: projection.recentClosed.map((mission) => ({
      id: mission.id,
      title: mission.title,
      status: mission.status,
      closed_at: mission.closedAt,
    })),
    events: projection.events.map((event) => ({
      at: event.at,
      actor: event.actor,
      kind: event.kind,
      fields: { ...event.fields },
    })),
    log_offset: projection.logOffset,
  };
}
