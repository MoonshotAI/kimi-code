/**
 * `messageLegacy` domain (L7 edge adapter) — v1-compatible message history.
 *
 * Implements the legacy `GET /api/v1/sessions/{sid}/messages[/{mid}]`
 * contract on top of the native v2 services.
 *
 * The native `IAgentContextMemoryService` (Agent scope) holds the model's
 * CURRENT, folded context and is NOT the full transcript: after a compaction
 * it collapses into `[...keptUserMessages, compaction_summary]`. The full
 * transcript is reduced on demand by streaming the main agent's `wire.jsonl`;
 * the service does not make every live Agent retain its raw journal in
 * memory. Bound at App scope — a stateless dispatcher that resolves the
 * target session/agent per call.
 *
 * Error contract (mapped at the route layer):
 *   - `session.not_found`  → 40401
 *   - `message.not_found`  → 40403
 */

import type { Message, MessageRole } from '#/agent/contextMemory/protocolMessage';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface CursorQuery {
  before_id?: string | undefined;
  after_id?: string | undefined;
  page_size?: number | undefined;
}

export interface PageResponse<T> {
  items: T[];
  has_more: boolean;
}

export interface MessageListQuery extends CursorQuery {
  readonly role?: MessageRole;
}

export interface IMessageLegacyService {
  readonly _serviceBrand: undefined;

  list(sessionId: string, query: MessageListQuery): Promise<PageResponse<Message>>;
  get(sessionId: string, messageId: string): Promise<Message>;
}

export const IMessageLegacyService: ServiceIdentifier<IMessageLegacyService> =
  createDecorator<IMessageLegacyService>('messageLegacyService');
