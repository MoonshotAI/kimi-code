import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface DefaultWorkspaceStatus {
  readonly path: string | undefined;
  readonly customPath: string | undefined;
  readonly exists: boolean;
}

export interface IDefaultWorkspace {
  readonly _serviceBrand: undefined;

  ensure(): Promise<string>;
  isDefault(root: string): Promise<boolean>;
  status(): Promise<DefaultWorkspaceStatus>;
  setCustomPath(path: string | undefined): Promise<DefaultWorkspaceStatus>;
}

export const IDefaultWorkspace: ServiceIdentifier<IDefaultWorkspace> =
  createDecorator<IDefaultWorkspace>('defaultWorkspace');
