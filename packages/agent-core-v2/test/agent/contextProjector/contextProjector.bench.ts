import { bench, describe } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService, type ILogger } from '#/_base/log/log';
import {
  isAssistantEntry,
  isSystemEntry,
  isToolEntry,
  isUserEntry,
  type HistoryMessage,
  type ToolEntry,
  type UserEntry,
} from '#human/agent/turn';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { AgentContextProjectorService } from '#/agent/contextProjector/contextProjectorService';
import { ErrorCodes, Error2 } from '#/errors';
import type { ContentPart, Message, TextPart, ToolCall } from '#human/llm/message';

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

function projectLegacy(history: readonly HistoryMessage[]): Message[] {
  const openCalls = new Map<string, ToolCall>();
  const answers = new Map<ToolCall, ToolEntry>();
  let hasAssistant = false;
  for (const entry of history) {
    if (isAssistantEntry(entry) && entry.meta?.partial === true) continue;
    if (isAssistantEntry(entry)) {
      hasAssistant = true;
      for (const call of entry.message.toolCalls) openCalls.set(call.id, call);
    } else if (isToolEntry(entry)) {
      const call = openCalls.get(entry.message.toolCallId);
      if (call === undefined) continue;
      answers.set(call, entry);
      openCalls.delete(entry.message.toolCallId);
    }
  }

  const out: Message[] = [];
  let mergeSource: UserEntry | undefined;

  const emit = (source: HistoryMessage): void => {
    const content = source.message.content.some(isBlankText)
      ? source.message.content.filter((part) => !isBlankText(part))
      : source.message.content;
    if (source.message.role === 'tool' && content.length === 0) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Tool result message content cannot be empty after removing empty text blocks.',
        { details: { toolCallId: source.message.toolCallId } },
      );
    }
    if (content.length === 0 && (source.message.role !== 'assistant' || source.message.toolCalls.length === 0)) return;

    const message = content === source.message.content ? source : withEntryContent(source, content);
    if (mergeSource !== undefined && canMergeUserMessage(message)) {
      mergeSource = mergeTwoUserMessages(mergeSource, message);
      out[out.length - 1] = stripContextMetadata(mergeSource);
      return;
    }
    mergeSource = canMergeUserMessage(message) ? message : undefined;
    out.push(stripContextMetadata(message));
  };

  for (const entry of history) {
    if (isAssistantEntry(entry) && entry.meta?.partial === true) continue;
    if (isToolEntry(entry)) {
      if (!hasAssistant) emit(entry);
      continue;
    }
    emit(entry);
    if (!isAssistantEntry(entry)) continue;
    for (const call of entry.message.toolCalls) {
      emit(answers.get(call) ?? createInterruptedToolResult(call.id));
    }
  }
  return out;
}

const TOOL_INTERRUPTED_TEXT =
  '<system>ERROR: Tool execution failed.</system>\n' +
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

function createInterruptedToolResult(toolCallId: string): ToolEntry {
  return {
    message: {
      role: 'tool',
      content: [{ type: 'text', text: TOOL_INTERRUPTED_TEXT }],
      toolCallId,
    },
    meta: { isError: true },
  };
}

function isBlankText(part: ContentPart): boolean {
  return part.type === 'text' && part.text.trim().length === 0;
}

function withEntryContent(entry: HistoryMessage, content: ContentPart[]): HistoryMessage {
  if (isSystemEntry(entry)) return { ...entry, message: { ...entry.message, content } };
  if (isUserEntry(entry)) return { ...entry, message: { ...entry.message, content } };
  if (isAssistantEntry(entry)) return { ...entry, message: { ...entry.message, content } };
  return { ...entry, message: { ...entry.message, content } };
}

function canMergeUserMessage(entry: HistoryMessage): entry is UserEntry {
  return isUserEntry(entry) && entry.meta?.origin?.kind === 'user';
}

function mergeTwoUserMessages(a: UserEntry, b: UserEntry): UserEntry {
  const text = [a, b].map(extractText).filter((t) => t.length > 0).join('\n\n');
  const content: ContentPart[] = text === '' ? [] : [{ type: 'text', text }];
  content.push(
    ...a.message.content.filter((part) => part.type !== 'text'),
    ...b.message.content.filter((part) => part.type !== 'text'),
  );
  return { message: { role: 'user', content }, meta: { origin: a.meta?.origin } };
}

function extractText(entry: UserEntry): string {
  return entry.message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function stripContextMetadata(entry: HistoryMessage): Message {
  const content = entry.message.content.map((part) => ({ ...part })) as ContentPart[];
  switch (entry.message.role) {
    case 'system':
      return { role: 'system', content, tools: entry.message.tools };
    case 'user':
      return { role: 'user', content };
    case 'assistant':
      return {
        role: 'assistant',
        content,
        toolCalls: entry.message.toolCalls.map((toolCall) => ({ ...toolCall })),
      };
    case 'tool':
      return { role: 'tool', content, toolCallId: entry.message.toolCallId };
  }
}

function makeExchangeHistory(exchanges: number, callsPerStep: number): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (let i = 0; i < exchanges; i++) {
    history.push({
      message: {
        role: 'user',
        content: [{ type: 'text', text: `reminder ${i}` }],
      },
      meta: { origin: { kind: 'injection', variant: 'host' } },
    });
    const ids = Array.from({ length: callsPerStep }, (_, j) => `c${i}_${j}`);
    history.push({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `step ${i}` }],
        toolCalls: ids.map((id) => ({ type: 'function', id, name: 'Lookup', arguments: '{}' })),
      },
    });
    for (const id of ids) {
      history.push({
        message: {
          role: 'tool',
          content: [{ type: 'text', text: `result for ${id} `.repeat(20) }],
          toolCallId: id,
        },
      });
    }
  }
  return history;
}

function makeMergeHistory(count: number, textSize: number): HistoryMessage[] {
  const text = 'x'.repeat(textSize);
  return Array.from({ length: count }, (_, i) => ({
    message: { role: 'user' as const, content: [{ type: 'text' as const, text: `${i} ${text}` }] },
    meta: { origin: { kind: 'user' as const } },
  }));
}

function makeMixedHistory(turns: number): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (let i = 0; i < turns; i++) {
    history.push(...makeMergeHistory(3, 200).map((entry) => ({ ...entry })));
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
