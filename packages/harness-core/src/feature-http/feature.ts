import { randomUUID } from 'node:crypto';

import { createFeature, type Feature } from '#/app/index';
import {
  createUnit,
  useChildren,
  useCleanup,
  useCollection,
  useExpose,
  useReady,
  watch,
} from '#/kernel/index';

import { DEFAULT_HTTP_PREFIX, useFacadeRoutes } from './route-builtin/index';
import { useGuiStoreRoutes } from './route-builtin/gui-store';
import { useMetaRoutes, type MetaOpenInApps } from './route-builtin/meta';
import { useWebAssetRoutes } from './route-builtin/web-assets';
import { useFeatureFacadeRoutes } from './route-features/index';
import { useV2SessionRoutes, V2_HTTP_PREFIX } from './route-v2/index';
import type { HttpAuthTokenService } from './auth';
import { createHttpServer, type Http, type HttpListen } from './server';
import {
  HttpRef,
  HttpRoutes,
  useHttp,
  type HttpRoute,
} from './scope';
import { useWsEndpoint } from './ws';
import { createWsRegistry, WsRegistryRef } from './ws-registry';
import { useWsV1Endpoint } from './ws-v1/index';

export {
  HttpRef,
  HttpRoutes,
  agentFacade,
  findAgentUnit,
  findSessionUnit,
  sessionFacade,
  unitsReady,
  useHttp,
  useHttpRoute,
  useRootUnit,
} from './scope';
export type { HttpRoute } from './scope';

export interface CreateHttpOptions {
  readonly server?: Http;
  readonly listen?: HttpListen;
  readonly prefix?: string;
  readonly version?: string;
  readonly guiStorePath?: string;
  readonly webAssetsDir?: string;
  readonly openInApps?: MetaOpenInApps;
  readonly corsOrigins?: readonly string[];
  readonly wsHeartbeatMs?: number;
  readonly authTokenService?: HttpAuthTokenService;
  readonly disableAuth?: boolean;
  readonly homeDir?: string;
  readonly rpcToken?: string;
  readonly allowedHosts?: readonly string[];
  readonly disableHostCheck?: boolean;
  readonly bindClass?: 'lan' | 'public';
}

const HttpRouteUnit = createUnit<HttpRoute>('http.route', (props) => {
  const http = useHttp();
  let withdraw: (() => void) | undefined;
  watch(
    () => [props.method, props.path, props.handler] as const,
    () => {
      withdraw?.();
      withdraw = http.route(props.method, props.path, props.handler);
    },
    { immediate: true },
  );
  useCleanup(() => {
    withdraw?.();
  });
});

export function createHttp(options: CreateHttpOptions = {}): Feature<void> {
  return createFeature('http', {
    app() {
      const prefix = options.prefix ?? DEFAULT_HTTP_PREFIX;
      if (
        options.server !== undefined &&
        (options.authTokenService !== undefined ||
          options.disableAuth !== undefined ||
          options.homeDir !== undefined ||
          options.rpcToken !== undefined ||
          options.allowedHosts !== undefined ||
          options.disableHostCheck !== undefined ||
          options.bindClass !== undefined)
      ) {
        throw new Error('server security options must be configured on the supplied HTTP server');
      }
      const owned = options.server === undefined;
      const server =
        options.server ??
        createHttpServer({
          corsOrigins: options.corsOrigins,
          authTokenService: options.authTokenService,
          disableAuth: options.disableAuth,
          homeDir: options.homeDir,
          rpcToken: options.rpcToken,
          allowedHosts: options.allowedHosts,
          disableHostCheck: options.disableHostCheck,
          bindClass: options.bindClass,
          apiPrefixes: [prefix, V2_HTTP_PREFIX],
          healthPath: `${prefix.replace(/\/+$/, '')}/healthz`,
        });
      if (owned) {
        useCleanup(() => server.close());
        useReady(server.listen(options.listen));
      }
      useExpose(HttpRef, server);
      useFacadeRoutes(prefix);
      useFeatureFacadeRoutes(prefix);
      useV2SessionRoutes(V2_HTTP_PREFIX);
      useMetaRoutes(prefix, {
        version: options.version,
        serverId: randomUUID(),
        startedAt: new Date().toISOString(),
        openInApps: options.openInApps,
        dangerousBypassAuth: server.dangerousBypassAuth,
      });
      useGuiStoreRoutes(prefix, { persistPath: options.guiStorePath });
      const wsRegistry = createWsRegistry();
      useExpose(WsRegistryRef, wsRegistry);
      useWsV1Endpoint({ http: server, prefix, registry: wsRegistry, heartbeatIntervalMs: options.wsHeartbeatMs });
      useWsEndpoint({ http: server, prefix: V2_HTTP_PREFIX, registry: wsRegistry });
      if (options.webAssetsDir !== undefined) {
        useWebAssetRoutes({ assetsDir: options.webAssetsDir, prefix });
      }
      const routes = useCollection(HttpRoutes);
      useChildren(() =>
        routes.value.map((route) => ({
          key: route.id,
          recipe: HttpRouteUnit,
          props: route,
        })),
      );
    },
  });
}

export const http = createHttp();
