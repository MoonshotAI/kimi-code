import type { LlmResolver } from '#human/llm/policy/resolver';
import { withProtocolCapabilities } from '#human/llm/protocol/rules/model';
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
      const tools =
        request.profile?.tools === undefined
          ? toolSelect.defaultTools(disclosure)
          : request.profile.tools;
      return {
        ...request,
        profile: {
          ...request.profile,
          tools,
        },
        content: {
          ...request.content,
          messages: toolSelect.shapeHistory(request.content.messages, disclosure),
        },
      };
    },
  };
}
