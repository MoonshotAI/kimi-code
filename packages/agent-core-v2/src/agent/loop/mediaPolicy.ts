import {
  countMediaParts,
  createMediaDegradeRecovery,
  forkMediaRecovery,
  type MediaReplacement,
} from '#human/llm/builtin/policy/media-degrade';
import type { Message, ToolMessage, UserMessage } from '#human/llm/message';
import type { LlmRecovery, LlmRecoveryLedger } from '#human/llm/policy/recovery';
import type { LlmResolver } from '#human/llm/policy/resolver';
import { mediaUrlOf } from '#human/llm/protocol/kit/media';
import type { Model } from '#/llm-adapter/model/catalog';
import type { InitializedLlmRequester } from '#/llm-adapter/model/generate';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { buildMediaPathTag, matchMediaPathTags, mediaKindOfPart, type MediaPathTag } from '#/agent/media/mediaRef';
import { READ_MEDIA_FILE_TOOL_NAME } from '#/agent/tools/read-media-file/read-media-file';

function mediaTagOf(message: ToolMessage): MediaPathTag | undefined {
  const text = message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  return matchMediaPathTags(text).find((entry) => entry.kind === 'image' || entry.kind === 'video');
}

function omittedReadMediaResult(tag: MediaPathTag): UserMessage {
  const hint =
    `[${tag.kind} omitted: a ReadMediaFile tool result was hidden because the current model does not support ${tag.kind} input; ` +
    `use a model with ${tag.kind} input capability to view it]`;
  return {
    role: 'user',
    content: [{ type: 'text', text: `${hint}\n${buildMediaPathTag(tag.kind, tag.path)}` }],
  };
}

function hideReadMediaFile(messages: readonly Message[]): readonly Message[] {
  const readMediaCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.name === READ_MEDIA_FILE_TOOL_NAME) readMediaCallIds.add(call.id);
    }
  }
  if (readMediaCallIds.size === 0) return messages;
  const mediaTags = new Map<string, MediaPathTag>();
  for (const message of messages) {
    if (message.role !== 'tool' || !readMediaCallIds.has(message.toolCallId)) continue;
    const tag = mediaTagOf(message);
    if (tag !== undefined) mediaTags.set(message.toolCallId, tag);
  }
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!readMediaCallIds.has(message.toolCallId)) {
        out.push(message);
        continue;
      }
      const tag = mediaTags.get(message.toolCallId);
      if (tag !== undefined) out.push(omittedReadMediaResult(tag));
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
