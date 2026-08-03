import type { Message } from '@moonshot-ai/kosong';

export function renderMessagesToText(messages: readonly Message[]): string {
  return messages.map((message, index) => renderMessageToText(message, index)).join('\n\n');
}

function renderMessageToText(message: Message, index: number): string {
  const header = [`message ${String(index + 1)}`, `role=${message.role}`];
  if (message.name !== undefined) {
    header.push(`name=${JSON.stringify(message.name)}`);
  }
  if (message.toolCallId !== undefined) {
    header.push(`toolCallId=${JSON.stringify(message.toolCallId)}`);
  }
  if (message.partial === true) {
    header.push('partial=true');
  }

  const lines = [`--- ${header.join(' ')} ---`];
  if (message.content.length === 0) {
    lines.push('[empty content]');
  } else {
    lines.push(...message.content.map(renderContentPartToText));
  }

  if (message.toolCalls.length > 0) {
    lines.push('tool calls:');
    for (const toolCall of message.toolCalls) {
      lines.push(renderToolCallToText(toolCall));
    }
  }

  return lines.join('\n');
}

function renderContentPartToText(part: Message['content'][number]): string {
  switch (part.type) {
    case 'text':
      return renderBlock('text', part.text);
    case 'think':
      return renderBlock('think', part.think);
    case 'image_url':
      return renderMediaPart('image_url', part.imageUrl.url, part.imageUrl.id);
    case 'audio_url':
      return renderMediaPart('audio_url', part.audioUrl.url, part.audioUrl.id);
    case 'video_url':
      return renderMediaPart('video_url', part.videoUrl.url, part.videoUrl.id);
    default:
      return renderBlock('content', stringifyJsonish(part));
  }
}

function renderToolCallToText(toolCall: Message['toolCalls'][number]): string {
  const lines = [
    `- ${toolCall.id}: ${toolCall.name}`,
    renderBlock('arguments', renderToolCallArguments(toolCall.arguments)),
  ];

  if (toolCall.extras !== undefined) {
    lines.push(renderBlock('extras', stringifyJsonish(toolCall.extras)));
  }

  return lines.join('\n');
}

function renderToolCallArguments(args: string | null): string {
  if (args === null) return 'null';

  try {
    return stringifyJsonish(JSON.parse(args));
  } catch {
    return args;
  }
}

function renderMediaPart(type: string, url: string, id?: string | undefined): string {
  if (id === undefined) return `${type}: ${url}`;
  return `${type}: ${url} (id=${id})`;
}

function renderBlock(label: string, value: string): string {
  return `${label}:\n${indentBlock(value)}`;
}

function indentBlock(value: string): string {
  if (value.length === 0) return '  ';
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function stringifyJsonish(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, nested: unknown): unknown => {
    if (typeof nested === 'bigint') return `${nested.toString()}n`;
    if (typeof nested === 'function') return `[Function ${nested.name || 'anonymous'}]`;
    if (typeof nested === 'symbol') return nested.toString();
    if (nested !== null && typeof nested === 'object') {
      if (seen.has(nested)) return '[Circular]';
      seen.add(nested);
    }
    return nested;
  };

  try {
    return JSON.stringify(value, replacer, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
