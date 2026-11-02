import type { LlmRecovery, LlmRecoveryRecord } from '#human/llm/policy/recovery';
import type { LlmResolver } from '#human/llm/policy/resolver';
import type { LlmRequest } from '#human/llm/request';

import type { AgentLoopProjector } from './projector';

export const STRUCTURE_RECOVERY_STRATEGY = 'structure';

export function hasStrictStructureRecovery(
  recoveries: readonly LlmRecoveryRecord[],
): boolean {
  return recoveries.some(
    (recovery) =>
      recovery.strategy === STRUCTURE_RECOVERY_STRATEGY && recovery.action === 'strict',
  );
}

function projectRequest(
  request: LlmRequest,
  projector: AgentLoopProjector,
  strict: boolean,
): LlmRequest {
  return {
    ...request,
    content: {
      ...request.content,
      messages: projector.project(request.content.messages, strict),
    },
  };
}

export function createStructureResolver(projector: AgentLoopProjector): LlmResolver {
  return {
    id: 'structure',
    resolve: async (request, control) =>
      hasStrictStructureRecovery(control.appliedRecoveries)
        ? request
        : projectRequest(request, projector, false),
  };
}

export function createStructureRecovery(projector: AgentLoopProjector): LlmRecovery {
  return {
    propose: ({ error, request: recoveryRequest, appliedRecoveries }) => {
      if (error.kind !== 'request_structure') return undefined;
      if (hasStrictStructureRecovery(appliedRecoveries)) return undefined;
      return {
        strategy: STRUCTURE_RECOVERY_STRATEGY,
        action: 'strict',
        rewrite: (request) =>
          projectRequest(
            {
              ...request,
              content: { ...request.content, messages: recoveryRequest.content.messages },
            },
            projector,
            true,
          ),
      };
    },
  };
}
