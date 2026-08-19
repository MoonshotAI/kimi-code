/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';
import type { ToolUpdate } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export interface ToolCallStartedPayload {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly description?: string;
  readonly display?: ToolInputDisplay;
}

export class ToolCallStarted extends Event2<ToolCallStartedPayload> {
  static override readonly type = 'tool.call.started';
  static override readonly observable = true;
}
export interface ToolCallStarted extends ToolCallStartedPayload {}

export interface ToolProgressPayload {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly update: ToolUpdate;
}

export class ToolProgress extends Event2<ToolProgressPayload> {
  static override readonly type = 'tool.progress';
  static override readonly observable = true;
}
export interface ToolProgress extends ToolProgressPayload {}

export interface ToolResultEventPayload {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly output: unknown;
  readonly isError?: boolean;
  readonly synthetic?: boolean;
}

export class ToolResultEvent extends Event2<ToolResultEventPayload> {
  static override readonly type = 'tool.result';
  static override readonly observable = true;
}
export interface ToolResultEvent extends ToolResultEventPayload {}
