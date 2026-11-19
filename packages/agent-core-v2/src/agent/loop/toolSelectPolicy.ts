import type { LlmResolver } from '@moonshot-ai/core/llm/policy/resolver';
import { withProtocolCapabilities } from '@moonshot-ai/core/llm/protocol/rules/model';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';

export function createToolSelectResolver(toolSelect: IAgentToolSelectService): LlmResolver {
  return {
    id: 'tool-select',
    recoveryRequest: 'resolved',
    resolve: async (request, ctl) => {
      await toolSelect.prepareForRequest(ctl.signal);
      const capabilities =
        withProtocolCapabilities(request.model.spec, request.protocol.base).capability ?? {};
      const disclosure = toolSelect.enabled(capabilities);
      const base = request.profile?.tools;
      const deferred = disclosure
        ? (base ?? []).filter((tool) => tool.deferred === true)
        : undefined;
      const tools = toolSelect.requestTools(base, disclosure);
      return {
        ...request,
        profile: {
          ...request.profile,
          tools,
        },
        content: {
          ...request.content,
          messages: toolSelect.shapeHistory(request.content.messages, disclosure, tools, deferred),
        },
      };
    },
  };
}
