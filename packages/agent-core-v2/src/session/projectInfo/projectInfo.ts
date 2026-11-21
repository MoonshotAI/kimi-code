import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';

export interface ISessionProjectInfo {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly additionalDirs: readonly string[];
  readonly primaryByWorkspace: Readonly<Record<string, string>>;
  readonly onDidChange: Event<void>;
}

export const ISessionProjectInfo: ServiceIdentifier<ISessionProjectInfo> =
  createDecorator<ISessionProjectInfo>('sessionWorkspaceInfo');

export function sessionProjectInfoSeed(info: ISessionProjectInfo): ScopeSeed {
  return [[ISessionProjectInfo as ServiceIdentifier<unknown>, info]];
}
