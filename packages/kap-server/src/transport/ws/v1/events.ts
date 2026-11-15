import type { CapabilityInstallProgressWire } from '../../../protocol/rest-capability';
import type { ConfigResponse } from '../../../protocol/rest-config';
import type { Session } from '../../../protocol/session';
import type { Workspace } from '../../../protocol/workspace';

export interface SessionMetaUpdatedEvent {
  readonly type: 'session.meta.updated';
  readonly title?: string;
  readonly patch?: Record<string, unknown>;
}

export interface SessionCreatedEvent {
  readonly type: 'event.session.created';
  readonly session: Session;
}

export interface SessionGlobalEvent {
  readonly type: 'session';
  readonly change: 'created' | 'updated' | 'archived' | 'restored' | 'deleted';
  readonly session: Session;
}

export interface WorkspaceGlobalEvent {
  readonly type: 'workspace';
  readonly change: 'created' | 'updated' | 'deleted';
  readonly workspace: Workspace;
}

export interface ConfigWarningItem {
  readonly domain?: string;
  readonly message: string;
}

export interface ConfigGlobalEvent {
  readonly type: 'config';
  readonly config: ConfigResponse;
  readonly warnings?: readonly ConfigWarningItem[];
}

export interface InvalidatedGlobalEvent {
  readonly type: 'invalidated';
  readonly kind: 'models' | 'plugins';
}

export interface ModelCatalogRefreshChange {
  readonly provider_id: string;
  readonly provider_name: string;
  readonly added: number;
  readonly removed: number;
}

export interface ModelCatalogRefreshFailure {
  readonly provider: string;
  readonly reason: string;
}

export interface ModelCatalogRetiredDefault {
  readonly from: string;
  readonly to: string;
  readonly from_display_name: string;
}

export interface CapabilityChangedEvent {
  readonly type: 'event.capability.changed';
  readonly capability_id: string;
  readonly install: CapabilityInstallProgressWire;
}

export type PushEvent =
  | SessionGlobalEvent
  | WorkspaceGlobalEvent
  | ConfigGlobalEvent
  | InvalidatedGlobalEvent
  | CapabilityChangedEvent;

export type Event = PushEvent & {
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly time?: number;
};
