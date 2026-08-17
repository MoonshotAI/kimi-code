/**
 * `sessionMetadata` domain — typed session metadata.
 *
 * Defines the `SessionMeta` model and the `ISessionMetadata` used by upper
 * layers to read and update the session's durable metadata (title, timestamps,
 * archived flag and the archive moment `archivedAt` — set on archive, cleared
 * on restore — fork provenance, the latest main turn's terminal outcome).
 * Owns the in-memory copy, persists it as a
 * single atomic document through `storage`, and notifies changes via
 * `onDidChangeMetadata`. Session-scoped — one instance per session. The initial
 * document is materialized when the session is created.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface AgentMeta {
  readonly homedir?: string;
  readonly type?: 'main' | 'sub' | 'independent';
  readonly parentAgentId?: string | null;
  readonly forkedFrom?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly swarmItem?: string;
}

export const SESSION_META_VERSION = 2;

export type SessionTitleKind = 'replaceable' | 'generated' | 'custom';

export interface SessionMeta {
  readonly id: string;
  readonly version?: number;
  readonly title?: string;
  readonly titleKind?: SessionTitleKind;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly archivedAt?: number;
  readonly cwd?: string;
  readonly forkedFrom?: string;
  readonly agents?: Readonly<Record<string, AgentMeta>>;
  readonly custom?: Record<string, unknown>;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export type SessionMetaPatch = Partial<Omit<SessionMeta, 'id' | 'createdAt'>>;

export interface SessionMetadataChangedEvent {
  readonly changed: readonly (keyof SessionMeta)[];
}

export interface ISessionMetadata {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChangeMetadata: Event<SessionMetadataChangedEvent>;
  read(): Promise<SessionMeta>;
  update(patch: SessionMetaPatch, opts?: { readonly touchUpdatedAt?: boolean }): Promise<void>;
  setTitle(title: string): Promise<void>;
  /**
   * Applies a generated title unless the user customized theirs; the title
   * kind is re-checked inside the serialized update, right before the write,
   * so a custom title set while a generation was in flight still wins.
   * `force` skips the kind check entirely (explicit user-requested
   * regeneration — last writer wins).
   */
  setGeneratedTitleIfUncustomized(
    title: string,
    opts?: { force?: boolean },
  ): Promise<boolean>;
  setArchived(archived: boolean): Promise<void>;
  registerAgent(agentId: string, meta: AgentMeta): Promise<void>;
}

export const ISessionMetadata: ServiceIdentifier<ISessionMetadata> =
  createDecorator<ISessionMetadata>('sessionMetadata');
