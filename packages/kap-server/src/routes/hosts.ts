import { IBootstrapService, IConfigService, IHostFileSystem, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { toHostSnapshot, type HostBridgeManager } from '../services/hosts/hostBridgeManager';
import {
  HOSTS_SECTION,
  hostEntrySchema,
  hostWireObjectSchema,
  hostWireSchema,
  isValidHostId,
} from '../services/hosts/hostsConfig';
import { collectSharedProviders, providerHostStatusSchema, skippedProviderSchema } from '../services/hosts/hostProviders';
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
  readonly query?: unknown;
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

const hostResponseSchema = hostWireObjectSchema.extend({
  id: z.string(),
  status: z.enum(['pending', 'connecting', 'ready', 'disconnected']),
  connected: z.boolean(),
  remote_version: z.string().optional(),
  connect_error: z.string().optional(),
  connect_failure: z.string().optional(),
});

const hostParamsSchema = z.object({ id: z.string() });
const connectBodySchema = z.object({ id: z.string() });
const copyProvidersBodySchema = z.object({ id: z.string(), providers: z.array(z.string()).optional() });
const shareableProvidersQuerySchema = z.object({ host_id: z.string().optional() });
const testResultSchema = z.object({
  connected: z.boolean(),
  remote_version: z.string().optional(),
  connect_error: z.string().optional(),
  connect_failure: z.string().optional(),
});

export function registerHostsRoutes(app: HostsRouteHost, core: Scope, manager: HostBridgeManager): void {
  const config = core.accessor.get(IConfigService);
  const bootstrap = core.accessor.get(IBootstrapService);
  let hostsWrite: Promise<unknown> = Promise.resolve();

  const mutateHosts = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = hostsWrite.catch(() => undefined).then(fn);
    hostsWrite = next;
    return next;
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
      reply.send(okEnvelope({ hosts: manager.list().map(toHostSnapshot) }, req.id));
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
      let entry: z.infer<typeof hostEntrySchema>;
      try {
        entry = hostWireSchema.parse(req.body);
      } catch (error) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error instanceof Error ? error.message : String(error), req.id));
        return;
      }
      const bridge = new SshKapBridge(entry);
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
      const { id } = req.body as z.infer<typeof connectBodySchema>;
      const error = await manager.connect(id).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error : new Error('host connection failed')),
      );
      const info = manager.list().find((candidate) => candidate.id === id);
      if (info === undefined) {
        reply.send(errEnvelope(ErrorCode.ENVIRONMENT_NOT_FOUND, `host "${id}" is not configured`, req.id));
        return;
      }
      const snapshot = toHostSnapshot(info);
      reply.send(
        okEnvelope(
          error !== undefined && snapshot.status === 'pending'
            ? {
                ...snapshot,
                status: 'disconnected',
                connect_error: error.message,
                connect_failure: error instanceof HostConnectError ? error.failure : 'unknown',
              }
            : snapshot,
          req.id,
        ),
      );
    },
  );
  app.post(connectRoute.path, connectRoute.options, connectRoute.handler as never);

  const shareableRoute = defineRoute(
    {
      method: 'GET',
      path: '/hosts::shareable-providers',
      querystring: shareableProvidersQuerySchema,
      success: {
        data: z.object({
          providers: z.array(z.string()),
          skipped: z.array(skippedProviderSchema),
          host_status: z.record(z.string(), providerHostStatusSchema).optional(),
        }),
      },
      errors: { [ErrorCode.ENVIRONMENT_NOT_FOUND]: {}, [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {} },
      description:
        'List the model providers on this computer that can be copied to an SSH host, and the ones that cannot. With host_id, also report whether each one is missing on that host, the same there, or different there',
      tags: ['hosts'],
    },
    async (req: RouteRequest, reply: RouteReply) => {
      const { host_id: hostId } = (req.query ?? {}) as z.infer<typeof shareableProvidersQuerySchema>;
      const { shared, skipped } = await collectSharedProviders(core);
      const providers = Object.keys(shared.providers);
      if (hostId === undefined) {
        reply.send(okEnvelope({ providers, skipped }, req.id));
        return;
      }
      if (manager.section()[hostId] === undefined) {
        reply.send(errEnvelope(ErrorCode.ENVIRONMENT_NOT_FOUND, `host "${hostId}" is not configured`, req.id));
        return;
      }
      try {
        reply.send(okEnvelope({ providers, skipped, host_status: await manager.providerStatus(hostId, shared) }, req.id));
      } catch (error) {
        reply.send(errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error instanceof Error ? error.message : String(error), req.id));
      }
    },
  );
  app.get(shareableRoute.path, shareableRoute.options, shareableRoute.handler as never);

  const copyProvidersRoute = defineRoute(
    {
      method: 'POST',
      path: '/hosts::copy-providers',
      body: copyProvidersBodySchema,
      success: { data: z.object({ copied: z.array(z.string()), updated: z.array(z.string()), skipped: z.array(skippedProviderSchema) }) },
      errors: { [ErrorCode.ENVIRONMENT_NOT_FOUND]: {}, [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {} },
      description: 'Copy the chosen model providers on this computer to a host, replacing providers with the same name there',
      tags: ['hosts'],
    },
    async (req: RouteRequest, reply: RouteReply) => {
      const { id, providers } = req.body as z.infer<typeof copyProvidersBodySchema>;
      if (manager.section()[id] === undefined) {
        reply.send(errEnvelope(ErrorCode.ENVIRONMENT_NOT_FOUND, `host "${id}" is not configured`, req.id));
        return;
      }
      try {
        reply.send(okEnvelope(await manager.copyProviders(id, providers), req.id));
      } catch (error) {
        reply.send(errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error instanceof Error ? error.message : String(error), req.id));
      }
    },
  );
  app.post(copyProvidersRoute.path, copyProvidersRoute.options, copyProvidersRoute.handler as never);

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
      const { id } = req.params as z.infer<typeof hostParamsSchema>;
      if (!isValidHostId(id)) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `invalid host id "${id}"`, req.id));
        return;
      }
      try {
        const entry = hostWireSchema.parse(req.body);
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
