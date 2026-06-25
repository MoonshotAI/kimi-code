/**
 * `records` domain (L2) — persistence and replay contracts.
 *
 * Defines the records service identifiers and the `AgentRecord` model used by
 * other domains to read and write session state, session metadata, and the
 * agent record stream. Spans Core, Session, and Agent scopes — each store lives
 * at the scope matching the data it owns.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionStore {
  readonly _serviceBrand: undefined;
  read(sessionId: string): Promise<unknown>;
  write(sessionId: string, data: unknown): Promise<void>;
}

export const ISessionStore: ServiceIdentifier<ISessionStore> =
  createDecorator<ISessionStore>('sessionStore');

export interface ISessionMetaStore {
  readonly _serviceBrand: undefined;
  read(): Promise<Record<string, unknown>>;
  write(patch: Record<string, unknown>): Promise<void>;
  flush(): Promise<void>;
}

export const ISessionMetaStore: ServiceIdentifier<ISessionMetaStore> =
  createDecorator<ISessionMetaStore>('sessionMetaStore');

export interface AgentRecord {
  readonly kind: string;
  readonly payload: unknown;
}

export interface IAgentRecords {
  readonly _serviceBrand: undefined;
  logRecord(record: AgentRecord): Promise<void>;
  replay(): AsyncIterable<AgentRecord>;
  restore(): Promise<void>;
}

export const IAgentRecords: ServiceIdentifier<IAgentRecords> =
  createDecorator<IAgentRecords>('agentRecords');
