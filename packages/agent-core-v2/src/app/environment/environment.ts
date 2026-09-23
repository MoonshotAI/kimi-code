import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { EnvironmentRegistry } from '#/environment/environmentRegistry';
import type { EnvironmentProviderFactory } from '#/environment/environmentProvider';

export interface EnvironmentResolver extends Pick<EnvironmentRegistry, 'inspect' | 'acquire' | 'acquireWhenReady'> {
  readonly _serviceBrand: undefined;
}

export interface IEnvironmentService extends EnvironmentResolver, Pick<EnvironmentRegistry, 'onDidChange' | 'list' | 'snapshot' | 'current' | 'register' | 'drainSession'> {
  readonly ready: Promise<void>;
  addProvider(factory: EnvironmentProviderFactory): Promise<{ dispose(): Promise<void> }>;
}

export const IEnvironmentService: ServiceIdentifier<IEnvironmentService> = createDecorator<IEnvironmentService>('environmentService');
