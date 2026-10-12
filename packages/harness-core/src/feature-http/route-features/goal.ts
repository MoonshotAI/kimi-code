import { MAIN_AGENT_ID, useApp } from '@moonshot-ai/agent-core';

import { GoalRef } from '#/features/goal/index';

import { useHttpRoute } from '../feature';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';

export function useGoalRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.goal',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/goal`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const session = await resumeSession(useApp(), sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agent = session.get(MAIN_AGENT_ID);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${MAIN_AGENT_ID} does not exist`);
        return;
      }
      const facade = agent.resolve(GoalRef);
      if (facade === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.GOAL_UNAVAILABLE,
          'session goal is unavailable (goal feature is not installed)',
        );
        return;
      }
      sendOk(request, response, facade.getGoal().goal);
    },
  });
}
