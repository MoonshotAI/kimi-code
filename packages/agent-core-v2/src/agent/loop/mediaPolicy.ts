import { createMediaDegradeRecovery } from '@moonshot-ai/core/llm/builtin/policy/media-degrade';
import type { Message, ToolMessage, UserMessage } from '@moonshot-ai/core/llm/message';
import type { LlmRecovery } from '@moonshot-ai/core/llm/policy/recovery';
import type { LlmResolver } from '@moonshot-ai/core/llm/policy/resolver';
import type { LlmErrorMessage } from '@moonshot-ai/core/llm/response';
import type { Model } from '#/llm-adapter/model/catalog';
import type { InitializedLlmRequester } from '@moonshot-ai/core/llm/requester';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { buildMediaPathTag, matchMediaPathTags, type MediaPathTag } from '#/agent/media/mediaRef';

export const LEGACY_READ_MEDIA_FILE_TOOL_NAME = 'ReadMediaFile';

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

export function hideReadMediaFile(messages: readonly Message[]): readonly Message[] {
  const readMediaCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.name === LEGACY_READ_MEDIA_FILE_TOOL_NAME) readMediaCallIds.add(call.id);
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
    const toolCalls = message.toolCalls.filter((call) => call.name !== LEGACY_READ_MEDIA_FILE_TOOL_NAME);
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
}

export type AgentMediaPolicyFactory = (
  model: Model,
  request: InitializedLlmRequester,
) => AgentMediaPolicy;

const MEDIA_UPLOAD_FAILED = 'media-upload-failed';

function isUploadedMediaRequestError(error: LlmErrorMessage, rawError: unknown): boolean {
  if (error.kind !== 'status' || error.statusCode !== 400) return false;
  if (/failed to validate image_url content:\s*blob ID \S+ does not exist\b/i.test(error.message)) {
    return true;
  }
  if (error.message.trim() !== 'Invalid request Error') return false;
  if (typeof rawError !== 'object' || rawError === null) return false;
  const body = (rawError as { error?: unknown }).error;
  if (typeof body !== 'object' || body === null) return false;
  const { type, error: nested } = body as { type?: unknown; error?: { type?: unknown } };
  return (nested?.type ?? type) === 'invalid_request_error';
}

export function createAgentMediaPolicy(
  service: IAgentMediaResolverService,
  model: Model,
  request: InitializedLlmRequester,
): AgentMediaPolicy {
  let checkedUploads = false;
  const degradeRecovery = createMediaDegradeRecovery();
  return {
    toolResolver: {
      id: 'agent-media-tools',
      recoveryRequest: 'resolved',
      resolve: async (current) => {
        if (model.spec.capability?.image_in === true || model.spec.capability?.video_in === true) {
          return current;
        }
        const messages = hideReadMediaFile(current.content.messages);
        return {
          ...current,
          profile:
            current.profile === undefined
              ? undefined
              : {
                  ...current.profile,
                  tools: current.profile.tools?.filter((tool) => tool.name !== LEGACY_READ_MEDIA_FILE_TOOL_NAME),
                },
          content: { ...current.content, messages },
        };
      },
    },
    resolver: {
      id: 'agent-media',
      resolve: async (current, control) => {
        const messages = await service.resolve(current.content.messages, model, request, control.signal);
        return messages === current.content.messages
          ? current
          : { ...current, content: { ...current.content, messages } };
      },
    },
    recovery: {
      propose: async (ctx) => {
        if (
          !checkedUploads &&
          !ctx.appliedRecoveries.some(({ strategy }) => strategy === MEDIA_UPLOAD_FAILED) &&
          ctx.resolvedRequest !== undefined &&
          isUploadedMediaRequestError(ctx.error, ctx.rawError)
        ) {
          checkedUploads = true;
          if (await service.recoverFailedUploads(ctx.resolvedRequest.content.messages, request, ctx.signal)) {
            return { strategy: MEDIA_UPLOAD_FAILED, action: 'retry' };
          }
        }
        return degradeRecovery.propose(ctx);
      },
    },
  };
}
