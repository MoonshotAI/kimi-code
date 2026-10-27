import { randomUUID } from 'node:crypto';

import { createFeature, type Feature, useNow, useClock } from '#/app/index';
import {
  createUnit,
  useChildren,
  useCleanup,
  useCollection,
  useExpose,
  useReady,
  watch,
} from '#/composition-api/index';
import { KIMI_CODE_PLUGIN_MARKETPLACE_URL } from '#/todo-features/plugin/index';

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
  readonly HOME?: string;
  readonly PASSWORD?: string;
  readonly rpcToken?: string;
  readonly ALLOWED_HOSTS?: readonly string[];
  readonly DISABLE_HOST_CHECK?: boolean;
  readonly bindClass?: 'lan' | 'public';
  readonly PLUGIN_MARKETPLACE_URL?: string;
}

const _PLUGIN_MARKETPLACE_URL = KIMI_CODE_PLUGIN_MARKETPLACE_URL;

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
      const now = useNow();
      const clock = useClock();
      const prefix = options.prefix ?? DEFAULT_HTTP_PREFIX;
      if (
        options.server !== undefined &&
        (options.authTokenService !== undefined ||
          options.disableAuth !== undefined ||
          options.HOME !== undefined ||
          options.PASSWORD !== undefined ||
          options.rpcToken !== undefined ||
          options.ALLOWED_HOSTS !== undefined ||
          options.DISABLE_HOST_CHECK !== undefined ||
          options.bindClass !== undefined)
      ) {
        throw new Error('server security options must be configured on the supplied HTTP server');
      }
      const owned = options.server === undefined;
      const server =
        options.server ??
        createHttpServer({
          now: clock,
          corsOrigins: options.corsOrigins,
          authTokenService: options.authTokenService,
          disableAuth: options.disableAuth,
          HOME: options.HOME,
          PASSWORD: options.PASSWORD,
          rpcToken: options.rpcToken,
          ALLOWED_HOSTS: options.ALLOWED_HOSTS,
          DISABLE_HOST_CHECK: options.DISABLE_HOST_CHECK,
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
      useFeatureFacadeRoutes(prefix, options.PLUGIN_MARKETPLACE_URL ?? _PLUGIN_MARKETPLACE_URL);
      useV2SessionRoutes(V2_HTTP_PREFIX);
      useMetaRoutes(prefix, {
        version: options.version,
        serverId: randomUUID(),
        startedAt: new Date(now()).toISOString(),
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
