import { IOAuthService, type Scope } from '@moonshot-ai/agent-core-v2';
import {
  managedUsageResultSchema,
  managedUserInfoResultSchema,
  oauthFlowSnapshotSchema,
  oauthFlowStartSchema,
  oauthLoginCancelResponseSchema,
  oauthLogoutResponseSchema,
  oauthRegionResultSchema,
} from '@moonshot-ai/agent-core-v2/app/auth/oauthProtocol';
import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import {
  inspectRemoteControlLock,
  type RemoteControlDeviceClient,
  type RemoteControlManager,
} from '@moonshot-ai/remote-control';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  oauthLoginQuerySchema,
  oauthLoginStartRequestSchema,
  oauthLogoutRequestSchema,
} from '../protocol/rest-oauth';
import {
  acquireRemoteControlStartGate,
  REMOTE_CONTROL_LOGOUT_GATE_ORIGIN,
  waitForLockRelease,
} from './remoteControl';

interface RouteHost {
  get(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const oauthFlowSnapshotOrNullSchema = z.union([
  oauthFlowSnapshotSchema,
  z.null(),
]);

const LOGOUT_TUNNEL_TEARDOWN_DELAY_MS = 250;

export function registerOAuthRoutes(
  app: RouteHost,
  core: Scope,
  remoteControl: RemoteControlManager,
  remoteControlDevices: Pick<RemoteControlDeviceClient, 'clear' | 'deactivateDevice'>,
  homeDir: string,
): void {
  const loginStartRoute = defineRoute(
    {
      method: 'POST',
      path: '/oauth/login',
      body: oauthLoginStartRequestSchema,
      success: { data: oauthFlowStartSchema },
      description: 'Start an OAuth device-code flow',
      tags: ['auth'],
    },
    async (req, reply) => {
      const result = await core.accessor
        .get(IOAuthService)
        .startLogin(req.body.provider, { region: req.body.region });
      requestLog(req)?.info({ provider: req.body.provider, action: 'login' }, 'oauth login started');
      reply.send(okEnvelope(result, req.id));
    },
  );
  app.post(
    loginStartRoute.path,
    loginStartRoute.options,
    loginStartRoute.handler as Parameters<RouteHost['post']>[2],
  );

  const loginPollRoute = defineRoute(
    {
      method: 'GET',
      path: '/oauth/login',
      querystring: oauthLoginQuerySchema,
      success: { data: oauthFlowSnapshotOrNullSchema },
      description: 'Poll the current OAuth device-code flow',
      tags: ['auth'],
    },
    async (req, reply) => {
      const snapshot = core.accessor.get(IOAuthService).getFlow(req.query.provider);
      reply.send(okEnvelope(snapshot ?? null, req.id));
    },
  );
  app.get(
    loginPollRoute.path,
    loginPollRoute.options,
    loginPollRoute.handler as Parameters<RouteHost['get']>[2],
  );

  const loginCancelRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/oauth/login',
      querystring: oauthLoginQuerySchema,
      success: { data: oauthLoginCancelResponseSchema },
      description: 'Cancel the current OAuth device-code flow',
      tags: ['auth'],
    },
    async (req, reply) => {
      const result = await core.accessor.get(IOAuthService).cancelLogin(req.query.provider);
      requestLog(req)?.info(
        { provider: req.query.provider, action: 'cancel_login' },
        'oauth login cancelled',
      );
      reply.send(okEnvelope(result, req.id));
    },
  );
  app.delete(
    loginCancelRoute.path,
    loginCancelRoute.options,
    loginCancelRoute.handler as Parameters<RouteHost['delete']>[2],
  );

  let kimiLogoutQueue: Promise<void> = Promise.resolve();

  const logoutRoute = defineRoute(
    {
      method: 'POST',
      path: '/oauth/logout',
      body: oauthLogoutRequestSchema,
      success: { data: oauthLogoutResponseSchema },
      errors: { [ErrorCode.INTERNAL_ERROR]: {} },
      description: 'Logout the managed OAuth provider',
      tags: ['auth'],
    },    async (req, reply) => {
      const provider = req.body.provider ?? KIMI_CODE_PROVIDER_NAME;
      if (provider !== KIMI_CODE_PROVIDER_NAME) {
        const result = await core.accessor.get(IOAuthService).logout(req.body.provider);
        requestLog(req)?.info({ provider: req.body.provider, action: 'logout' }, 'oauth logout');
        reply.send(okEnvelope(result, req.id));
        return;
      }
      const serialized = kimiLogoutQueue.then(async () => {
        try {
          const status = remoteControl.status();
          if (status.state === 'on') {
            remoteControlDevices.clear();
            const result = await core.accessor.get(IOAuthService).logout(req.body.provider);
            remoteControlDevices.clear();
            requestLog(req)?.info({ provider, action: 'logout' }, 'oauth logout');
            reply.send(okEnvelope(result, req.id));
            void (async () => {
              await new Promise((resolve) => {
                setTimeout(resolve, LOGOUT_TUNNEL_TEARDOWN_DELAY_MS);
              });
              for (let attempt = 0; ; attempt += 1) {
                try {
                  await remoteControl.disable();
                  return;
                } catch (error) {
                  if (attempt >= 2) {
                    requestLog(req)?.error(
                      { err: error },
                      'remote-control teardown after logout failed',
                    );
                    return;
                  }
                  requestLog(req)?.warn(
                    { err: error },
                    'remote-control teardown after logout failed; retrying',
                  );
                  await new Promise((resolve) => {
                    setTimeout(resolve, 1000 * (attempt + 1));
                  });
                }
              }
            })();
            return;
          }
          if (status.state !== 'off') {
            await remoteControl.disable();
          } else {
            const holder = await inspectRemoteControlLock(homeDir);
            if (holder !== undefined) {
              if (holder.localOrigin !== REMOTE_CONTROL_LOGOUT_GATE_ORIGIN) {
                await remoteControlDevices.deactivateDevice(holder.deviceId);
              }
              await waitForLockRelease(homeDir);
            }
          }
          const gate = await acquireRemoteControlStartGate(homeDir, remoteControlDevices);
          const releaseGate = async (): Promise<void> => {
            for (let attempt = 0; ; attempt += 1) {
              try {
                await gate.release();
                return;
              } catch (error) {
                if (attempt >= 2) {
                  requestLog(req)?.error(
                    { err: error },
                    'remote-control start gate release failed',
                  );
                  return;
                }
                await new Promise((resolve) => {
                  setTimeout(resolve, 200);
                });
              }
            }
          };
          try {
            remoteControlDevices.clear();
            const result = await core.accessor.get(IOAuthService).logout(req.body.provider);
            remoteControlDevices.clear();
            await releaseGate();
            requestLog(req)?.info({ provider, action: 'logout' }, 'oauth logout');
            reply.send(okEnvelope(result, req.id));
          } catch (error) {
            await releaseGate();
            throw error;
          }
        } catch (error) {
          requestLog(req)?.error({ err: error }, 'remote-control cleanup around logout failed');
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
              req.id,
            ),
          );
        }
      });
      kimiLogoutQueue = serialized.then(
        () => undefined,
        () => undefined,
      );
      await serialized;
    },
  );
  app.post(
    logoutRoute.path,
    logoutRoute.options,
    logoutRoute.handler as Parameters<RouteHost['post']>[2],
  );

  const usageRoute = defineRoute(
    {
      method: 'GET',
      path: '/oauth/usage',
      querystring: oauthLoginQuerySchema,
      success: { data: managedUsageResultSchema },
      description: 'Get the managed account usage summary',
      tags: ['auth'],
    },
    async (req, reply) => {
      const result = await core.accessor.get(IOAuthService).getManagedUsage(req.query.provider);
      reply.send(okEnvelope(result, req.id));
    },
  );
  app.get(
    usageRoute.path,
    usageRoute.options,
    usageRoute.handler as Parameters<RouteHost['get']>[2],
  );

  const userInfoRoute = defineRoute(
    {
      method: 'GET',
      path: '/oauth/userinfo',
      querystring: oauthLoginQuerySchema,
      success: { data: managedUserInfoResultSchema },
      description: 'Get the managed account profile',
      tags: ['auth'],
    },
    async (req, reply) => {
      const result = await core.accessor.get(IOAuthService).getManagedUserInfo(req.query.provider);
      reply.send(okEnvelope(result, req.id));
    },
  );
  app.get(
    userInfoRoute.path,
    userInfoRoute.options,
    userInfoRoute.handler as Parameters<RouteHost['get']>[2],
  );

  const regionRoute = defineRoute(
    {
      method: 'GET',
      path: '/oauth/region',
      success: { data: oauthRegionResultSchema },
      description: 'Resolve the client region (mainland-cn/global)',
      tags: ['auth'],
    },
    async (req, reply) => {
      const region = core.accessor.get(IOAuthService).getRegion();
      reply.send(okEnvelope({ region }, req.id));
    },
  );
  app.get(
    regionRoute.path,
    regionRoute.options,
    regionRoute.handler as Parameters<RouteHost['get']>[2],
  );
}
