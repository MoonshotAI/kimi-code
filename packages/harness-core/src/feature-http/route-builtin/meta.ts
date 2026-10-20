import { useApp } from '@moonshot-ai/agent-core/app/index';
import { useInject } from '@moonshot-ai/agent-core/kernel/index';

import type { OpenInAppId } from '#/features/os/fileLaunch';
import { WorkspaceRef } from '#/features/workspaces/index';

import { useHttpRoute } from '../scope';
import { sendOk } from '../route/http';

export type MetaOpenInApps =
  | readonly OpenInAppId[]
  | (() => readonly OpenInAppId[] | Promise<readonly OpenInAppId[]>);

export interface MetaRouteOptions {
  readonly version?: string;
  readonly serverId: string;
  readonly startedAt: string;
  readonly openInApps?: MetaOpenInApps;
}

export interface MetaFeatureView {
  readonly name: string;
  readonly state: 'Active';
  readonly meta: Record<string, unknown>;
}

export function useMetaRoutes(prefix: string, options: MetaRouteOptions): void {
  const app = useApp();
  const workspaces = useInject(WorkspaceRef);
  useHttpRoute({
    id: 'meta',
    method: 'GET',
    path: `${prefix}/meta`,
    handler: async (request, response) => {
      const specs = app.features.list();
      const names = new Set(specs.map((spec) => spec.name));
      const features: MetaFeatureView[] = specs
        .filter((feature) => feature.units['app'] !== undefined)
        .map((feature) => ({ name: feature.name, state: 'Active', meta: {} }));
      const openInApps =
        typeof options.openInApps === 'function'
          ? await options.openInApps()
          : (options.openInApps ?? []);
      sendOk(request, response, {
        server_version: options.version ?? '0.0.0',
        capabilities: {
          websocket: true,
          file_upload: names.has('files'),
          fs_query: workspaces.value?.fs !== undefined,
          mcp: names.has('mcp'),
          tasks: names.has('task'),
          terminal: false,
        },
        server_id: options.serverId,
        started_at: options.startedAt,
        open_in_apps: [...openInApps],
        dangerous_bypass_auth: false,
        features,
      });
    },
  });
}
