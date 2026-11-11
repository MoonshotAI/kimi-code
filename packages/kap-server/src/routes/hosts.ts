import { IBootstrapService, IConfigService, IHostFileSystem, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { hostSnapshots, toHostSnapshot, type HostBridgeManager } from '../services/hosts/hostBridgeManager';
import { HOSTS_SECTION, type HostsSection, isValidHostId } from '../services/hosts/hostsConfig';
import { readSshConfigHosts } from '../services/hosts/sshConfigHosts';

interface HostsRouteHost {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: never): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: never): unknown;
}

const hostResponseSchema = z.object({
  id: z.string(),
  host: z.string(),
  identity_file: z.string().optional(),
  remote_bin: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  status: z.enum(['pending', 'connecting', 'ready', 'disconnected']),
  connected: z.boolean(),
  remote_version: z.string().optional(),
  connect_error: z.string().optional(),
  connect_failure: z.string().optional(),
});

export function registerHostsRoutes(app: HostsRouteHost, core: Scope, manager: HostBridgeManager): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/hosts',
      success: { data: z.object({ hosts: z.array(hostResponseSchema) }) },
      description: 'Describe the configured SSH host',
      tags: ['hosts'],
    },
    async (req: { id: string }, reply: { send(payload: unknown): void }) => {
      reply.send(okEnvelope({ hosts: hostSnapshots(manager) }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as never);

  const connectRoute = defineRoute(
    {
      method: 'POST',
      path: '/hosts::connect',
      body: z.object({}),
      success: { data: z.union([hostResponseSchema, z.null()]) },
      description: 'Connect the configured SSH host',
      tags: ['hosts'],
    },
    async (req: { id: string; body: unknown }, reply: { send(payload: unknown): void }) => {
      const body = req.body as { id?: unknown };
      if (body.id !== undefined) {
        if (typeof body.id !== 'string' || !isValidHostId(body.id)) throw new Error('Invalid SSH host alias');
        const config = core.accessor.get(IConfigService);
        await config.ready;
        const section = config.get<HostsSection | undefined>(HOSTS_SECTION) ?? {};
        const selected = Object.keys(section)[0];
        if (selected !== body.id) {
          await config.replace(HOSTS_SECTION, { [body.id]: { host: body.id } });
        }
      }
      await manager.connect().catch(() => undefined);
      const configured = manager.configured();
      reply.send(okEnvelope(configured === undefined ? null : toHostSnapshot(configured.id, configured.entry, manager.bridge()), req.id));
    },
  );
  app.post(connectRoute.path, connectRoute.options, connectRoute.handler as never);

  const sshHostsRoute = defineRoute(
    {
      method: 'GET',
      path: '/hosts::ssh-hosts',
      success: {
        data: z.object({
          config_path: z.string(),
          exists: z.boolean(),
          hosts: z.array(z.object({ alias: z.string(), host_name: z.string().optional(), user: z.string().optional(), port: z.number().optional() })),
        }),
      },
      description: 'List concrete Host aliases declared in the local ~/.ssh/config',
      tags: ['hosts'],
    },
    async (req: { id: string }, reply: { send(payload: unknown): void }) => {
      const result = await readSshConfigHosts(core.accessor.get(IHostFileSystem), core.accessor.get(IBootstrapService).osHomeDir);
      reply.send(okEnvelope({
        config_path: result.configPath,
        exists: result.exists,
        hosts: result.hosts.map((host) => ({ alias: host.alias, host_name: host.hostName, user: host.user, port: host.port })),
      }, req.id));
    },
  );
  app.get(sshHostsRoute.path, sshHostsRoute.options, sshHostsRoute.handler as never);
}
