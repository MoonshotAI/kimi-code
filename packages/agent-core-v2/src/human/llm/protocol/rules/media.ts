import type {
  AudioURLPart,
  ContentPart,
  ImageURLPart,
  Message,
  ToolMessage,
  VideoURLPart,
} from '#/llm/message';

export type MediaKind = 'image' | 'video' | 'audio';

export type MediaPart = ImageURLPart | AudioURLPart | VideoURLPart;

export function isMediaPart(part: ContentPart): part is MediaPart {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

export function mediaKindOfPart(part: MediaPart): MediaKind {
  if (part.type === 'image_url') return 'image';
  if (part.type === 'video_url') return 'video';
  return 'audio';
}

export type MediaSourceKind = 'url' | 'inline' | 'file';

export interface MediaSourceInfo {
  readonly kind: MediaSourceKind;
  readonly url: string;
  readonly id?: string;
  readonly mimeType?: string;
}

function mediaUrlOfPart(part: MediaPart): { readonly url: string; readonly id?: string } {
  if (part.type === 'image_url') return part.imageUrl;
  if (part.type === 'video_url') return part.videoUrl;
  return part.audioUrl;
}

function dataUrlMime(url: string): string | undefined {
  if (!url.startsWith('data:')) return undefined;
  const end = url.indexOf(';', 5);
  return end < 0 ? undefined : url.slice(5, end);
}

export function mediaSourceOfPart(part: MediaPart): MediaSourceInfo {
  const { url, id } = mediaUrlOfPart(part);
  if (id !== undefined) return { kind: 'file', url, id };
  const mimeType = dataUrlMime(url);
  return mimeType === undefined ? { kind: 'url', url } : { kind: 'inline', url, mimeType };
}

export type MediaPosition = 'content' | 'tool_result';

export interface MediaKindSupport {
  readonly mimes: ReadonlySet<string> | 'any';
  readonly sources: readonly MediaSourceKind[];
  readonly url?: (url: string) => boolean;
  readonly inToolResult: 'native' | 'relocate' | 'unsupported';
  readonly inlineByteBudget?: number;
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

export function acceptsMime(spec: MediaKindSupport, mimeType: string | undefined): boolean {
  return spec.mimes === 'any' || (mimeType !== undefined && spec.mimes.has(mimeType));
}

export function acceptsSource(spec: MediaKindSupport, source: MediaSourceInfo): boolean {
  switch (source.kind) {
    case 'url':
      return spec.sources.includes('url') && (spec.url?.(source.url) ?? true);
    case 'inline':
    case 'file':
      return spec.sources.includes(source.kind) && acceptsMime(spec, source.mimeType);
  }
}

export type MediaPlaceholderReason = 'stripped' | 'unsupported' | 'protocol_unsupported';

const MEDIA_PLACEHOLDER_TEXT: Readonly<
  Record<MediaPlaceholderReason, Readonly<Record<MediaKind, string>>>
> = {
  stripped: {
    image: '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]',
    audio: '[audio omitted for provider compatibility; re-read the file to hear it]',
    video: '[video omitted for provider compatibility; re-read the file to view it]',
  },
  unsupported: {
    image: '[image omitted: not supported by this model]',
    audio: '[audio omitted: not supported by this model]',
    video: '[video omitted: not supported by this model]',
  },
  protocol_unsupported: {
    image: '[image omitted: not supported by this provider]',
    audio: '[audio omitted: not supported by this provider]',
    video: '[video omitted: not supported by this provider]',
  },
};

export function mediaPlaceholderText(kind: MediaKind, reason: MediaPlaceholderReason): string {
  return MEDIA_PLACEHOLDER_TEXT[reason][kind];
}

function positionOf(message: Message): MediaPosition {
  return message.role === 'tool' ? 'tool_result' : 'content';
}

function placeholderReason(
  part: MediaPart,
  position: MediaPosition,
  support: MediaSupport,
): MediaPlaceholderReason | undefined {
  const kind = mediaKindOfPart(part);
  const spec = mediaSupportAt(support, kind, position);
  if (spec === undefined) return 'protocol_unsupported';
  return acceptsSource(spec, mediaSourceOfPart(part)) ? undefined : 'stripped';
}

export function legalizeMedia(
  messages: readonly Message[],
  support: MediaSupport,
): readonly Message[] {
  let changed = false;
  const out = messages.map((message) => {
    const position = positionOf(message);
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (!isMediaPart(part)) return part;
      const reason = placeholderReason(part, position, support);
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

const RELOCATED_MEDIA_TEXT = '(see attached media)';
const RELOCATED_MEDIA_PROMPT = 'Attached media from tool result:';

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
