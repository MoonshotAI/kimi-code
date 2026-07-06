/**
 * `messageLegacy` domain — `IMessageLegacyService` implementation.
 *
 * Stateless App-scope dispatcher: each call resolves the target session (and
 * its main agent), sources the transcript, and projects it into the v1 wire
 * shape. Both live and cold sessions are read from the main agent's
 * `IAgentContextMemoryService`: live sessions already hold the folded history in
 * memory, and cold sessions are resumed (restoring the main agent's wire log and
 * replaying it into the `ContextModel`) before the read, so the same `get()`
 * yields the full transcript. Pagination, id derivation, and the role filter
 * mirror v1's `MessageService`
 * (`packages/agent-core/src/services/message/messageService.ts`).
 */

import type { Message, PageResponse } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ensureMainAgent } from '#/session/agentLifecycle';
import {
  IAgentContextMemoryService,
  toProtocolMessage,
} from '#/agent/contextMemory';
import { ErrorCodes, KimiError } from '#/errors';
import { ISessionIndex } from '#/app/sessionIndex';
import { ISessionLifecycleService } from '#/app/sessionLifecycle';

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
    // v1 / SCHEMAS §1.3: newest first (`created_at desc`).
    const desc = [...all].reverse();

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.after_id);
    }

    let slice: Message[];
    if (query.before_id !== undefined && pivotIndex >= 0) {
      // before_id = older entries → tail of the desc array, exclusive of pivot.
      slice = desc.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      // after_id = newer entries → head of the desc array, exclusive of pivot.
      slice = desc.slice(0, pivotIndex);
    } else {
      // Unknown cursor → fall through to the full list, matching v1.
      slice = desc;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const page = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    // Role filter is applied AFTER pagination, matching v1.
    const filtered = query.role !== undefined ? page.filter((m) => m.role === query.role) : page;

    return { items: filtered, has_more: hasMore };
  }

  async get(sessionId: string, messageId: string): Promise<Message> {
    // Resolve the session first: an unknown sid maps to 40401 even when the
    // message id is malformed or belongs to another session (40403).
    const all = await this.loadMessages(sessionId);
    const entry = all.find((m) => m.id === messageId);
    if (entry === undefined) {
      throw new KimiError(
        ErrorCodes.MESSAGE_NOT_FOUND,
        `message ${messageId} does not exist in session ${sessionId}`,
      );
    }
    return entry;
  }

  /**
   * Full main-agent transcript projected into the v1 `Message` wire shape,
   * oldest-first. Throws `session.not_found` (→ 40401) when the session is
   * unknown. An unreachable cold session (workspace gone) yields an empty
   * transcript rather than an error.
   */
  private async loadMessages(sessionId: string): Promise<Message[]> {
    const summary = await this.index.get(sessionId);
    if (summary === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }

    const agent = await this.resolveMainAgent(sessionId);
    if (agent === undefined) return [];

    // The transcript is the main agent's `ContextModel`: live sessions already
    // hold it in memory, and cold sessions have been resumed (wire log restored
    // + replayed into the Model) by `resolveMainAgent` before we get here, so a
    // single `get()` covers both. The legacy replay read model
    // (`IAgentRecordService.buildReplay`) is empty on every path and is gone.
    const source = agent.accessor.get(IAgentContextMemoryService).get();

    return source.map((msg, index) => toProtocolMessage(sessionId, index, msg, summary.createdAt));
  }

  /**
   * Resolve the session's main agent, loading + restoring it from the persisted
   * wire log when the session is cold (delegated to `ISessionLifecycleService.resume`).
   * Returns `undefined` only when a cold session's workspace is gone and the
   * session directory cannot be reconstructed (mirrors the `fork` limitation).
   */
  private async resolveMainAgent(sessionId: string): Promise<IAgentScopeHandle | undefined> {
    const session = await this.lifecycle.resume(sessionId);
    if (session === undefined) return undefined;
    // Live session whose main agent has not been materialized yet: create it
    // fresh. No restore here — the session was already live, so any persisted
    // wire is already reflected in memory; re-restoring would re-apply splices.
    return ensureMainAgent(session);
  }
}

registerScopedService(
  LifecycleScope.App,
  IMessageLegacyService,
  MessageLegacyService,
  InstantiationType.Delayed,
  'messageLegacy',
);
