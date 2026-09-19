import { createFeature, type FeatureSpec } from '@moonshot-ai/agent-core';
import {
  asUnit,
  createCollection,
  createToken,
  createUnit,
  inject,
  pushCleanup,
  useChildren,
  useCollection,
  useExpose,
  useNode,
  useReady,
  watch,
  type UnitNode,
} from '@moonshot-ai/agent-core/kernel/index';

import { DEFAULT_HTTP_PREFIX, useFacadeRoutes } from './route-builtin/index';
import { createHttpServer, type Http, type HttpHandler, type HttpListen } from './server';

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
}

export const HttpRoutes = createCollection<HttpRoute>('http.routes');

export const HttpRef = createToken<Http>('http');

export function useHttp(): Http {
  return inject(HttpRef);
}

export function useHttpRoute(route: HttpRoute, priority = 0): void {
  const node = useNode();
  const wrapped: HttpRoute = {
    ...route,
    handler: (request, response) => asUnit(node, () => route.handler(request, response)),
  };
  pushCleanup(node, rootOf(node).contribute(HttpRoutes, wrapped, priority));
}

const HttpRouteUnit = createUnit<HttpRoute>('http.route', (props) => {
  const http = inject(HttpRef);
  const node = useNode();
  let withdraw: (() => void) | undefined;
  watch(
    () => [props.method, props.path, props.handler] as const,
    () => {
      withdraw?.();
      withdraw = http.route(props.method, props.path, props.handler);
    },
    { immediate: true },
  );
  pushCleanup(node, () => {
    withdraw?.();
  });
});

export function createHttp(options: CreateHttpOptions = {}): FeatureSpec {
  return createFeature('http', {
    app() {
      const node = useNode();
      const owned = options.server === undefined;
      const server = options.server ?? createHttpServer();
      if (owned) {
        pushCleanup(node, () => server.close());
        useReady(server.listen(options.listen));
      }
      useExpose(HttpRef, server);
      useFacadeRoutes(options.prefix ?? DEFAULT_HTTP_PREFIX);
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
