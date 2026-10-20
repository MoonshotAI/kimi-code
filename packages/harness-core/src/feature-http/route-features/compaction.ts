import { useApp } from '@moonshot-ai/agent-core/app/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import { CompactionRef } from '#/features/compaction/index';

import { agentFacade, unitsReady, useRootUnit } from '../scope';
import { useSessionAction } from '../route/session-action';
import { ErrorCode, readAgentId, sendErr, sendFacadeErr, sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';

export function useCompactionRoutes(prefix: string): void {
  void prefix;
  const app = useApp();
  const root = useRootUnit();
  useSessionAction('compact', async ({ sessionId, body, request, response }) => {
    try {
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.agents.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      await unitsReady(root);
      const compaction = agentFacade(root, CompactionRef, sessionId, agentId);
      if (compaction === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.COMPACTION_UNABLE,
          'compaction is unavailable (compaction feature is not installed)',
        );
        return;
      }
      try {
        await compaction.compact(normalizeOptional(body.instruction));
      } catch (error) {
        if (isCodedError(error)) {
          sendErr(request, response, ErrorCode.COMPACTION_UNABLE, error.message);
          return;
        }
        throw error;
      }
      sendOk(request, response, {});
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isCodedError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
