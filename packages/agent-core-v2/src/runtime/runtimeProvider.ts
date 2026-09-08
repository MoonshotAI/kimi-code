import type { Workspace } from '#/app/workspace/workspace';

import type { RuntimeProviderHost, RuntimeUnitImports } from './runtimeUnitHost';

export interface RuntimeProviderAttachment {
  dispose(): void | Promise<void>;
}

export interface RuntimeProviderContext {
  readonly id: string;
  readonly root: string;
  readonly metadata: Workspace;
}

export interface RuntimeProviderFactory {
  readonly id: string;
  readonly imports: RuntimeUnitImports;
  attach(context: RuntimeProviderContext, host: RuntimeProviderHost): Promise<RuntimeProviderAttachment>;
}
