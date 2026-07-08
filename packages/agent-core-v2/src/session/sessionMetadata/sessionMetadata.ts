/**
 * `sessionMetadata` domain (L6) — typed session metadata.
 *
 * Defines the `SessionMeta` model and the `ISessionMetadata` used by upper
 * layers to read and update the session's durable metadata (title, timestamps,
 * archived flag, fork provenance). Owns the in-memory copy, persists it as a
 * single atomic document through `storage`, and notifies changes via
 * `onDidChangeMetadata`. Session-scoped — one instance per session. The initial
 * document is materialized when the session is created.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface AgentMeta {
  /** Per-agent directory used as the wire-record `homedir` (persistence key). */
  readonly homedir: string;
  readonly type?: 'main' | 'sub' | 'independent';
  readonly parentAgentId?: string;
  /** Agent this one was forked / derived from (provenance only; not used by business logic). */
  readonly forkedFrom?: string;
  /**
   * Business-defined recorded values (e.g. the swarm's `swarmItem`), persisted
   * verbatim. Never interpreted by the lifecycle.
   */
  readonly labels?: Readonly<Record<string, string>>;
  /** @deprecated Legacy v1 field; read-compat only. */
  readonly type?: 'main' | 'sub';
  /** @deprecated Legacy v1 field; read-compat only. */
  readonly parentAgentId?: string | null;
  /** @deprecated Legacy on-disk field predating `labels`; read-compat only. */
  readonly swarmItem?: string;
}

/**
 * Metadata document schema version written by this build. Stored on each
 * session's `state.json` so readers can tell which layout a document follows:
 * `2` = written by v2 (epoch-ms timestamps); absent = legacy v1 (ISO-string
 * timestamps). Both v1 and v2 write the document to `<sessionDir>/state.json`;
 * the version field is what distinguishes them.
 */
export const SESSION_META_VERSION = 2;

export interface SessionMeta {
  readonly id: string;
  /** Metadata schema version — `2` for documents written by v2. */
  readonly version?: number;
  readonly title?: string;
  /** True when the title was explicitly set by the user (rename), false/undefined for auto titles. */
  readonly isCustomTitle?: boolean;
  /** Last user prompt text, surfaced on the wire `Session.last_prompt`. */
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  /**
   * Absolute working directory frozen at session creation (`metadata.cwd` on
   * the wire). Persisted so the session read model (`sessionIndex`) can surface
   * it without reverse-resolving the workspace registry — a session whose
   * workspace was unregistered keeps its original cwd (closes gap G3). Mirrors
   * v1, which stores `workDir` on the session. Optional only for documents
   * predating this field; `load()` always writes it for new sessions.
   */
  readonly cwd?: string;
  readonly forkedFrom?: string;
  /** Registry of agents belonging to this session, keyed by agent id. */
  readonly agents?: Readonly<Record<string, AgentMeta>>;
  /** Free-form custom metadata (wire `Session.metadata` minus reserved keys like `goal`). */
  readonly custom?: Record<string, unknown>;
}

export type SessionMetaPatch = Partial<Omit<SessionMeta, 'id' | 'createdAt'>>;

export interface SessionMetadataChangedEvent {
  /** Metadata fields touched by the update (the `SessionMetaPatch` keys). */
  readonly changed: readonly (keyof SessionMeta)[];
}

export interface ISessionMetadata {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChangeMetadata: Event<SessionMetadataChangedEvent>;
  read(): Promise<SessionMeta>;
  update(patch: SessionMetaPatch): Promise<void>;
  setTitle(title: string): Promise<void>;
  setArchived(archived: boolean): Promise<void>;
  /** Register (or replace) an agent entry in the session's agent registry. */
  registerAgent(agentId: string, meta: AgentMeta): Promise<void>;
}

export const ISessionMetadata: ServiceIdentifier<ISessionMetadata> =
  createDecorator<ISessionMetadata>('sessionMetadata');
