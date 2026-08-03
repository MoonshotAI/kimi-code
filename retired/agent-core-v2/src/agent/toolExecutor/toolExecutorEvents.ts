/**
 * `toolExecutor` domain — the `tool.call.*` / `tool.progress` / `tool.result`
 * event payloads published through `IEventBus` as tool calls execute.
 */

import type { ToolUpdate } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export interface ToolCallStartedEvent {
  readonly type: 'tool.call.started';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly description?: string;
  readonly display?: ToolInputDisplay;
}

export interface ToolProgressEvent {
  readonly type: 'tool.progress';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly update: ToolUpdate;
}

export interface ToolResultEvent {
  readonly type: 'tool.result';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly output: unknown;
  readonly isError?: boolean;
  readonly synthetic?: boolean;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'tool.call.started': ToolCallStartedEvent;
    'tool.result': ToolResultEvent;
    'tool.progress': ToolProgressEvent;
  }
}
