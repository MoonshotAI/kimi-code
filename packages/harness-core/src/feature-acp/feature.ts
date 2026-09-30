import { Readable, Writable } from 'node:stream';

import {
  RequestError,
  agent,
  methods,
  ndJsonStream,
  type AgentApp,
  type ClientCapabilities,
} from '@agentclientprotocol/sdk';
import { ConfigRef, createFacadeToken, createFeature, useApp, useCleanup, useInject, useOnApp, type FeatureSpec } from '@moonshot-ai/agent-core';
import { CatalogModels } from '@moonshot-ai/agent-core';
import {
  asUnit,
  currentUnit,
  useCollection,
  useExpose,
  type UnitNode,
} from '@moonshot-ai/agent-core/kernel/index';

import { OAuthTokensRef } from '#/features/kimi/index';

import { acpClientFromContext, type AcpClient } from './client';
import { openAcpServer, type AcpHostOptions, type AcpServerHandlers } from './server';
import type { AcpStreamPair } from './types';

export interface CreateAcpProps extends AcpHostOptions {
  readonly streams: AcpStreamPair;
}

export interface AcpConnectionFace {
  readonly client: AcpClient;
  readonly capabilities: () => ClientCapabilities | undefined;
}

export const AcpConnectionRef = createFacadeToken<AcpConnectionFace>('acp.connection');

const SET_SESSION_MODEL_METHOD = 'session/set_model';

interface SetSessionModelParams {
  readonly sessionId: string;
  readonly modelId: string;
}

function parseSetSessionModelParams(params: unknown): SetSessionModelParams {
  const { sessionId, modelId } = (params ?? {}) as Record<string, unknown>;
  if (typeof sessionId !== 'string' || typeof modelId !== 'string') {
    throw RequestError.invalidParams(
      params,
      'session/set_model expects { sessionId: string, modelId: string }',
    );
  }
  return { sessionId, modelId };
}

export function createAcp(props: CreateAcpProps): FeatureSpec {
  return createFeature('acp', {
    app() {
      const node = currentUnit();
      const app = useApp();
      const models = useCollection(CatalogModels);
      const oauth = useInject(OAuthTokensRef);
      const config = useInject(ConfigRef);
      let client: AcpClient;
      const server = openAcpServer({
        ready: () => app.ready(),
        client: () => client,
        models: () => models.value,
        credentialProbe: () =>
          props.disableAuth === true ||
          oauth.value !== undefined ||
          config.value !== undefined,
        options: props,
      });
      const agentApp = createAcpAgentApp(node, server);
      const connection = agentApp.connect(props.streams);
      client = acpClientFromContext(connection.client);
      useExpose(AcpConnectionRef, { client, capabilities: server.clientCapabilities });
      useOnApp('skill.changed', () => {
        server.notifySkillsChanged();
      });
      useCleanup(() => {
        server.dispose();
        connection.close();
      });
    },
  });
}

function createAcpAgentApp(node: UnitNode, server: AcpServerHandlers): AgentApp {
  const scoped = <Args extends unknown[], R>(
    fn: (...args: Args) => R,
  ): ((...args: Args) => R) => {
    return (...args) => asUnit(node, () => fn(...args));
  };
  return agent({ name: 'kimi-code-acp' })
    .onRequest(methods.agent.initialize, (ctx) => scoped(server.initialize)(ctx.params))
    .onRequest(methods.agent.authenticate, (ctx) => scoped(server.authenticate)(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => scoped(server.newSession)(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => scoped(server.loadSession)(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => scoped(server.resumeSession)(ctx.params))
    .onRequest(methods.agent.session.fork, (ctx) => scoped(server.forkSession)(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => scoped(server.listSessions)(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => scoped(server.closeSession)(ctx.params))
    .onRequest(methods.agent.session.delete, (ctx) => scoped(server.deleteSession)(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => scoped(server.setSessionMode)(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      scoped(server.setSessionConfigOption)(ctx.params),
    )
    .onRequest(methods.agent.session.prompt, (ctx) =>
      scoped(server.prompt)(ctx.params, ctx.signal),
    )
    .onNotification(methods.agent.session.cancel, (ctx) => scoped(server.cancel)(ctx.params))
    .onRequest(SET_SESSION_MODEL_METHOD, parseSetSessionModelParams, (ctx) =>
      scoped(server.setSessionModel)(ctx.params),
    );
}

export function acpStdioStreams(): AcpStreamPair {
  const sink = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  globalThis.console.log = sink;
  globalThis.console.info = sink;
  globalThis.console.warn = sink;
  globalThis.console.debug = sink;
  const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  return { readable: stream.readable, writable: stream.writable };
}
