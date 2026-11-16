import type { IEventBus } from '#/app/event/eventBus';
import {
  AssistantDelta,
  ThinkingDelta,
  TurnStepCompleted,
} from '#/agent/loop/turnEvents';
import {
  ToolCallStarted,
  ToolResultEvent,
} from '#/agent/toolExecutor/toolExecutorEvents';
import type { IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import type { ArtexBudgetUsage } from '#/features/artex/logic/budget';

export interface ArtexActivityCaptureHandle {
  flushAndDispose(finalResult?: {
    readonly isError?: boolean;
    readonly summary: string;
    readonly text?: string;
    readonly detail?: Record<string, unknown>;
  }): Promise<void>;
}

function firstLine(raw: string, maxChars: number): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  const newline = trimmed.indexOf('\n');
  const line = newline >= 0 ? trimmed.slice(0, newline) : trimmed;
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars)}…`;
}

function outputToString(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const part of output) {
      if (
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        parts.push((part as { text: string }).text);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return '';
  }
}

export function attachArtexActivityCapture(
  eventBus: IEventBus | undefined,
  agentId: string,
  store: IArtexGraphStore,
  nodeId: number | undefined,
  actor: string,
  onUsage?: (usage: ArtexBudgetUsage) => void,
): ArtexActivityCaptureHandle {
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): void => {
    queue = queue.then(fn, fn).catch(() => undefined);
  };

  if (eventBus === undefined) {
    return {
      async flushAndDispose(finalResult) {
        if (finalResult !== undefined) {
          await store
            .appendActivity({
              nodeId,
              actor,
              kind: 'result',
              isError: finalResult.isError,
              summary: firstLine(finalResult.summary, 400),
              text: finalResult.text,
              detail: finalResult.detail,
            })
            .catch(() => undefined);
        }
      },
    };
  }

  const toolNames = new Map<string, string>();
  let bufferedKind: 'text' | 'thinking' | undefined;
  let bufferedText = '';

  const flushBuffer = (): void => {
    if (bufferedKind === undefined) return;
    const text = bufferedText.trim();
    const kind = bufferedKind;
    bufferedKind = undefined;
    bufferedText = '';
    if (text.length === 0) return;
    enqueue(async () => {
      await store.appendActivity({
        nodeId,
        actor,
        kind,
        summary: firstLine(text, 200),
        text,
      });
    });
  };

  const appendDelta = (kind: 'text' | 'thinking', delta: string): void => {
    if (delta.length === 0) return;
    if (bufferedKind !== undefined && bufferedKind !== kind) {
      flushBuffer();
    }
    bufferedKind = kind;
    bufferedText += delta;
  };

  const subs = [
    eventBus.subscribe(ToolCallStarted, (event) => {
      if (event.agentId !== agentId) return;
      flushBuffer();
      toolNames.set(event.toolCallId, event.name);
      const argsText = (() => {
        try {
          return JSON.stringify(event.args);
        } catch {
          return '';
        }
      })();
      enqueue(async () => {
        await store.appendActivity({
          nodeId,
          actor,
          kind: 'tool_use',
          tool: event.name,
          summary: `${event.name} ${firstLine(argsText, 200)}`.trim(),
          text: argsText,
          detail: {
            toolCallId: event.toolCallId,
            args:
              typeof event.args === 'object' && event.args !== null
                ? (event.args as Record<string, unknown>)
                : { raw: argsText },
          },
        });
      });
    }),
    eventBus.subscribe(ToolResultEvent, (event) => {
      if (event.agentId !== agentId) return;
      flushBuffer();
      const tool = toolNames.get(event.toolCallId);
      const out = outputToString(event.output);
      enqueue(async () => {
        await store.appendActivity({
          nodeId,
          actor,
          kind: 'tool_result',
          tool,
          isError: event.isError,
          summary: firstLine(out, 200),
          text: out,
          detail: { toolCallId: event.toolCallId },
        });
      });
    }),
    eventBus.subscribe(AssistantDelta, (event) => {
      if (event.agentId !== agentId) return;
      appendDelta('text', event.delta);
    }),
    eventBus.subscribe(ThinkingDelta, (event) => {
      if (event.agentId !== agentId) return;
      appendDelta('thinking', event.delta);
    }),
    eventBus.subscribe(TurnStepCompleted, (event) => {
      if (event.agentId !== agentId) return;
      if (event.usage === undefined) return;
      const usage = event.usage;
      const inputCacheRead = usage.inputCacheRead ?? 0;
      const inputCacheCreation = usage.inputCacheCreation ?? 0;
      const inputTokens = usage.inputOther + inputCacheRead + inputCacheCreation;
      const outputTokens = usage.output;
      onUsage?.({ inputTokens, outputTokens });
      enqueue(async () => {
        await store.recordTokenUsage({
          worker: actor,
          inputTokens: usage.inputOther,
          outputTokens: usage.output,
          cacheReadTokens: inputCacheRead,
          cacheWriteTokens: inputCacheCreation,
          at: new Date().toISOString(),
        });
        await store.appendActivity({
          nodeId,
          actor,
          kind: 'usage',
          detail: {
            inputTokens,
            outputTokens,
            cacheReadTokens: inputCacheRead,
            cacheWriteTokens: inputCacheCreation,
          },
        });
      });
    }),
  ];

  let disposed = false;
  return {
    async flushAndDispose(finalResult) {
      if (disposed) return;
      disposed = true;
      for (const sub of subs) sub.dispose();
      flushBuffer();
      if (finalResult !== undefined) {
        enqueue(async () => {
          await store.appendActivity({
            nodeId,
            actor,
            kind: 'result',
            isError: finalResult.isError,
            summary: firstLine(finalResult.summary, 400),
            text: finalResult.text,
            detail: finalResult.detail,
          });
        });
      }
      await queue;
    },
  };
}
