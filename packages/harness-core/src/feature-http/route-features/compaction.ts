import { MAIN_AGENT_ID, useApp } from '@moonshot-ai/agent-core';

import { CompactionRef } from '#/features/compaction/index';

import { useSessionAction } from '../route/session-action';
import { ErrorCode, readAgentId, sendErr, sendFacadeErr, sendOk } from '../route/http';

export function useCompactionRoutes(prefix: string): void {
  void prefix;
  useSessionAction('compact', async ({ sessionId, body, request, response }) => {
    const app = useApp();
    try {
      const session = app.get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      const compaction = agent.resolve(CompactionRef);
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
