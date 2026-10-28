import {
  countMediaParts,
  createMediaDegradeRecovery,
} from '#human/llm/builtin/policy/media-degrade';
import type { LlmRecovery } from '#human/llm/policy/recovery';
import type { LlmResolver } from '#human/llm/policy/resolver';
import { mediaUrlOf } from '#human/llm/protocol/kit/media';
import type { Model } from '#/llm-adapter/model/catalog';
import type { InitializedLlmRequester } from '#/llm-adapter/model/generate';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { buildMediaPathTag, mediaKindOfPart } from '#/agent/media/mediaRef';

export interface AgentMediaPolicy {
  readonly resolver: LlmResolver;
  readonly recovery: LlmRecovery;
}

export type AgentMediaPolicyFactory = (
  model: Model,
  request: InitializedLlmRequester,
) => AgentMediaPolicy;

export function createAgentMediaPolicy(
  service: IAgentMediaResolverService,
  model: Model,
  request: InitializedLlmRequester,
): AgentMediaPolicy {
  let mediaPaths: ReadonlyMap<string, string> = new Map();
  return {
    resolver: {
      id: 'agent-media',
      resolve: async (current, control) => {
        mediaPaths =
          countMediaParts(current.content.messages) === 0
            ? new Map()
            : await service.displayPaths(current.content.messages);
        const messages = await service.resolve(current.content.messages, model, request, control.signal);
        return messages === current.content.messages
          ? current
          : { ...current, content: { ...current.content, messages } };
      },
    },
    recovery: createMediaDegradeRecovery((part) => {
      const path = mediaPaths.get(mediaUrlOf(part));
      if (path === undefined) return undefined;
      const kind = mediaKindOfPart(part);
      if (kind === undefined) return undefined;
      return { type: 'text', text: buildMediaPathTag(kind, path) };
    }),
  };
}
