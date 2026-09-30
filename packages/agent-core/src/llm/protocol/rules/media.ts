import {
  isMediaPart,
  mediaKindOfPart,
  mediaPlaceholderText,
  type ContentPart,
  type MediaKind,
  type MediaPart,
  type MediaPlaceholderReason,
  type MediaSource,
  type Message,
  type ToolMessage,
} from '#/llm/message';
import { capabilityAccepts, type ModelCapability } from '#/llm/request';

import { unresolvedMediaRefError } from '../errors';

export type MediaPosition = 'content' | 'tool_result';

export interface MediaKindSupport {
  readonly mimes: ReadonlySet<string> | 'any';
  readonly sources: readonly Exclude<MediaSource['kind'], 'store'>[];
  readonly url?: (url: string) => boolean;
  readonly inToolResult: 'native' | 'relocate' | 'unsupported';
}

export interface MediaSupport {
  readonly kinds: Partial<Readonly<Record<MediaKind, MediaKindSupport>>>;
}

export function mediaSupportAt(
  support: MediaSupport,
  kind: MediaKind,
  position: MediaPosition,
): MediaKindSupport | undefined {
  const spec = support.kinds[kind];
  if (spec === undefined) return undefined;
  return position === 'tool_result' && spec.inToolResult === 'unsupported' ? undefined : spec;
}

export function acceptsMime(spec: MediaKindSupport, mimeType: string): boolean {
  return spec.mimes === 'any' || spec.mimes.has(mimeType);
}

export function acceptsSource(spec: MediaKindSupport, source: MediaSource): boolean {
  switch (source.kind) {
    case 'store':
      return true;
    case 'url':
      return spec.sources.includes('url') && (spec.url?.(source.url) ?? true);
    case 'inline':
    case 'file':
      return spec.sources.includes(source.kind) && acceptsMime(spec, source.mimeType);
  }
}

const RELOCATED_MEDIA_TEXT = '(see attached media)';
const RELOCATED_MEDIA_PROMPT = 'Attached media from tool result:';

function positionOf(message: Message): MediaPosition {
  return message.role === 'tool' ? 'tool_result' : 'content';
}

function placeholderReason(
  part: MediaPart,
  position: MediaPosition,
  capability: ModelCapability | undefined,
  support: MediaSupport,
): MediaPlaceholderReason | undefined {
  if (part.omitted !== undefined) return part.omitted;
  const kind = mediaKindOfPart(part);
  if (!capabilityAccepts(capability, kind)) return 'unsupported';
  const spec = mediaSupportAt(support, kind, position);
  if (spec === undefined) return 'protocol_unsupported';
  return acceptsSource(spec, part.source) ? undefined : 'stripped';
}

export function legalizeMedia(
  messages: readonly Message[],
  capability: ModelCapability | undefined,
  support: MediaSupport,
): readonly Message[] {
  let changed = false;
  const out = messages.map((message) => {
    const position = positionOf(message);
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (!isMediaPart(part)) return part;
      const reason = placeholderReason(part, position, capability, support);
      if (reason === undefined) return part;
      messageChanged = true;
      return { type: 'text', text: mediaPlaceholderText(mediaKindOfPart(part), reason) };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : messages;
}

function relocates(part: ContentPart, support: MediaSupport): part is MediaPart {
  return isMediaPart(part) && support.kinds[mediaKindOfPart(part)]?.inToolResult === 'relocate';
}

function withoutRelocated(message: ToolMessage, support: MediaSupport): ToolMessage {
  const content = message.content.filter((part) => !relocates(part, support));
  if (content.length === message.content.length) return message;
  const hasBody = content.some((part) => part.type !== 'think');
  return {
    ...message,
    content: hasBody ? content : [{ type: 'text', text: RELOCATED_MEDIA_TEXT }, ...content],
  };
}

export function relocateToolMedia(messages: readonly Message[], support: MediaSupport): readonly Message[] {
  if (!messages.some((message) => message.role === 'tool' && message.content.some((part) => relocates(part, support)))) {
    return messages;
  }
  const out: Message[] = [];
  let relocated: MediaPart[] = [];
  const flush = (): void => {
    if (relocated.length === 0) return;
    out.push({ role: 'user', content: [{ type: 'text', text: RELOCATED_MEDIA_PROMPT }, ...relocated] });
    relocated = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') {
      flush();
      out.push(message);
      continue;
    }
    relocated.push(...message.content.filter((part) => relocates(part, support)));
    out.push(withoutRelocated(message, support));
  }
  flush();
  return out;
}

export function verifyMediaResolved(messages: readonly Message[]): readonly Message[] {
  for (const message of messages) {
    for (const part of message.content) {
      if (isMediaPart(part) && part.source.kind === 'store') {
        throw unresolvedMediaRefError(part.source.ref);
      }
    }
  }
  return messages;
}
