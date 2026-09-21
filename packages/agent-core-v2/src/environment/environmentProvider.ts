import type { Event, IWaitUntil } from '#/_base/event';
import type { WorkspaceTrustChange } from '#/workspace/workspaceTrust/workspaceTrust';

import type { EnvironmentProviderHost, EnvironmentUnitImports } from './environmentUnitHost';

export interface EnvironmentProviderAttachment {
  dispose(): void | Promise<void>;
}

export interface EnvironmentProviderContext {
  readonly id: string;
  readonly root: string;
  readonly onDidChangeTrust: Event<WorkspaceTrustChange & IWaitUntil>;
}

export interface EnvironmentProviderFactory {
  readonly id: string;
  readonly imports: EnvironmentUnitImports;
  attach(context: EnvironmentProviderContext, host: EnvironmentProviderHost): Promise<EnvironmentProviderAttachment>;
}
