/**
 * `messageLegacy` domain — `IMessageLegacyService` implementation.
 *
 * Stateless App-scope dispatcher: each call resolves the target session (and
 * its main agent), sources the transcript, and projects it into the v1 wire
 * shape.
 *
 * History source is the main agent's in-memory record journal
 * (`IAgentWireRecordService.getRecords()`), seeded from `wire.jsonl` by
 * `ISessionLifecycleService.resume` and then kept current as live dispatch
 * appends each record — so a transcript read never re-reads the file. The
 * journal is reduced by `reduceContextTranscript` (the same reducer v1's
 * `MessageService` uses), which keeps the full history across compactions
 * (inserting a summary marker instead of folding) — unlike the live
 * `IAgentContextMemoryService.get()`, whose folded context collapses into
 * `[...keptUserMessages, compaction_summary]` and would lose the prefix.
 * `foldedLength` is what the live history length WOULD be from the journal's
 * records; because the journal can trail the live context by a record within a
 * single dispatch, anything beyond it is appended as the unflushed tail.
 * Pagination, id derivation, and the role filter mirror v1's `MessageService`
 * (`packages/agent-core/src/services/message/messageService.ts`).
 */

import type { Message, PageResponse } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  reduceContextTranscript,
  type ContextTranscript,
} from '#/agent/contextMemory/contextTranscript';
import { toProtocolMessage } from '#/agent/contextMemory/messageProjection';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { ErrorCodes, Error2 } from '#/errors';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import type { PersistedRecord } from '#/wire/wireService';

import { IMessageLegacyService, type MessageListQuery } from './messageLegacy';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export class MessageLegacyService implements IMessageLegacyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionLifecycleService private readonly lifecycle: ISessionLifecycleService,
    @ISessionIndex private readonly index: ISessionIndex,
  ) {}

  async list(sessionId: string, query: MessageListQuery): Promise<PageResponse<Message>> {
    const all = await this.loadMessages(sessionId);
    const desc = [...all].reverse();

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.after_id);
    }

    let slice: Message[];
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = desc.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = desc.slice(0, pivotIndex);
    } else {
      slice = desc;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const page = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    const filtered = query.role !== undefined ? page.filter((m) => m.role === query.role) : page;

    return { items: filtered, has_more: hasMore };
  }

  async get(sessionId: string, messageId: string): Promise<Message> {
    const all = await this.loadMessages(sessionId);
    const entry = all.find((m) => m.id === messageId);
    if (entry === undefined) {
      throw new Error2(
        ErrorCodes.MESSAGE_NOT_FOUND,
        `message ${messageId} does not exist in session ${sessionId}`,
      );
    }
    return entry;
  }

  private async loadMessages(sessionId: string): Promise<Message[]> {
    const summary = await this.index.get(sessionId);
    if (summary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }

    const session = await this.lifecycle.resume(sessionId);
    if (session === undefined) return [];
    const agent = await ensureMainAgent(session);

    const transcript = this.readTranscript(agent);
    const contextMessages = agent.accessor.get(IAgentContextMemoryService).get();
    const entries = mergeLiveTail(transcript, contextMessages);

    return entries.map((msg, index) => toProtocolMessage(sessionId, index, msg, summary.createdAt));
  }

  private readTranscript(agent: IAgentScopeHandle): ContextTranscript {
    const records = agent
      .accessor.get(IAgentWireRecordService)
      .getRecords() as readonly PersistedRecord[];
    return reduceContextTranscript(records);
  }
}

function mergeLiveTail(
  transcript: ContextTranscript,
  contextMessages: readonly ContextMessage[],
): readonly ContextMessage[] {
  if (contextMessages.length <= transcript.foldedLength) return transcript.entries;
  return [...transcript.entries, ...contextMessages.slice(transcript.foldedLength)];
}

registerScopedService(
  LifecycleScope.App,
  IMessageLegacyService,
  MessageLegacyService,
  InstantiationType.Delayed,
  'messageLegacy',
);
