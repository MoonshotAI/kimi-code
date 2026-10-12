import { MAIN_AGENT_ID, useApp } from '@moonshot-ai/agent-core';

import { BtwRef } from '#/features/btw/index';

import { useSessionAction } from '../route/session-action';
import { ErrorCode, sendErr, sendFacadeErr, sendOk } from '../route/http';

export function useBtwRoutes(prefix: string): void {
  void prefix;
  useSessionAction('btw', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      const session = app.get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      if (session.get(MAIN_AGENT_ID) === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${MAIN_AGENT_ID} does not exist`);
        return;
      }
      const btw = session.resolve(BtwRef);
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
