/**
 * Benchmark for the context projection rewrite (two-pass -> single-pass with
 * slot backfill, and O(k²) -> O(k) adjacent user-prompt merging).
 *
 * `projectLegacy` below is the previous implementation, copied verbatim so the
 * comparison stays runnable after the old code is gone. The "new" side goes
 * through the real `AgentContextProjectorService`, so it measures exactly the
 * projection path.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 exec vitest bench test/contextProjector/projector.bench.ts
 */

import { bench, describe } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService, type ILogger } from '#/_base/log/log';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { AgentContextProjectorService } from '#/agent/contextProjector/contextProjectorService';
import { ErrorCodes, Error2 } from '#/errors';
import type { ContentPart, Message, TextPart, ToolCall } from '#/kosong/contract/message';

const noopLogger: ILogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLogger,
};
const noopLogService: ILogService = {
  ...noopLogger,
  _serviceBrand: undefined,
  level: 'off',
  setLevel: () => {},
  flush: () => Promise.resolve(),
};


function projectLegacy(history: readonly ContextMessage[]): Message[] {
  const openCalls = new Map<string, ToolCall>();
  const answers = new Map<ToolCall, ContextMessage>();
  let hasAssistant = false;
  for (const message of history) {
    if (message.partial === true) continue;
    if (message.role === 'assistant') {
      hasAssistant = true;
      for (const call of message.toolCalls) openCalls.set(call.id, call);
    } else if (message.role === 'tool' && message.toolCallId !== undefined) {
      const call = openCalls.get(message.toolCallId);
      if (call === undefined) continue;
      answers.set(call, message);
      openCalls.delete(message.toolCallId);
    }
  }

  const out: Message[] = [];
  let mergeSource: ContextMessage | undefined;

  const emit = (source: ContextMessage): void => {
    const content = source.content.some(isBlankText)
      ? source.content.filter((part) => !isBlankText(part))
      : source.content;
    if (source.role === 'tool' && content.length === 0) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Tool result message content cannot be empty after removing empty text blocks.',
        { details: { toolCallId: source.toolCallId } },
      );
    }
    if (content.length === 0 && source.toolCalls.length === 0) return;

    const message = content === source.content ? source : { ...source, content };
    if (mergeSource !== undefined && canMergeUserMessage(message)) {
      mergeSource = mergeTwoUserMessages(mergeSource, message);
      out[out.length - 1] = stripContextMetadata(mergeSource);
      return;
    }
    mergeSource = canMergeUserMessage(message) ? message : undefined;
    out.push(stripContextMetadata(message));
  };

  for (const message of history) {
    if (message.partial === true) continue;
    if (message.role === 'tool') {
      if (!hasAssistant) emit(message);
      continue;
    }
    emit(message);
    for (const call of message.toolCalls) {
      emit(answers.get(call) ?? createInterruptedToolResult(call.id));
    }
  }
  return out;
}

const TOOL_INTERRUPTED_TEXT =
  '<system>ERROR: Tool execution failed.</system>\n' +
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

function createInterruptedToolResult(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: TOOL_INTERRUPTED_TEXT }],
    toolCalls: [],
    toolCallId,
    isError: true,
  };
}

function isBlankText(part: ContentPart): boolean {
  return part.type === 'text' && part.text.trim().length === 0;
}

function canMergeUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

function mergeTwoUserMessages(a: ContextMessage, b: ContextMessage): ContextMessage {
  const text = [a, b].map(extractText).filter((t) => t.length > 0).join('\n\n');
  const content: ContentPart[] = text === '' ? [] : [{ type: 'text', text }];
  content.push(
    ...a.content.filter((part) => part.type !== 'text'),
    ...b.content.filter((part) => part.type !== 'text'),
  );
  return { role: 'user', content, toolCalls: [], origin: a.origin };
}

function extractText(message: ContextMessage): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function stripContextMetadata(message: ContextMessage): Message {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map((part) => ({ ...part })) as ContentPart[],
    toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}


function makeExchangeHistory(exchanges: number, callsPerStep: number): ContextMessage[] {
  const history: ContextMessage[] = [];
  for (let i = 0; i < exchanges; i++) {
    history.push({
      role: 'user',
      content: [{ type: 'text', text: `reminder ${i}` }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'host' },
    });
    const ids = Array.from({ length: callsPerStep }, (_, j) => `c${i}_${j}`);
    history.push({
      role: 'assistant',
      content: [{ type: 'text', text: `step ${i}` }],
      toolCalls: ids.map((id) => ({ type: 'function', id, name: 'Lookup', arguments: '{}' })),
    });
    for (const id of ids) {
      history.push({
        role: 'tool',
        content: [{ type: 'text', text: `result for ${id} `.repeat(20) }],
        toolCalls: [],
        toolCallId: id,
      });
    }
  }
  return history;
}

function makeMergeHistory(count: number, textSize: number): ContextMessage[] {
  const text = 'x'.repeat(textSize);
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `${i} ${text}` }],
    toolCalls: [],
    origin: { kind: 'user' as const },
  }));
}

function makeMixedHistory(turns: number): ContextMessage[] {
  const history: ContextMessage[] = [];
  for (let i = 0; i < turns; i++) {
    history.push(...makeMergeHistory(3, 200).map((m) => ({ ...m })));
    history.push(...makeExchangeHistory(4, 2));
  }
  return history;
}

function createProjector(disposables: DisposableStore): IAgentContextProjectorService {
  const ix = disposables.add(new TestInstantiationService());
  ix.set(ILogService, noopLogService);
  ix.set(IAgentContextProjectorService, new SyncDescriptor(AgentContextProjectorService));
  return ix.get(IAgentContextProjectorService);
}


const disposables = new DisposableStore();
const projector = createProjector(disposables);

const TYPICAL = makeMixedHistory(4);
const EXCHANGE_HEAVY = makeExchangeHistory(1000, 4);
const MERGE_HEAVY = makeMergeHistory(2000, 500);

const OPTIONS = { warmupTime: 500, time: 3000 };

describe(`typical mid-session history (${TYPICAL.length} messages)`, () => {
  bench('legacy (two-pass)', () => {
    projectLegacy(TYPICAL);
  }, OPTIONS);
  bench('current (single-pass)', () => {
    projector.project(TYPICAL);
  }, OPTIONS);
});

describe(`tool-exchange heavy history (${EXCHANGE_HEAVY.length} messages)`, () => {
  bench('legacy (two-pass)', () => {
    projectLegacy(EXCHANGE_HEAVY);
  }, OPTIONS);
  bench('current (single-pass)', () => {
    projector.project(EXCHANGE_HEAVY);
  }, OPTIONS);
});

describe(`adjacent user-prompt merging (${MERGE_HEAVY.length} messages x 500 chars)`, () => {
  bench('legacy (O(k²) re-merge)', () => {
    projectLegacy(MERGE_HEAVY);
  }, OPTIONS);
  bench('current (O(k) accumulation)', () => {
    projector.project(MERGE_HEAVY);
  }, OPTIONS);
});
