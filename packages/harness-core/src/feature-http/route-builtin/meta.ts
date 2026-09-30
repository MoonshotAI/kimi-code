import { Features, useInject } from '@moonshot-ai/agent-core';
import { toValue } from '@moonshot-ai/agent-core/kernel/index';

import { useHttpRoute } from '../feature';
import { sendOk } from '../route/http';

export interface MetaRouteOptions {
  readonly version?: string;
  readonly serverId: string;
  readonly startedAt: string;
}

export interface MetaFeatureView {
  readonly name: string;
  readonly state: 'Active';
  readonly meta: Record<string, unknown>;
}

export function useMetaRoutes(prefix: string, options: MetaRouteOptions): void {
  useHttpRoute({
    id: 'meta',
    method: 'GET',
    path: `${prefix}/meta`,
    handler: (request, response) => {
      const features: MetaFeatureView[] = toValue(useInject(Features))
        .filter((feature) => feature.slots['app'] !== undefined)
        .map((feature) => ({ name: feature.featureName, state: 'Active', meta: {} }));
      sendOk(request, response, {
        server_version: options.version ?? '0.0.0',
        capabilities: {
          websocket: false,
          file_upload: false,
          fs_query: false,
          mcp: true,
          tasks: true,
          terminal: false,
        },
        server_id: options.serverId,
        started_at: options.startedAt,
        open_in_apps: [],
        dangerous_bypass_auth: false,
        features,
      });
    },
  });
}
