import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { DefaultWorkspaceUnavailableReason } from './errors';

export interface DefaultWorkspaceStatus {
  readonly path: string | undefined;
  readonly customPath: string | undefined;
  readonly systemPath: string | undefined;
  readonly exists: boolean;
  readonly problem: DefaultWorkspaceUnavailableReason | undefined;
}

export interface IDefaultWorkspace {
  readonly _serviceBrand: undefined;

  ensure(): Promise<string>;
  path(): Promise<string | undefined>;
  isDefault(root: string): Promise<boolean>;
  status(): Promise<DefaultWorkspaceStatus>;
  setCustomPath(path: string | undefined): Promise<DefaultWorkspaceStatus>;
}

export const IDefaultWorkspace: ServiceIdentifier<IDefaultWorkspace> =
  createDecorator<IDefaultWorkspace>('defaultWorkspace');
