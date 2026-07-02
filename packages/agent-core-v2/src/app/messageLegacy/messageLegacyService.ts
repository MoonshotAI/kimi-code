/**
 * `messageLegacy` domain — `IMessageLegacyService` implementation.
 *
 * Stateless App-scope dispatcher: each call resolves the target session (and
 * its main agent), sources the transcript, and projects it into the v1 wire
 * shape. Live sessions are read from the main agent's `IAgentContextMemoryService` (the
 * folded history already in memory); cold sessions are loaded, their main agent
 * is restored from the persisted wire log, and the FULL transcript is read from
 * `IAgentReplayBuilderService` — v2's own replay reducer, so no reduction logic is
 * duplicated here. Pagination, id derivation, and the role filter mirror v1's
 * `MessageService` (`packages/agent-core/src/services/message/messageService.ts`).
 */

import type { Message, PageResponse } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import {
  IAgentContextMemoryService,
  toProtocolMessage,
  type ContextMessage,
} from '#/agent/contextMemory';
import { ErrorCodes, KimiError } from '#/errors';
import { IAgentReplayBuilderService } from '#/agent/replayBuilder';
import { ISessionIndex } from '#/app/session-index';
import { ISessionLifecycleService } from '#/app/session-lifecycle';

import { IMessageLegacyService, type MessageListQuery } from './messageLegacy';

const MAIN_AGENT_ID = 'main';
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

    // Prefer the replay transcript: it is populated only by `wireRecord.restore`
    // (live-appended records are not captured), so a non-empty replay means the
    // agent was restored and the replay holds the full pre-compaction history.
    // Otherwise the agent is fresh (never restored) and the folded context
    // memory IS the transcript.
    const replay = agent.accessor.get(IAgentReplayBuilderService).buildResult();
    const restored: ContextMessage[] = [];
    for (const record of replay) {
      if (record.type === 'message') restored.push(record.message);
    }
    const source = restored.length > 0 ? restored : agent.accessor.get(IAgentContextMemoryService).get();

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
    const agents = session.accessor.get(IAgentLifecycleService);
    const existing = agents.getHandle(MAIN_AGENT_ID);
    if (existing !== undefined) return existing;
    // Live session whose main agent has not been materialized yet: create it
    // fresh. No restore here — the session was already live, so any persisted
    // wire is already reflected in memory; re-restoring would re-apply splices.
    return agents.createMain();
  }
}

registerScopedService(
  LifecycleScope.App,
  IMessageLegacyService,
  MessageLegacyService,
  InstantiationType.Delayed,
  'messageLegacy',
);
