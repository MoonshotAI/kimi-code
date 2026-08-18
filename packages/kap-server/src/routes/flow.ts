import {
  ensureMainAgent,
  FLOW_FLAG_ID,
  IAgentFlowService,
  IFlagService,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { flowStateResponseSchema, type FlowStateResponse } from '../protocol/rest-flow';

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

interface FlowRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: { session_id: string } },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface FlowRouteDeps {
  readonly core: Scope;
}

export function registerFlowRoutes(app: FlowRouteHost, deps: FlowRouteDeps): void {
  const { core } = deps;

  const stateRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/flow',
      params: sessionIdParamSchema,
      success: { data: flowStateResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "Read a session's flow run state and gate audit records",
      tags: ['flow'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const handle = await resumeSessionById(core.accessor, session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      if (!core.accessor.get(IFlagService).enabled(FLOW_FLAG_ID)) {
        reply.send(okEnvelope({ run: { active: false }, gates: [] }, req.id));
        return;
      }
      const main = await ensureMainAgent(handle);
      const flow = main.accessor.get(IAgentFlowService);
      const run = flow.run();
      const gates = flow.gates();
      const payload: FlowStateResponse = {
        run: {
          active: run.active,
          flow_id: run.flowId ?? gates.flowId,
          task: run.task ?? gates.task,
          stages: run.stages?.map((stage) => ({
            id: stage.id,
            objective: stage.objective,
            completion: stage.completion,
            gate: stage.gate,
            notes: stage.notes,
          })),
          current_stage_index: run.currentStageIndex,
        },
        gates: flow.gates().records.map((record) => ({
          stage: record.stage,
          result: record.result,
          decided_by: record.decidedBy,
          criteria: record.criteria.map((criterion) => ({
            criterion: criterion.criterion,
            met: criterion.met,
            evidence: criterion.evidence,
          })),
          feedback: record.feedback,
        })),
      };
      reply.send(okEnvelope(payload, req.id));
    },
  );
  app.get(stateRoute.path, stateRoute.options, stateRoute.handler as Parameters<FlowRouteHost['get']>[2]);
}
