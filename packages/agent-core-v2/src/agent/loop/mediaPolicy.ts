import {
  countMediaParts,
  createMediaDegradeRecovery,
  forkMediaRecovery,
  type MediaReplacement,
} from '#human/llm/builtin/policy/media-degrade';
import { isMediaPart, type Message, type ToolMessage, type UserMessage } from '#human/llm/message';
import type { LlmErrorMessage } from '#human/llm/response';
import type { LlmRecovery, LlmRecoveryLedger } from '#human/llm/policy/recovery';
import type { LlmResolver } from '#human/llm/policy/resolver';
import { mediaUrlOf } from '#human/llm/protocol/kit/media';
import type { Model } from '#/llm-adapter/model/catalog';
import type { InitializedLlmRequester } from '#/llm-adapter/model/generate';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { buildMediaPathTag, daemonFileRefFromPart, matchMediaPathTags, mediaKindOfPart, type MediaPathTag } from '#/agent/media/mediaRef';
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

function isResourceNotFoundError(error: LlmErrorMessage, rawError: unknown): boolean {
  if (error.kind !== 'status' || error.statusCode !== 404) return false;
  if (typeof rawError !== 'object' || rawError === null) return false;
  const body = (rawError as { error?: unknown }).error;
  if (typeof body !== 'object' || body === null) return false;
  return (body as { type?: unknown }).type === 'resource_not_found_error';
}

function hasOnlyInlineMediaReplacements(
  beforeMessages: readonly Message[],
  afterMessages: readonly Message[],
): boolean {
  let replacements = 0;
  for (const [messageIndex, message] of beforeMessages.entries()) {
    const afterMessage = afterMessages[messageIndex];
    if (afterMessage === undefined || afterMessage.content.length !== message.content.length) {
      return false;
    }
    for (const [partIndex, beforePart] of message.content.entries()) {
      const afterPart = afterMessage.content[partIndex];
      if (daemonFileRefFromPart(beforePart) === undefined) {
        if (isMediaPart(beforePart) && !mediaUrlOf(beforePart).startsWith('data:')) return false;
        continue;
      }
      if (
        (afterPart?.type !== 'image_url' && afterPart?.type !== 'video_url') ||
        afterPart.type !== beforePart.type ||
        !mediaUrlOf(afterPart).startsWith('data:')
      ) {
        return false;
      }
      replacements += 1;
    }
  }
  return replacements > 0;
}

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
  const degradeRecovery = createMediaDegradeRecovery(replacement);
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
    recovery: {
      propose: async (ctx) => {
        if (
          isResourceNotFoundError(ctx.error, ctx.rawError) &&
          !ctx.appliedRecoveries.some(
            (recovery) =>
              recovery.strategy === 'media-resource-not-found' && recovery.action === 'base64',
          )
        ) {
          const messages = await service.resolve(
            ctx.request.content.messages,
            model,
            request,
            ctx.signal,
            true,
          );
          if (hasOnlyInlineMediaReplacements(ctx.request.content.messages, messages)) {
            return {
              strategy: 'media-resource-not-found',
              action: 'base64',
              rewrite: (current) => ({
                ...current,
                content: { ...current.content, messages },
              }),
            };
          }
        }
        return degradeRecovery.propose(ctx);
      },
    },
    refreshRecovery: async (ledger, messages) => {
      mediaPaths = await service.displayPaths(messages);
      return forkMediaRecovery(ledger, replacement);
    },
  };
}
