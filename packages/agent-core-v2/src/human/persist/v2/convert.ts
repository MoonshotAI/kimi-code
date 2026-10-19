import type { AssistantMeta, HistoryMessage } from '#/agent/turn';
import type { FinishReason } from '#/llm/finish-reason';
import type { ContentPart } from '#/llm/message';
import { emptyUsage } from '#/llm/usage';

import type { V2AssistantExtra, V2ContextMessage, V2PromptOrigin } from './fold';

const BLOBREF_PROTOCOL = 'blobref:';
const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export type V2BlobResolver = (hash: string) => Promise<string | null>;

function parseBlobRef(url: string): { mimeType: string; hash: string } | undefined {
  if (!url.startsWith(BLOBREF_PROTOCOL)) return undefined;
  const rest = url.slice(BLOBREF_PROTOCOL.length);
  const semiIndex = rest.indexOf(';');
  if (semiIndex === -1) return undefined;
  const hash = rest.slice(semiIndex + 1);
  if (hash.length === 0) return undefined;
  return { mimeType: rest.slice(0, semiIndex), hash };
}

async function resolvePart(part: ContentPart, resolveBlob: V2BlobResolver): Promise<ContentPart> {
  let updated: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(part)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    if (!('url' in value)) continue;
    const url = (value as { url: unknown }).url;
    if (typeof url !== 'string') continue;
    const ref = parseBlobRef(url);
    if (ref === undefined) continue;
    const payload = await resolveBlob(ref.hash);
    const resolved = payload === null ? MISSING_MEDIA_PLACEHOLDER : `data:${ref.mimeType};base64,${payload}`;
    if (updated === undefined) updated = { ...part };
    updated[key] = { ...(value as object), url: resolved };
  }
  return updated === undefined ? part : (updated as unknown as ContentPart);
}

async function resolveContent(
  content: readonly ContentPart[],
  resolveBlob: V2BlobResolver,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  for (const part of content) {
    parts.push(await resolvePart(part, resolveBlob));
  }
  return parts;
}

function mapOriginToSource(origin: V2PromptOrigin | undefined): string {
  if (origin === undefined) return 'input';
  if (origin.kind === 'user') return 'input';
  if (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  ) {
    return 'input';
  }
  return origin.kind;
}

function mapFinishReason(reason: string | undefined): FinishReason | null {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'end_turn':
      return 'completed';
    case 'max_tokens':
      return 'truncated';
    case 'filtered':
      return 'filtered';
    case 'paused':
      return 'paused';
    case 'other':
      return 'other';
    default:
      return null;
  }
}

function buildAssistantMeta(extra: V2AssistantExtra | undefined): AssistantMeta {
  const meta: AssistantMeta = { usage: extra?.usage ?? emptyUsage() };
  if (extra === undefined) return meta;
  if (extra.model !== undefined) meta.model = extra.model;
  if (extra.messageId !== undefined) meta.messageId = extra.messageId;
  const rawFinishReason = extra.rawFinishReason ?? extra.providerFinishReason ?? null;
  const finishReason = mapFinishReason(extra.finishReason);
  if (finishReason !== null || rawFinishReason !== null) {
    meta.finish = { finishReason, rawFinishReason };
  }
  return meta;
}

export async function convertV2Message(
  message: V2ContextMessage,
  extra: V2AssistantExtra | undefined,
  resolveBlob: V2BlobResolver,
): Promise<HistoryMessage | null> {
  const content = await resolveContent(message.content ?? [], resolveBlob);
  switch (message.role) {
    case 'system':
      return { message: { role: 'system', content }, meta: {} };
    case 'user':
      return {
        message: { role: 'user', content },
        meta: { source: mapOriginToSource(message.origin) },
      };
    case 'assistant':
      return {
        message: { role: 'assistant', content, toolCalls: message.toolCalls ?? [] },
        meta: buildAssistantMeta(extra),
      };
    case 'tool':
      return {
        message: { role: 'tool', content, toolCallId: message.toolCallId ?? '' },
        meta: { source: 'tool' },
      };
    default:
      return null;
  }
}
