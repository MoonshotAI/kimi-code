import type { Scope } from '@moonshot-ai/agent-core-v2';

import { registerBusinessSnapshotRoutes } from './businessSnapshotRoutes';
import { describeAllChannels, resolveAnyScopedServiceId } from './channelRegistry';
import { type RouteHost, registerServiceDispatcherRoutes } from './serviceDispatcherRoutes';

export function registerDebugRoutes(app: RouteHost, core: Scope): void {
  registerServiceDispatcherRoutes(app, core, '/debug', {
    lookup: (name) => resolveAnyScopedServiceId(core, name),
    describe: describeAllChannels,
  });
  registerBusinessSnapshotRoutes(app, core, '/debug');
}
