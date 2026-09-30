import { createFacadeToken, createFeature, useCleanup, useInject, type FeatureSpec } from '@moonshot-ai/agent-core';
import {
  asUnit,
  createCollection,
  createUnit,
  currentUnit,
  useChildren,
  useCollection,
  useExpose,
  useReady,
  watch,
  type UnitNode,
} from '@moonshot-ai/agent-core/kernel/index';
import { randomUUID } from 'node:crypto';

import { DEFAULT_HTTP_PREFIX, useFacadeRoutes } from './route-builtin/index';
import { useGuiStoreRoutes } from './route-builtin/gui-store';
import { useMetaRoutes } from './route-builtin/meta';
import { useWebAssetRoutes } from './route-builtin/web-assets';
import { useFeatureFacadeRoutes } from './route-features/index';
import { createHttpServer, type Http, type HttpHandler, type HttpListen } from './server';
import { useWsEndpoint } from './ws';

export interface HttpRoute {
  readonly id: string;
  readonly method: string | readonly string[];
  readonly path: string;
  readonly handler: HttpHandler;
}

export interface CreateHttpOptions {
  readonly server?: Http;
  readonly listen?: HttpListen;
  readonly prefix?: string;
  readonly version?: string;
  readonly guiStorePath?: string;
  readonly webAssetsDir?: string;
}

export const HttpRoutes = createCollection<HttpRoute>('http.routes');

export const HttpRef = createFacadeToken<Http>('http');

export function useHttp(): Http {
  const http = useInject(HttpRef).value;
  if (http === undefined) {
    throw new Error('http feature is not installed');
  }
  return http;
}

export function useHttpRoute(route: HttpRoute, priority = 0): void {
  const node = currentUnit();
  const wrapped: HttpRoute = {
    ...route,
    handler: (request, response) => asUnit(node, () => route.handler(request, response)),
  };
  useCleanup(rootOf(node).contribute(HttpRoutes, wrapped, priority));
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

export function createHttp(options: CreateHttpOptions = {}): FeatureSpec {
  return createFeature('http', {
    app() {
      const owned = options.server === undefined;
      const server = options.server ?? createHttpServer();
      if (owned) {
        useCleanup(() => server.close());
        useReady(server.listen(options.listen));
      }
      useExpose(HttpRef, server);
      const prefix = options.prefix ?? DEFAULT_HTTP_PREFIX;
      useFacadeRoutes(prefix);
      useFeatureFacadeRoutes(prefix);
      useMetaRoutes(prefix, {
        version: options.version,
        serverId: randomUUID(),
        startedAt: new Date().toISOString(),
      });
      useGuiStoreRoutes(prefix, { persistPath: options.guiStorePath });
      useWsEndpoint({ prefix });
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

function rootOf(node: UnitNode): UnitNode {
  let current = node;
  while (current.parent !== null) {
    current = current.parent;
  }
  return current;
}
