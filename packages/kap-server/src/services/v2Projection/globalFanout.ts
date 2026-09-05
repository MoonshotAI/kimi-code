import {
  serverMessageSchema,
  type ServerMessage,
  type SessionInfo,
  type WorkspaceInfo,
} from '../../protocol/v2/messages/index';
import type { V2Disposable } from './binder';

export interface GlobalV2Event {
  type: string;
  payload?: unknown;
  time?: number;
}

export interface GlobalV2EventSource {
  subscribe(handler: (event: GlobalV2Event) => void): V2Disposable;
}

export interface GlobalV2FanoutDeps {
  sessionInfoFor(sessionId: string): Promise<SessionInfo | undefined>;
  workspaceWireFor(workspace: unknown): Promise<WorkspaceInfo | undefined>;
  ensureSessionBinding?(sessionId: string): void;
  clock?: () => number;
  logger?: { warn(meta: Record<string, unknown>, msg: string): void };
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function payloadOf(event: GlobalV2Event): Record<string, unknown> | undefined {
  const payload = event.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function textOf(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' ? value : undefined;
}

export class GlobalV2Fanout {
  private readonly targets = new Set<(msg: ServerMessage) => void>();
  private readonly clock: () => number;

  constructor(
    source: GlobalV2EventSource,
    private readonly deps: GlobalV2FanoutDeps,
  ) {
    this.clock = deps.clock ?? Date.now;
    source.subscribe((event) => {
      void this.onEvent(event).catch((error: unknown) =>
        deps.logger?.warn({ err: error, type: event.type }, 'ws2 global fanout failed'),
      );
    });
  }

  addTarget(target: (msg: ServerMessage) => void): V2Disposable {
    this.targets.add(target);
    return { dispose: () => this.targets.delete(target) };
  }

  private emit(msg: ServerMessage): void {
    const parsed = serverMessageSchema.safeParse(msg);
    if (!parsed.success) {
      this.deps.logger?.warn({ type: msg.type }, 'ws2 global outbound dropped: contract violation');
      return;
    }
    for (const target of this.targets) target(parsed.data as ServerMessage);
  }

  private async onEvent(event: GlobalV2Event): Promise<void> {
    const payload = payloadOf(event);
    const ts = iso(event.time ?? this.clock());
    switch (event.type) {
      case 'session.meta.updated': {
        const sessionId = textOf(payload, 'sessionId');
        if (sessionId === undefined) return;
        const session = await this.deps.sessionInfoFor(sessionId);
        if (session === undefined) return;
        const patch = payload?.['patch'];
        const changedFields =
          patch !== null && typeof patch === 'object' && !Array.isArray(patch)
            ? Object.keys(patch)
            : textOf(payload, 'title') !== undefined
              ? ['title']
              : undefined;
        this.emit({ type: 'session', timestamp: ts, subtype: 'updated', session, changed_fields: changedFields });
        return;
      }
      case 'event.session.created': {
        const sessionId = textOf(payload, 'sessionId');
        if (sessionId === undefined) return;
        this.deps.ensureSessionBinding?.(sessionId);
        const session = await this.deps.sessionInfoFor(sessionId);
        if (session === undefined) return;
        this.emit({ type: 'session', timestamp: ts, subtype: 'created', session });
        return;
      }
      case 'event.session.archived': {
        const sessionId = textOf(payload, 'sessionId');
        if (sessionId === undefined) return;
        const session = await this.deps.sessionInfoFor(sessionId);
        if (session === undefined) return;
        this.emit({ type: 'session', timestamp: ts, subtype: 'archived', session });
        return;
      }
      case 'event.workspace.created':
      case 'event.workspace.updated': {
        const workspace = await this.deps.workspaceWireFor(payload?.['workspace']);
        if (workspace === undefined) return;
        this.emit({
          type: 'workspace',
          timestamp: ts,
          subtype: event.type === 'event.workspace.created' ? 'created' : 'updated',
          workspace,
        });
        return;
      }
      case 'event.workspace.deleted': {
        const workspaceId = textOf(payload, 'workspaceId');
        const root = textOf(payload, 'root') ?? '';
        if (workspaceId === undefined) return;
        const workspace = (await this.deps.workspaceWireFor(payload?.['workspace'])) ?? {
          id: workspaceId,
          root,
          name: root.length > 0 ? (root.split('/').findLast((segment) => segment.length > 0) ?? root) : workspaceId,
          created_at: ts,
          last_opened_at: ts,
          session_count: 0,
        };
        this.emit({ type: 'workspace', timestamp: ts, subtype: 'deleted', workspace });
        return;
      }
      case 'event.config.changed': {
        const changedFields = payload?.['changedFields'];
        this.emit({
          type: 'config',
          timestamp: ts,
          config: (payload?.['config'] ?? {}) as Record<string, unknown>,
          changed_fields: Array.isArray(changedFields) ? (changedFields as string[]) : undefined,
        });
        return;
      }
      case 'event.config.warning': {
        const warnings = payload?.['warnings'];
        if (!Array.isArray(warnings)) return;
        this.emit({
          type: 'config.warning',
          timestamp: ts,
          warnings: warnings
            .map((warning) => {
              const message = textOf(warning as Record<string, unknown>, 'message');
              const domain = textOf(warning as Record<string, unknown>, 'domain');
              return domain !== undefined ? `${domain}: ${message}` : message;
            })
            .filter((warning): warning is string => warning !== undefined),
        });
        return;
      }
      case 'event.model_catalog.changed': {
        this.emit({ type: 'model_catalog', timestamp: ts });
        return;
      }
      case 'event.plugin.changed': {
        this.emit({ type: 'plugin', timestamp: ts });
        return;
      }
      case 'event.capability.changed': {
        this.emit({ type: 'capability', timestamp: ts, capability_id: textOf(payload, 'capability_id') });
        return;
      }
      default:
        return;
    }
  }
}
