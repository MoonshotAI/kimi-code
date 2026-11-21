import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { McpAnchor } from '#/app/mcpConfig/configLoader';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';

export interface ISessionWorkdir {
  readonly _serviceBrand: undefined;

  readonly environmentId: string;
  readonly cwd?: string;
  readonly anchor: McpAnchor;
  readonly onDidChangeAnchor: Event<void>;
  readonly fs: IWorkspaceFsService;
}

export const ISessionWorkdir: ServiceIdentifier<ISessionWorkdir> =
  createDecorator<ISessionWorkdir>('sessionWorkdir');
