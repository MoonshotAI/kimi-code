import { basename } from 'node:path';

import type { IDisposable, Workspace } from '@moonshot-ai/agent-core-v2';

import { serverMessageSchema, type ServerMessage, type WorkspaceInfo } from '../../../protocol/messages';
import type { WsV3CoreEvent, WsV3GlobalSource, WsV3Logger } from './wsV3Deps';

export class GlobalMessageTranslator {
  private queue: Promise<void> = Promise.resolve();
  private readonly workspaces = new Map<string, WorkspaceInfo>();
  private readonly validationFailures = new Map<string, number>();
  private readonly disposable: IDisposable;
  private disposed = false;

  constructor(
    private readonly deps: WsV3GlobalSource,
    private readonly emit: (message: ServerMessage) => void,
    private readonly logger?: WsV3Logger,
  ) {
    this.disposable = deps.subscribe((event) => this.onEvent(event));
    this.enqueue(async () => {
      for (const workspace of await deps.listWorkspaces()) {
        this.workspaces.set(workspace.id, await deps.workspaceInfo(workspace));
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.disposable.dispose();
    this.workspaces.clear();
  }

  private onEvent(event: WsV3CoreEvent): void {
    this.enqueue(async () => {
      if (this.disposed) return;
      for (const candidate of await this.translate(event)) this.emitValidated(candidate);
    });
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch(() => {});
  }

  private async translate(event: WsV3CoreEvent): Promise<unknown[]> {
    const timestamp = new Date().toISOString();
    switch (event.type) {
      case 'event.workspace.created':
      case 'event.workspace.updated': {
        const workspace = workspaceRef(event.payload);
        if (workspace === undefined) return [];
        const info = await this.deps.workspaceInfo(workspace);
        this.workspaces.set(info.id, info);
        return [
          {
            type: 'workspace',
            timestamp,
            subtype: event.type === 'event.workspace.created' ? 'created' : 'updated',
            workspace: info,
          },
        ];
      }
      case 'event.workspace.deleted': {
        const payload = workspaceDeletedRef(event.payload);
        if (payload === undefined) return [];
        const cached = this.workspaces.get(payload.workspaceId);
        this.workspaces.delete(payload.workspaceId);
        const fallback: WorkspaceInfo = {
          id: payload.workspaceId,
          root: payload.root,
          name: basename(payload.root).slice(0, 100) || payload.root,
          created_at: timestamp,
          last_opened_at: timestamp,
          session_count: 0,
        };
        return [
          { type: 'workspace', timestamp, subtype: 'deleted', workspace: cached ?? fallback },
        ];
      }
      case 'event.config.changed': {
        const payload = asRecord(event.payload);
        if (payload === undefined) return [];
        return [
          {
            type: 'config',
            timestamp,
            config: payload['config'],
            changed_fields: stringArray(payload['changedFields']),
          },
        ];
      }
      case 'event.config.warning': {
        const warnings = configWarningStrings(event.payload);
        if (warnings === undefined) return [];
        return [{ type: 'config.warning', timestamp, warnings }];
      }
      case 'event.model_catalog.changed':
        return [{ type: 'model_catalog', timestamp }];
      case 'event.plugin.changed':
        return [{ type: 'plugin', timestamp }];
      case 'event.capability.changed': {
        const payload = asRecord(event.payload);
        const capabilityId = payload?.['capability_id'];
        return [
          {
            type: 'capability',
            timestamp,
            capability_id:
              typeof capabilityId === 'string' && capabilityId.length > 0
                ? capabilityId
                : undefined,
          },
        ];
      }
      case 'event.session.created': {
        const payload = asRecord(event.payload);
        const sessionId = stringField(payload, 'sessionId');
        if (payload === undefined || sessionId === undefined) return [];
        const session = payload['session'] ?? (await this.deps.sessionInfo(sessionId));
        if (typeof session !== 'object' || session === null) return [];
        return [{ type: 'session', timestamp, subtype: 'created', session }];
      }
      case 'event.session.archived': {
        const sessionId = stringField(asRecord(event.payload), 'sessionId');
        if (sessionId === undefined) return [];
        const session = await this.deps.sessionInfo(sessionId);
        if (session === undefined) return [];
        return [{ type: 'session', timestamp, subtype: 'archived', session }];
      }
      case 'session.meta.updated': {
        const payload = asRecord(event.payload);
        const sessionId = stringField(payload, 'sessionId');
        if (payload === undefined || sessionId === undefined) return [];
        const session = await this.deps.sessionInfo(sessionId);
        if (session === undefined) return [];
        return [
          {
            type: 'session',
            timestamp,
            subtype: 'updated',
            session,
            changed_fields: metaChangedFields(payload),
          },
        ];
      }
      default:
        return [];
    }
  }

  private emitValidated(candidate: unknown): void {
    const parsed = serverMessageSchema.safeParse(candidate);
    if (!parsed.success) {
      const type = String((candidate as { readonly type?: unknown } | null)?.type);
      const count = (this.validationFailures.get(type) ?? 0) + 1;
      this.validationFailures.set(type, count);
      if (count === 1 || count % 100 === 0) {
        this.logger?.warn(
          {
            type,
            count,
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
          'ws v3: global message failed schema validation, dropped',
        );
      }
      return;
    }
    this.emit(parsed.data);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return out.length === 0 ? undefined : out;
}

function workspaceRef(payload: unknown): Workspace | undefined {
  const candidate = asRecord(payload)?.['workspace'];
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const ws = candidate as Partial<Workspace>;
  if (typeof ws.id !== 'string' || ws.id.length === 0) return undefined;
  if (typeof ws.root !== 'string' || ws.root.length === 0) return undefined;
  if (typeof ws.name !== 'string') return undefined;
  if (typeof ws.createdAt !== 'number' || typeof ws.lastOpenedAt !== 'number') return undefined;
  return {
    id: ws.id,
    root: ws.root,
    name: ws.name,
    createdAt: ws.createdAt,
    lastOpenedAt: ws.lastOpenedAt,
  };
}

function workspaceDeletedRef(payload: unknown): { workspaceId: string; root: string } | undefined {
  const record = asRecord(payload);
  const workspaceId = stringField(record, 'workspaceId');
  const root = stringField(record, 'root');
  if (workspaceId === undefined || root === undefined) return undefined;
  return { workspaceId, root };
}

function configWarningStrings(payload: unknown): string[] | undefined {
  const warnings = asRecord(payload)?.['warnings'];
  if (!Array.isArray(warnings)) return undefined;
  const out: string[] = [];
  for (const warning of warnings) {
    const record = asRecord(warning);
    const message = record?.['message'];
    if (typeof message !== 'string' || message.length === 0) return undefined;
    const domain = record?.['domain'];
    out.push(typeof domain === 'string' && domain.length > 0 ? `${domain}: ${message}` : message);
  }
  return out;
}

function metaChangedFields(payload: Record<string, unknown>): string[] | undefined {
  const patch = asRecord(payload['patch']);
  if (patch === undefined) return undefined;
  const out: string[] = [];
  if (typeof patch['title'] === 'string') out.push('title');
  if (typeof patch['lastPrompt'] === 'string') out.push('last_prompt');
  return out.length === 0 ? undefined : out;
}
