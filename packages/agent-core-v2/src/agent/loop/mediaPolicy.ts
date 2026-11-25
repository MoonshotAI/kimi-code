import { createMediaDegradeRecovery } from '@moonshot-ai/core/llm/builtin/policy/media-degrade';
import type { Message, ToolMessage, UserMessage } from '@moonshot-ai/core/llm/message';
import type { PolicyRegistry } from '@moonshot-ai/core/llm/policy/registry';
import type { LlmErrorMessage } from '@moonshot-ai/core/llm/response';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { buildMediaPathTag, matchMediaPathTags, type MediaPathTag } from '#/agent/media/mediaRef';
import { READ_MEDIA_FILE_TOOL_NAME } from '#/agent/tools/read-media-file/read-media-file';
import type { AgentRequesterBinding } from './requesterContract';

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
  return messages.flatMap((message): Message | Message[] => {
    if (message.role === 'tool') {
      if (!readMediaCallIds.has(message.toolCallId)) return message;
      const tag = mediaTags.get(message.toolCallId);
      return tag === undefined ? [] : omittedReadMediaResult(tag);
    }
    if (message.role !== 'assistant') return message;
    const toolCalls = message.toolCalls.filter((call) => call.name !== READ_MEDIA_FILE_TOOL_NAME);
    if (toolCalls.length === message.toolCalls.length) return message;
    if (toolCalls.length > 0 || message.content.length > 0) return { ...message, toolCalls };
    return [];
  });
}

export function registerAgentMediaTools(policy: PolicyRegistry): () => void {
  return policy.addResolver({
    id: 'agent-media-tools',
    recoveryRequest: 'resolved',
    resolve: async (current) => {
      const capability = current.model.spec.capability;
      if (capability?.image_in === true || capability?.video_in === true) {
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
                tools: current.profile.tools?.filter((tool) => tool.name !== READ_MEDIA_FILE_TOOL_NAME),
              },
        content: { ...current.content, messages },
      };
    },
  });
}

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

export function registerAgentMediaPolicy(
  policy: PolicyRegistry,
  service: IAgentMediaResolverService,
  binding: () => AgentRequesterBinding | undefined,
): () => void {
  const degradeRecovery = createMediaDegradeRecovery();
  const checkedUploadRuns = new WeakSet<AbortSignal>();
  const removeResolver = policy.addResolver({
    id: 'agent-media',
    resolve: async (current, control) => {
      const bound = binding();
      if (bound === undefined) return current;
      const messages = await service.resolve(
        current.content.messages,
        bound.model,
        bound.request,
        control.signal,
      );
      return messages === current.content.messages
        ? current
        : { ...current, content: { ...current.content, messages } };
    },
  });
  const removeRecovery = policy.addRecovery({
    propose: async (ctx) => {
      const bound = binding();
      const alreadyChecked = ctx.signal !== undefined && checkedUploadRuns.has(ctx.signal);
      if (
        bound !== undefined &&
        !alreadyChecked &&
        !ctx.appliedRecoveries.some(({ strategy }) => strategy === MEDIA_UPLOAD_FAILED) &&
        ctx.resolvedRequest !== undefined &&
        isUploadedMediaRequestError(ctx.error, ctx.rawError)
      ) {
        if (ctx.signal !== undefined) checkedUploadRuns.add(ctx.signal);
        if (await service.recoverFailedUploads(ctx.resolvedRequest.content.messages, bound.request, ctx.signal)) {
          return { strategy: MEDIA_UPLOAD_FAILED, action: 'retry' };
        }
      }
      return degradeRecovery.propose(ctx);
    },
  });
  return () => {
    removeResolver();
    removeRecovery();
  };
}
