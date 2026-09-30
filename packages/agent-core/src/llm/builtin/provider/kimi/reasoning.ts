import type { OpenAINativeMessage } from '#/llm/builtin/protocol/openai/index';
import type { ContentPart, Message, ThinkPart } from '#/llm/message';
import type { DecodeSink } from '#/llm/protocol/protocol';

const REASONING_DETAILS_KEY = 'reasoning_details';
const REASONING_CONTENT_KEY = 'reasoning_content';

interface DetailsElement {
  readonly type?: string;
  readonly index: number;
  readonly summary?: string;
  readonly encrypted?: string;
}

interface DetailsSegment {
  summary: string;
  encrypted?: string;
}

function detailsElementOf(value: unknown, position: number): DetailsElement | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : undefined;
  if (type !== undefined && type !== 'summary' && type !== 'encrypted') return undefined;
  return {
    type,
    index: typeof record['index'] === 'number' ? record['index'] : position,
    summary: typeof record['summary'] === 'string' ? record['summary'] : undefined,
    encrypted: typeof record['encrypted'] === 'string' ? record['encrypted'] : undefined,
  };
}

export function hasReasoningContent(source: unknown): boolean {
  return (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as Record<string, unknown>)[REASONING_CONTENT_KEY] === 'string'
  );
}

export function decodeReasoningDetails(source: unknown, sink: DecodeSink, hideSummary: boolean): void {
  if (typeof source !== 'object' || source === null) return;
  const value = (source as Record<string, unknown>)[REASONING_DETAILS_KEY];
  if (!Array.isArray(value)) return;
  for (const [position, item] of value.entries()) {
    const element = detailsElementOf(item, position);
    if (element === undefined) continue;
    if (element.type !== 'encrypted' && element.summary !== undefined && element.summary.length > 0) {
      sink.onDelta({
        type: 'think',
        think: element.summary,
        detailsIndex: element.index,
        hidden: hideSummary ? true : undefined,
        reasoningKey: REASONING_DETAILS_KEY,
      });
    }
    if (element.type !== 'summary' && element.encrypted !== undefined && element.encrypted.length > 0) {
      sink.onDelta({
        type: 'think',
        think: '',
        encrypted: element.encrypted,
        detailsIndex: element.index,
        reasoningKey: REASONING_DETAILS_KEY,
      });
    }
  }
}

function isDetailsPart(part: ContentPart): part is ThinkPart & { readonly detailsIndex: number } {
  return part.type === 'think' && part.detailsIndex !== undefined;
}

function encodeReasoningDetails(message: Message): Record<string, unknown>[] {
  const segments = new Map<number, DetailsSegment>();
  for (const part of message.content) {
    if (!isDetailsPart(part)) continue;
    const segment = segments.get(part.detailsIndex) ?? { summary: '' };
    segment.summary += part.think;
    segment.encrypted = part.encrypted ?? segment.encrypted;
    segments.set(part.detailsIndex, segment);
  }
  return [...segments]
    .sort(([left], [right]) => left - right)
    .flatMap(([, segment]) => [
      ...(segment.summary.length > 0 ? [{ type: 'summary', summary: segment.summary }] : []),
      ...(segment.encrypted === undefined ? [] : [{ type: 'encrypted', encrypted: segment.encrypted }]),
    ]);
}

function visibleThinking(message: Message): string {
  return message.content
    .map((part) => (part.type === 'think' && part.hidden !== true ? part.think : ''))
    .join('');
}

export function withReasoningDetails(message: Message, native: OpenAINativeMessage): OpenAINativeMessage {
  const details = encodeReasoningDetails(message);
  if (details.length === 0) return native;
  return {
    ...native,
    [REASONING_DETAILS_KEY]: details,
    [REASONING_CONTENT_KEY]: native[REASONING_CONTENT_KEY] ?? visibleThinking(message),
  };
}
