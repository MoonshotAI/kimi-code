import {
  countMediaParts,
  createMediaDegradeRecovery,
  forkMediaRecovery,
  type MediaReplacement,
} from '#human/llm/builtin/policy/media-degrade';
import type { Message } from '#human/llm/message';
import type { LlmRecovery, LlmRecoveryLedger } from '#human/llm/policy/recovery';
import type { LlmResolver } from '#human/llm/policy/resolver';
import { mediaUrlOf } from '#human/llm/protocol/kit/media';
import type { Model } from '#/llm-adapter/model/catalog';
import type { InitializedLlmRequester } from '#/llm-adapter/model/generate';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { buildMediaPathTag, mediaKindOfPart } from '#/agent/media/mediaRef';
import { READ_MEDIA_FILE_TOOL_NAME } from '#/agent/tools/read-media-file/read-media-file';

function hideReadMediaFile(messages: readonly Message[]): readonly Message[] {
  const hiddenCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.name === READ_MEDIA_FILE_TOOL_NAME) hiddenCallIds.add(call.id);
    }
  }
  if (hiddenCallIds.size === 0) return messages;
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || !hiddenCallIds.has(message.toolCallId)) out.push(message);
      continue;
    }
    if (message.role !== 'assistant') {
      out.push(message);
      continue;
    }
    const toolCalls = message.toolCalls.filter((call) => call.name !== READ_MEDIA_FILE_TOOL_NAME);
    if (toolCalls.length === message.toolCalls.length) {
      out.push(message);
      continue;
    }
    if (toolCalls.length > 0 || message.content.length > 0) out.push({ ...message, toolCalls });
  }
  return out;
}

export interface AgentMediaPolicy {
  readonly toolResolver: LlmResolver;
  readonly resolver: LlmResolver;
  readonly recovery: LlmRecovery;
  readonly refreshRecovery: (
    ledger: LlmRecoveryLedger,
    messages: readonly Message[],
  ) => Promise<LlmRecoveryLedger>;
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
  const replacement: MediaReplacement = (part) => {
    const path = mediaPaths.get(mediaUrlOf(part));
    if (path === undefined) return undefined;
    const kind = mediaKindOfPart(part);
    if (kind === undefined) return undefined;
    return { type: 'text', text: buildMediaPathTag(kind, path) };
  };
  return {
    toolResolver: {
      id: 'agent-media-tools',
      recoveryRequest: 'resolved',
      resolve: async (current) => {
        if (model.capabilities.image_in || model.capabilities.video_in) return current;
        const messages = hideReadMediaFile(current.content.messages);
        return {
          ...current,
          profile:
            current.profile === undefined
              ? undefined
              : {
                  ...current.profile,
                  tools: current.profile.tools?.filter((tool) => tool.name !== READ_MEDIA_FILE_TOOL_NAME),
                },
          content: { ...current.content, messages },
        };
      },
    },
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
    recovery: createMediaDegradeRecovery(replacement),
    refreshRecovery: async (ledger, messages) => {
      mediaPaths = await service.displayPaths(messages);
      return forkMediaRecovery(ledger, replacement);
    },
  };
}
