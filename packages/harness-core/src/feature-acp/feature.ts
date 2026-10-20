import { Readable, Writable } from 'node:stream';

import {
  RequestError,
  agent,
  methods,
  ndJsonStream,
  type AgentApp,
  type ClientCapabilities,
} from '@agentclientprotocol/sdk';
import {
  createFeature,
  useAgent,
  useApp,
  useSession,
  type App,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import {
  createFacadeToken,
  useCleanup,
  useCollection,
  useExpose,
  useInject,
  useOn,
} from '@moonshot-ai/agent-core/kernel/index';
import { currentUnit } from '@moonshot-ai/agent-core/kernel/runtime';
import {
  MAIN_AGENT_ID,
  type Agent,
  type Session,
  type SessionRecord,
} from '@moonshot-ai/agent-core/session/index';

import { CompactionRef } from '#/features/compaction/index';
import { ConfigRef } from '#/features/config/index';
import { InteractionRef, type Interaction } from '#/features/interaction/index';
import { OAuthTokensRef } from '#/features/kimi/index';
import { McpRef } from '#/features/mcp/index';
import { PermissionRef } from '#/features/permission/index';
import { PlanRef } from '#/features/plan/index';
import { AgentModelRef, CatalogModels } from '#/features/provider-catalog/index';
import { SkillCatalogRef, SkillRef } from '#/features/skill/index';
import { TaskRef } from '#/features/task/index';
import { TodoRef } from '#/features/todo/index';
import { UsageRef } from '#/features/usage/index';
import { WorkspaceRef } from '#/features/workspaces/index';
import { agentCaps, createAgentRuntime, harnessInternals } from '#/runtime/index';

import { acpClientFromContext, type AcpClient } from './client';
import { openAcpServer, type AcpHostOptions, type AcpServerHandlers } from './server';
import type { AcpAgentSlot, AcpSessionSlot } from './session';
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

export function createAcp(props: CreateAcpProps): Feature<void> {
  const agentSlots = new WeakMap<Agent, AcpAgentSlot>();
  const sessionSlots = new WeakMap<Session, AcpSessionSlot>();
  return createFeature('acp', {
    app() {
      const node = currentUnit();
      const app = useApp();
      const models = useCollection(CatalogModels);
      const oauth = useInject(OAuthTokensRef);
      const config = useInject(ConfigRef);
      const mcp = useInject(McpRef);
      const workspaces = useInject(WorkspaceRef);
      const skillCatalog = useInject(SkillCatalogRef);
      let client: AcpClient;
      const server = openAcpServer({
        app,
        ready: () => node.host.ready().then(
          () => undefined,
          () => undefined,
        ),
        client: () => client,
        models: () => models.value,
        credentialProbe: () =>
          props.disableAuth === true ||
          oauth.value !== undefined ||
          config.value !== undefined,
        mcp: () => mcp.value,
        workspaces: () => workspaces.value,
        skillCatalog: () => skillCatalog.value,
        config: () => config.value,
        agentSlot: (agent) => agentSlots.get(agent),
        sessionSlot: (session) => sessionSlots.get(session),
        ensureMainAgent: (session) => ensureMainAgent(app, session),
        options: props,
      });
      const agentApp = createAcpAgentApp(server);
      const connection = agentApp.connect(props.streams);
      client = acpClientFromContext(connection.client);
      useExpose(AcpConnectionRef, { client, capabilities: server.clientCapabilities });
      useOn('skill.changed', () => {
        server.notifySkillsChanged();
      });
      useOn('session.meta_updated', (event) => {
        const { sessionId, meta } = event as { sessionId?: unknown; meta?: unknown };
        if (typeof sessionId === 'string') {
          server.trackMetaUpdated(sessionId, meta as SessionRecord);
        }
      });
      useOn('interaction.requested', (event) => {
        const { sessionId, interaction } = event as { sessionId?: unknown; interaction?: unknown };
        if (typeof sessionId === 'string') {
          server.dispatchInteraction(sessionId, interaction as Interaction);
        }
      });
      useCleanup(() => {
        server.dispose();
        connection.close();
      });
    },
    session() {
      const session = useSession();
      const slot: AcpSessionSlot = { interactions: useInject(InteractionRef) };
      sessionSlots.set(session, slot);
      useCleanup(() => {
        if (sessionSlots.get(session) === slot) sessionSlots.delete(session);
      });
    },
    agent() {
      const agent = useAgent();
      const slot: AcpAgentSlot = {
        model: useInject(AgentModelRef),
        todos: useInject(TodoRef),
        usage: useInject(UsageRef),
        tasks: useInject(TaskRef),
        compaction: useInject(CompactionRef),
        skill: useInject(SkillRef),
        plan: useInject(PlanRef),
        permission: useInject(PermissionRef),
      };
      agentSlots.set(agent, slot);
      useCleanup(() => {
        if (agentSlots.get(agent) === slot) agentSlots.delete(agent);
      });
    },
  });
}

function createAcpAgentApp(server: AcpServerHandlers): AgentApp {
  return agent({ name: 'kimi-code-acp' })
    .onRequest(methods.agent.initialize, (ctx) => server.initialize(ctx.params))
    .onRequest(methods.agent.authenticate, (ctx) => server.authenticate(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => server.newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => server.loadSession(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => server.resumeSession(ctx.params))
    .onRequest(methods.agent.session.fork, (ctx) => server.forkSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => server.listSessions(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => server.closeSession(ctx.params))
    .onRequest(methods.agent.session.delete, (ctx) => server.deleteSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => server.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      server.setSessionConfigOption(ctx.params),
    )
    .onRequest(methods.agent.session.prompt, (ctx) => server.prompt(ctx.params, ctx.signal))
    .onNotification(methods.agent.session.cancel, (ctx) => server.cancel(ctx.params))
    .onRequest(SET_SESSION_MODEL_METHOD, parseSetSessionModelParams, (ctx) =>
      server.setSessionModel(ctx.params),
    );
}

async function ensureMainAgent(app: App, session: Session): Promise<Agent> {
  const live = session.agents.get(MAIN_AGENT_ID);
  if (live !== undefined) return live;
  const internals = harnessInternals(app);
  let perSession = internals.agents.get(session);
  if (perSession === undefined) {
    perSession = new Map();
    internals.agents.set(session, perSession);
  }
  let runtime = perSession.get(MAIN_AGENT_ID);
  if (runtime === undefined) {
    runtime = createAgentRuntime(MAIN_AGENT_ID);
    perSession.set(MAIN_AGENT_ID, runtime);
  }
  return session.open(MAIN_AGENT_ID, agentCaps(runtime));
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
