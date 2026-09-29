import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';

export interface IEnvironmentDeclarationService {
  readonly _serviceBrand: undefined;
  declarations(): Promise<EnvironmentDeclarationSet | undefined>;
}

export const IEnvironmentDeclarationService: ServiceIdentifier<IEnvironmentDeclarationService> = createDecorator<IEnvironmentDeclarationService>('environmentDeclarationService');
