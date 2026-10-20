import { useApp } from '@moonshot-ai/agent-core/app/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import { BtwRef } from '#/features/btw/index';

import { sessionFacade, unitsReady, useRootUnit } from '../scope';
import { useSessionAction } from '../route/session-action';
import { ErrorCode, sendErr, sendFacadeErr, sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';

export function useBtwRoutes(prefix: string): void {
  void prefix;
  const app = useApp();
  const root = useRootUnit();
  useSessionAction('btw', async ({ sessionId, request, response }) => {
    try {
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      if (session.agents.get(MAIN_AGENT_ID) === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${MAIN_AGENT_ID} does not exist`);
        return;
      }
      await unitsReady(root);
      const btw = sessionFacade(root, BtwRef, sessionId);
      if (btw === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.SESSION_BTW_UNAVAILABLE,
          'btw is unavailable (btw feature is not installed)',
        );
        return;
      }
      const started = await btw.ask();
      sendOk(request, response, { agent_id: started.agentId });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });
}
