import type { EnvironmentProviderHost, EnvironmentUnitImports } from './environmentUnitHost';

export interface EnvironmentProviderAttachment {
  dispose(): void | Promise<void>;
}

export interface EnvironmentProviderContext {
  readonly id: string;
  readonly root: string;
}

export interface EnvironmentProviderFactory {
  readonly id: string;
  readonly imports: EnvironmentUnitImports;
  attach(context: EnvironmentProviderContext, host: EnvironmentProviderHost): Promise<EnvironmentProviderAttachment>;
}
