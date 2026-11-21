import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IProjectAliases {
  readonly _serviceBrand: undefined;

  resolveAliasIds(id: string): Promise<readonly string[]>;
}

export const IProjectAliases: ServiceIdentifier<IProjectAliases> =
  createDecorator<IProjectAliases>('workspaceAliases');
