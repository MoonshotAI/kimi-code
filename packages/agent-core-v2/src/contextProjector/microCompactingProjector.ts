import type { ContentPart, Message } from '@moonshot-ai/kosong';

import type { ContextMessage } from '../types';
import type { IContextProjector } from './contextProjector';

export interface MicroCompactingProjectorOptions {
  readonly keepRecentMessages?: number;
  readonly minContentLength?: number;
  readonly truncatedMarker?: string;
}

export class MicroCompactingProjector implements IContextProjector {
  private readonly keepRecentMessages: number;
  private readonly minContentLength: number;
  private readonly truncatedMarker: string;

  constructor(
    private readonly previous: IContextProjector,
    options: MicroCompactingProjectorOptions = {},
  ) {
    this.keepRecentMessages = options.keepRecentMessages ?? 20;
    this.minContentLength = options.minContentLength ?? 1000;
    this.truncatedMarker = options.truncatedMarker ?? '[Old tool result content cleared]';
  }

  project(messages: readonly ContextMessage[]): readonly Message[] {
    return microCompact(this.previous.project(messages), {
      keepRecentMessages: this.keepRecentMessages,
      minContentLength: this.minContentLength,
      truncatedMarker: this.truncatedMarker,
    });
  }
}

function microCompact(
  messages: readonly Message[],
  options: Required<MicroCompactingProjectorOptions>,
): readonly Message[] {
  const cutoff = Math.max(0, messages.length - options.keepRecentMessages);
  return messages.map((message, index) => {
    if (index >= cutoff || message.role !== 'tool' || message.toolCallId === undefined) {
      return message;
    }
    const contentLength = textLength(message.content);
    if (contentLength < options.minContentLength) {
      return message;
    }
    return {
      ...message,
      content: [{ type: 'text', text: options.truncatedMarker } satisfies ContentPart],
    };
  });
}

function textLength(content: readonly ContentPart[]): number {
  return content.reduce((sum, part) => {
    if (part.type === 'text') return sum + part.text.length;
    if (part.type === 'think') return sum + part.think.length;
    return sum;
  }, 0);
}
