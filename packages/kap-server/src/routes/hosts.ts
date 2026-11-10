import { IBootstrapService, IConfigService, IHostFileSystem, IFlagService, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { toHostSnapshot, type HostBridgeManager, type HostInfo } from '../services/hosts/hostBridgeManager';
import {
  HOSTS_SECTION,
  SSH_FULL_REMOTE_FLAG_ID,
  hostEntrySchema,
  isValidHostId,
  type HostEntry,
} from '../services/hosts/hostsConfig';
import { readSshConfigHosts } from '../services/hosts/sshConfigHosts';
import { HostConnectError, SshKapBridge } from '../services/hosts/sshKapBridge';

interface HostsRouteHost {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: never): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: never): unknown;
  put(path: string, options: { schema?: Record<string, unknown> }, handler: never): unknown;
  delete(path: string, options: { schema?: Record<string, unknown> }, handler: never): unknown;
}

interface RouteRequest {
  readonly id: string;
  readonly body: unknown;
  readonly params: unknown;
}

interface RouteReply {
  send(payload: unknown): unknown;
}

const wireEntrySchema = z.object({
  host: z.string(),
  identity_file: z.string().optional(),
  remote_bin: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
});

const hostResponseSchema = wireEntrySchema.extend({
  id: z.string(),
  status: z.enum(['pending', 'connecting', 'ready', 'disconnected']),
  remote_version: z.string().optional(),
  connect_error: z.string().optional(),
  connect_failure: z.string().optional(),
});

const hostParamsSchema = z.object({ id: z.string() });
const connectBodySchema = z.object({ id: z.string() });
const testResultSchema = z.object({
  connected: z.boolean(),
  remote_version: z.string().optional(),
  connect_error: z.string().optional(),
  connect_failure: z.string().optional(),
});

function toEntry(wire: z.infer<typeof wireEntrySchema>): HostEntry {
  return hostEntrySchema.parse({
    host: wire.host,
    identityFile: wire.identity_file,
    remoteBin: wire.remote_bin,
    name: wire.name,
    enabled: wire.enabled,
  });
}

function toResponse(info: HostInfo): z.infer<typeof hostResponseSchema> {
  return toHostSnapshot(info);
}

export function registerHostsRoutes(app: HostsRouteHost, core: Scope, manager: HostBridgeManager): void {
  const config = core.accessor.get(IConfigService);
  const bootstrap = core.accessor.get(IBootstrapService);
  let hostsWrite: Promise<unknown> = Promise.resolve();

  const mutateHosts = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = hostsWrite.catch(() => undefined).then(fn);
    hostsWrite = next;
    return next;
  };

  const enabled = async (req: RouteRequest, reply: RouteReply): Promise<boolean> => {
    await config.ready;
    if (core.accessor.get(IFlagService).enabled(SSH_FULL_REMOTE_FLAG_ID)) return true;
    reply.send(errEnvelope(ErrorCode.ENVIRONMENT_NOT_FOUND, 'SSH Full-Remote is not enabled', req.id));
    return false;
  };

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/hosts',
      success: { data: z.object({ hosts: z.array(hostResponseSchema) }) },
      description: 'List configured SSH hosts and their connection status',
      tags: ['hosts'],
    },
    async (req: RouteRequest, reply: RouteReply) => {
      if (!(await enabled(req, reply))) return;
      reply.send(okEnvelope({ hosts: manager.list().map(toResponse) }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as never);

  const sshHostsRoute = defineRoute(
    {
      method: 'GET',
      path: '/hosts::ssh-hosts',
      success: {
        data: z.object({
          config_path: z.string(),
          exists: z.boolean(),
          hosts: z.array(
            z.object({
              alias: z.string(),
              host_name: z.string().optional(),
              user: z.string().optional(),
              port: z.number().optional(),
            }),
          ),
        }),
      },
      description: 'List concrete Host aliases declared in the local ~/.ssh/config',
      tags: ['hosts'],
    },
    async (req: RouteRequest, reply: RouteReply) => {
      if (!(await enabled(req, reply))) return;
      const result = await readSshConfigHosts(core.accessor.get(IHostFileSystem), bootstrap.osHomeDir);
      reply.send(
        okEnvelope(
          {
            config_path: result.configPath,
            exists: result.exists,
            hosts: result.hosts.map((host) => ({
              alias: host.alias,
              host_name: host.hostName,
              user: host.user,
              port: host.port,
            })),
          },
          req.id,
        ),
      );
    },
  );
  app.get(sshHostsRoute.path, sshHostsRoute.options, sshHostsRoute.handler as never);

  const testRoute = defineRoute(
    {
      method: 'POST',
      path: '/hosts::test',
      body: wireEntrySchema,
      success: { data: testResultSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Check SSH connectivity and the remote kimi version without starting a server',
      tags: ['hosts'],
    },
    async (req: RouteRequest, reply: RouteReply) => {
      if (!(await enabled(req, reply))) return;
      const bridge = new SshKapBridge(toEntry(req.body as z.infer<typeof wireEntrySchema>));
      try {
        const probe = await bridge.probe();
        reply.send(okEnvelope({ connected: true, remote_version: probe.version }, req.id));
      } catch (error) {
        reply.send(
          okEnvelope(
            {
              connected: false,
              remote_version: error instanceof HostConnectError ? error.remoteVersion : undefined,
              connect_error: error instanceof Error ? error.message : String(error),
              connect_failure: error instanceof HostConnectError ? error.failure : 'unknown',
            },
            req.id,
          ),
        );
      }
    },
  );
  app.post(testRoute.path, testRoute.options, testRoute.handler as never);

  const connectRoute = defineRoute(
    {
      method: 'POST',
      path: '/hosts::connect',
      body: connectBodySchema,
      success: { data: hostResponseSchema },
      errors: { [ErrorCode.ENVIRONMENT_NOT_FOUND]: {} },
      description: 'Connect a configured host now; failures are reported in the returned status',
      tags: ['hosts'],
    },
    async (req: RouteRequest, reply: RouteReply) => {
      if (!(await enabled(req, reply))) return;
      const { id } = req.body as z.infer<typeof connectBodySchema>;
      await manager.connect(id).catch(() => undefined);
      const info = manager.list().find((candidate) => candidate.id === id);
      reply.send(
        info === undefined
          ? errEnvelope(ErrorCode.ENVIRONMENT_NOT_FOUND, `host "${id}" is not configured`, req.id)
          : okEnvelope(toResponse(info), req.id),
      );
    },
  );
  app.post(connectRoute.path, connectRoute.options, connectRoute.handler as never);

  const putRoute = defineRoute(
    {
      method: 'PUT',
      path: '/hosts/{id}',
      params: hostParamsSchema,
      body: wireEntrySchema,
      success: { data: z.object({ ok: z.literal(true) }) },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Create or replace a host',
      tags: ['hosts'],
    },
    async (req: RouteRequest, reply: RouteReply) => {
      if (!(await enabled(req, reply))) return;
      const { id } = req.params as z.infer<typeof hostParamsSchema>;
      if (!isValidHostId(id)) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `invalid host id "${id}"`, req.id));
        return;
      }
      try {
        const entry = toEntry(req.body as z.infer<typeof wireEntrySchema>);
        await mutateHosts(() => config.replace(HOSTS_SECTION, { ...manager.section(), [id]: entry }));
        reply.send(okEnvelope({ ok: true as const }, req.id));
      } catch (error) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error instanceof Error ? error.message : String(error), req.id));
      }
    },
  );
  app.put(putRoute.path, putRoute.options, putRoute.handler as never);

  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/hosts/{id}',
      params: hostParamsSchema,
      success: { data: z.object({ ok: z.literal(true) }) },
      description: 'Remove a host',
      tags: ['hosts'],
    },
    async (req: RouteRequest, reply: RouteReply) => {
      if (!(await enabled(req, reply))) return;
      const { id } = req.params as z.infer<typeof hostParamsSchema>;
      await mutateHosts(async () => {
        const { [id]: _removed, ...rest } = manager.section();
        await config.replace(HOSTS_SECTION, rest);
      });
      reply.send(okEnvelope({ ok: true as const }, req.id));
    },
  );
  app.delete(deleteRoute.path, deleteRoute.options, deleteRoute.handler as never);
}
