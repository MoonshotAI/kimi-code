import type { ConfigResponse } from '../../../protocol/rest-config';
import type { Session, SessionPendingInteraction } from '../../../protocol/session';
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

export interface SessionArchivedEvent {
  readonly type: 'event.session.archived';
  readonly workspace_id: string;
}

export interface SessionDeletedEvent {
  readonly type: 'event.session.deleted';
  readonly workspace_id: string;
}

export interface WorkspaceCreatedEvent {
  readonly type: 'event.workspace.created';
  readonly workspace: Workspace;
}

export interface WorkspaceUpdatedEvent {
  readonly type: 'event.workspace.updated';
  readonly workspace: Workspace;
}

export interface WorkspaceDeletedEvent {
  readonly type: 'event.workspace.deleted';
  readonly workspace_id: string;
  readonly root: string;
}

export interface SessionWorkChangedEvent {
  readonly type: 'event.session.work_changed';
  readonly busy: boolean;
  readonly main_turn_active?: boolean;
  readonly pending_interaction?: SessionPendingInteraction;
  readonly last_turn_reason?: 'completed' | 'cancelled' | 'failed';
}

export interface ConfigChangedEvent {
  readonly type: 'event.config.changed';
  readonly changedFields: string[];
  readonly config: ConfigResponse;
}

export interface ConfigWarningItem {
  readonly domain?: string;
  readonly message: string;
}

export interface ConfigWarningEvent {
  readonly type: 'event.config.warning';
  readonly warnings: readonly ConfigWarningItem[];
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

export interface ModelCatalogChangedEvent {
  readonly type: 'event.model_catalog.changed';
  readonly changed: readonly ModelCatalogRefreshChange[];
  readonly unchanged: readonly string[];
  readonly failed: readonly ModelCatalogRefreshFailure[];
  readonly retired_default?: ModelCatalogRetiredDefault;
}

export interface PluginChangedEvent {
  readonly type: 'event.plugin.changed';
}

export interface CapabilityChangedEvent {
  readonly type: 'event.capability.changed';
  readonly capability_id: string;
  readonly install: {
    readonly running: boolean;
    readonly step?: string;
    readonly percent?: number;
    readonly error?: string;
    readonly note?: string;
  };
}

export interface DiUnitChangedEvent {
  readonly type: 'event.di.unit_changed';
  readonly scope: string;
  readonly token: string;
  readonly state: 'Pending' | 'Activating' | 'Active' | 'Unloading' | 'Failed';
  readonly error?: string;
}

export type PushEvent =
  | SessionMetaUpdatedEvent
  | SessionCreatedEvent
  | SessionArchivedEvent
  | SessionDeletedEvent
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | SessionWorkChangedEvent
  | ConfigChangedEvent
  | ConfigWarningEvent
  | ModelCatalogChangedEvent
  | PluginChangedEvent
  | CapabilityChangedEvent
  | DiUnitChangedEvent;

export type Event = PushEvent & { agentId: string; sessionId: string; readonly time?: number };
