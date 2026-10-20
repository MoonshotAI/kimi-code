import { RootRef } from '@moonshot-ai/agent-core/app/units';
import {
  createCollection,
  createFacadeToken,
  useCleanup,
  useInject,
  type FacadeToken,
} from '@moonshot-ai/agent-core/kernel/index';
import { currentUnit, lineage, type UnitNode } from '@moonshot-ai/agent-core/kernel/runtime';
import type { Agent, Session } from '@moonshot-ai/agent-core/session/index';

import type { Http, HttpHandler } from './server';

export interface HttpRoute {
  readonly id: string;
  readonly method: string | readonly string[];
  readonly path: string;
  readonly handler: HttpHandler;
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

export function useRootUnit(): UnitNode {
  return useInject(RootRef);
}

export function useHttpRoute(route: HttpRoute, priority = 0): void {
  const node = currentUnit();
  const root = [...lineage(node)].at(-1) ?? node;
  useCleanup(root.register(HttpRoutes, route, priority));
}

export function unitsReady(root: UnitNode): Promise<void> {
  return root.ready().then(
    () => undefined,
    () => undefined,
  );
}

export function findSessionUnit(root: UnitNode, sessionId: string): UnitNode | undefined {
  return root.children.find(
    (node) => node.name === 'session' && (node.props['session'] as Session | undefined)?.id === sessionId,
  );
}

export function findAgentUnit(root: UnitNode, sessionId: string, agentId: string): UnitNode | undefined {
  return findSessionUnit(root, sessionId)?.children.find(
    (node) => node.name === 'agent' && (node.props['agent'] as Agent | undefined)?.id === agentId,
  );
}

export function sessionFacade<T>(root: UnitNode, token: FacadeToken<T>, sessionId: string): T | undefined {
  return findSessionUnit(root, sessionId)?.resolve(token);
}

export function agentFacade<T>(
  root: UnitNode,
  token: FacadeToken<T>,
  sessionId: string,
  agentId: string,
): T | undefined {
  return findAgentUnit(root, sessionId, agentId)?.resolve(token);
}
