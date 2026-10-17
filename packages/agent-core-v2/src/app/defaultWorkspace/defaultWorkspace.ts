import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IDefaultWorkspace {
  readonly _serviceBrand: undefined;

  ensure(): Promise<string>;
  isDefault(root: string): Promise<boolean>;
}

export const IDefaultWorkspace: ServiceIdentifier<IDefaultWorkspace> =
  createDecorator<IDefaultWorkspace>('defaultWorkspace');
