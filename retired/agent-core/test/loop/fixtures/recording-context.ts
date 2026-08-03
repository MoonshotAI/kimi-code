import type { Message } from '@moonshot-ai/kosong';

import type {
  LoopContentPartEvent,
  LoopMessageBuilder,
  LoopRecordedEvent,
  LoopStepBeginEvent,
  LoopStepEndEvent,
  LoopToolCallEvent,
  LoopToolResultEvent,
} from '../../../src/loop/index';

export type AppendCall =
  | { kind: 'appendStepBegin'; input: LoopStepBeginEvent }
  | { kind: 'appendStepEnd'; input: LoopStepEndEvent }
  | { kind: 'appendContentPart'; input: LoopContentPartEvent }
  | { kind: 'appendToolCall'; input: LoopToolCallEvent }
  | { kind: 'appendToolResult'; input: LoopToolResultEvent };

export interface RecordingContextOptions {
  readonly messages?: Message[] | undefined;
}

/**
 * Test helper that exposes `buildMessages` and `appendTranscriptRecord` methods
 * matching the loop's function-shaped input fields.
 */
export class RecordingContext {
  readonly calls: AppendCall[] = [];
  readonly buildMessagesCalls: number[] = [];

  private _messages: Message[];

  constructor(opts: RecordingContextOptions = {}) {
    this._messages = opts.messages ?? [];
  }

  readonly buildMessages: LoopMessageBuilder = () => {
    this.buildMessagesCalls.push(this.calls.length);
    return this._messages;
  };

  setPromptMessages(messages: Message[]): void {
    this._messages = messages;
  }

  readonly appendTranscriptRecord = async (record: LoopRecordedEvent): Promise<void> => {
    switch (record.type) {
      case 'step.begin': {
        this.calls.push({ kind: 'appendStepBegin', input: record });
        return;
      }
      case 'step.end': {
        this.calls.push({ kind: 'appendStepEnd', input: record });
        return;
      }
      case 'content.part': {
        this.calls.push({ kind: 'appendContentPart', input: record });
        return;
      }
      case 'tool.call': {
        this.calls.push({ kind: 'appendToolCall', input: record });
        return;
      }
      case 'tool.result':
        this.calls.push({ kind: 'appendToolResult', input: record });
    }
  };

  // Convenience filters

  kinds(): AppendCall['kind'][] {
    return this.calls.map((c) => c.kind);
  }

  ofKind<K extends AppendCall['kind']>(kind: K): Extract<AppendCall, { kind: K }>[] {
    return this.calls.filter((c): c is Extract<AppendCall, { kind: K }> => c.kind === kind);
  }

  stepBegins(): LoopStepBeginEvent[] {
    return this.ofKind('appendStepBegin').map((c) => c.input);
  }

  stepEnds(): LoopStepEndEvent[] {
    return this.ofKind('appendStepEnd').map((c) => c.input);
  }

  contentParts(): LoopContentPartEvent[] {
    return this.ofKind('appendContentPart').map((c) => c.input);
  }

  toolCalls(): LoopToolCallEvent[] {
    return this.ofKind('appendToolCall').map((c) => c.input);
  }

  toolResults(): LoopToolResultEvent[] {
    return this.ofKind('appendToolResult').map((c) => c.input);
  }
}
