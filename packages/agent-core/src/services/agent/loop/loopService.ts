import { createToolMessage, type ContentPart } from '@moonshot-ai/kosong';

import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';
import type { ExecutableToolResult, LoopRecordedEvent } from '../../../loop';
import { IContextMemory } from '../contextMemory/contextMemory';
import type { ContextMessage } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import { ILoopService } from './loop';

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';
const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

export class LoopService extends Disposable implements ILoopService {
  private readonly openSteps = new Map<string, OpenStep>();
  private ownSpliceDepth = 0;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IWireRecord private readonly wireRecord: IWireRecord,
  ) {
    super();
    this.context.hooks.onSpliced.register('loop-service-reconcile', async (_event, next) => {
      if (this.ownSpliceDepth === 0) {
        this.resetLiveStateFromHistory();
      }
      await next();
    });
    this.wireRecord.hooks.onResumeEnded.register(
      'loop-service-finish-resume',
      async (_event, next) => {
        this.finishResume();
        await next();
      },
    );
  }

  handleEvent(event: LoopRecordedEvent): void {
    switch (event.type) {
      case 'step.begin': {
        const message: ContextMessage = {
          role: 'assistant',
          content: [],
          toolCalls: [],
        };
        this.openSteps.set(event.uuid, { message, inserted: false });
        return;
      }
      case 'step.end':
        this.openSteps.delete(event.uuid);
        return;
      case 'content.part':
        this.replaceOpenStep(event.stepUuid, (message) => ({
          ...message,
          content: [...message.content, cloneContentPart(event.part)],
        }));
        return;
      case 'tool.call':
        this.replaceOpenStep(event.stepUuid, (message) => ({
          ...message,
          toolCalls: [
            ...message.toolCalls,
            {
              type: 'function',
              id: event.toolCallId,
              name: event.name,
              arguments: stringifyToolArguments(event.args),
            },
          ],
        }));
        return;
      case 'tool.result':
        this.appendToolResult(event.toolCallId, event.result);
        return;
    }
  }

  private finishResume(): void {
    const interruptedToolCallIds = unresolvedToolCallIdsFromHistory(this.context.getHistory());
    this.openSteps.clear();
    for (const toolCallId of interruptedToolCallIds) {
      this.handleEvent({
        type: 'tool.result',
        parentUuid: toolCallId,
        toolCallId,
        result: {
          output: TOOL_INTERRUPTED_ON_RESUME_OUTPUT,
          isError: true,
        },
      });
    }
  }

  private replaceOpenStep(
    stepUuid: string,
    update: (message: ContextMessage) => ContextMessage,
  ): void {
    const message = this.openSteps.get(stepUuid);
    if (message === undefined) {
      throw new Error(
        `Received loop event for unknown step_uuid '${stepUuid}' (no open step_begin)`,
      );
    }

    const next = update(message.message);
    if (!message.inserted) {
      this.appendImmediately(next);
      this.openSteps.set(stepUuid, { message: next, inserted: true });
      return;
    }

    const history = this.context.getHistory();
    const index = history.indexOf(message.message);
    if (index < 0) {
      throw new Error(`Open loop step '${stepUuid}' is no longer present in context history`);
    }
    this.spliceHistory(index, 1, next);
    this.openSteps.set(stepUuid, { message: next, inserted: true });
  }

  private appendToolResult(toolCallId: string, result: ExecutableToolResult): void {
    const message = createToolMessage(toolCallId, toolResultOutputForModel(result));
    this.appendImmediately({
      ...message,
      role: 'tool',
      isError: result.isError,
    });
  }

  private appendImmediately(...messages: ContextMessage[]): void {
    if (messages.length === 0) return;
    this.spliceHistory(this.context.getHistory().length, 0, ...messages);
  }

  private spliceHistory(
    start: number,
    deleteCount: number,
    ...messages: ContextMessage[]
  ): void {
    this.ownSpliceDepth++;
    try {
      this.context.spliceHistory(start, deleteCount, ...messages);
    } finally {
      this.ownSpliceDepth--;
    }
  }

  private resetLiveStateFromHistory(): void {
    this.openSteps.clear();
  }
}

interface OpenStep {
  readonly message: ContextMessage;
  readonly inserted: boolean;
}

function unresolvedToolCallIdsFromHistory(history: readonly ContextMessage[]): string[] {
  const answered = new Set<string>();
  for (const message of history) {
    if (message.role === 'tool' && message.toolCallId !== undefined) {
      answered.add(message.toolCallId);
    }
  }

  const unresolved: string[] = [];
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    for (const toolCall of message.toolCalls) {
      if (!answered.has(toolCall.id)) {
        unresolved.push(toolCall.id);
      }
    }
  }
  return unresolved;
}

function stringifyToolArguments(args: unknown): string | null {
  if (args === undefined) return null;
  return JSON.stringify(args) ?? null;
}

function toolResultOutputForModel(result: ExecutableToolResult): string | ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    if (result.isError === true) {
      if (output.length === 0) return TOOL_EMPTY_ERROR_STATUS;
      if (output.trimStart().startsWith('<system>ERROR:')) return output;
      return `${TOOL_ERROR_STATUS}\n${output}`;
    }
    return isEmptyOutputText(output) ? TOOL_EMPTY_STATUS : output;
  }

  if (output.length === 0) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) {
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...output.map(cloneContentPart)];
  }
  return output.map(cloneContentPart);
}

function isEmptyOutputText(output: string): boolean {
  return output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}

function cloneContentPart<T extends ContentPart>(part: T): T {
  return { ...part } as T;
}

registerSingleton(ILoopService, new SyncDescriptor(LoopService, [], true));
