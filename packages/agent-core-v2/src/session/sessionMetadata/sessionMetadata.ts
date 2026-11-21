import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { SessionPatch, SessionRecord } from '@moonshot-ai/core/session/index';

export type { SessionTitleKind } from '@moonshot-ai/core/session/index';

export interface AgentMeta {
  readonly homedir?: string;
  readonly type?: 'main' | 'sub' | 'independent';
  readonly parentAgentId?: string | null;
  readonly forkedFrom?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly swarmItem?: string;
}

export const SESSION_META_VERSION = 2;

export interface SessionMeta extends SessionRecord {
  readonly cwd?: string;
  readonly environmentId?: string;
  readonly environmentCwd?: string;
  readonly agents?: Readonly<Record<string, AgentMeta>>;
}

export type SessionMetaPatch = SessionPatch<SessionMeta>;

export interface SessionMetadataChangedEvent {
  readonly changed: readonly (keyof SessionMeta)[];
}

export interface ISessionMetadata {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly effectiveCwd: string;
  readonly onDidChangeMetadata: Event<SessionMetadataChangedEvent>;
  read(): Promise<SessionMeta>;
  update(patch: SessionMetaPatch, opts?: { readonly touchUpdatedAt?: boolean }): Promise<void>;
  applyPromptMetadata(lastPrompt: string, title: string): Promise<boolean>;
  setTitle(title: string): Promise<void>;
  setGeneratedTitleIfUncustomized(
    title: string,
    opts?: { force?: boolean },
  ): Promise<boolean>;
  setArchived(archived: boolean): Promise<void>;
  registerAgent(agentId: string, meta: AgentMeta): Promise<void>;
  unregisterAgent(agentId: string): Promise<void>;
}

export const ISessionMetadata: ServiceIdentifier<ISessionMetadata> =
  createDecorator<ISessionMetadata>('sessionMetadata');
