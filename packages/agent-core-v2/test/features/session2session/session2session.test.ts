import { beforeEach, describe, expect, it } from 'vitest';

import type { CollectionToken, CollectionView } from '#/_base/di/collection';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { ScopeActivation } from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import type { IAgentScopeHandle, ISessionScopeHandle, Scope } from '#/_base/di/scope';
import { _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, SessionMessageOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService, type LoopSubmitOptions, type PromptHandle } from '#/agent/loop/loop';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { LifecycleScope } from '#/app/scopes';
import type { Event2 } from '#/app/event/event2';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import { _clearFeatureRecipesForTests, registerFeature } from '#/features/featureRegistry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ExecutableTool } from '#/tool/toolContract';
import type { UserEntry } from '#human/agent/turn';
import type { WireRecord } from '#/wire/record';
import {
  SESSION2SESSION_FLAG_ENV,
  SESSION2SESSION_DEFAULT_ENABLED,
  session2sessionFlag,
} from '#/features/session2session/flag';
import {
  SESSION2SESSION_FLAG_ID,
  type SessionListEntry,
} from '#/features/session2session/session2session';
import { Session2SessionFeature } from '#/features/session2session/session2sessionFeature';
import { SessionMessageService } from '#/features/session2session/sessionMessageService';
import { SessionMessageSent } from '#/features/session2session/sessionMessageEvents';
import { SessionCreateTool } from '#/features/session2session/tools/sessionCreateTool';
import { SessionListTool } from '#/features/session2session/tools/sessionListTool';
import { SessionReadTool } from '#/features/session2session/tools/sessionReadTool';
import { SessionSendTool } from '#/features/session2session/tools/sessionSendTool';
import { stubFlag } from '../../app/flag/stubs';
import { executeTool } from '../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

interface FakeTarget {
  readonly summary: SessionSummary;
  readonly history: ContextMessage[];
  readonly records: WireRecord[];
  readonly submissions: UserEntry[];
  readonly sent: Event2<any>[];
  readonly session: ISessionScopeHandle;
  running: boolean;
  loaded: boolean;
  steerIfActive: boolean;
}

function accessor(entries: readonly (readonly [ServiceIdentifier<any>, unknown])[]): ServicesAccessor {
  const values = new Map(entries);
  return { get: (id: ServiceIdentifier<unknown>) => values.get(id) } as ServicesAccessor;
}

class FakeDaemon {
  readonly targets = new Map<string, FakeTarget>();
  private createdCount = 0;
  private forkedCount = 0;

  readonly manager = {
    get: (id: string) => {
      const target = this.targets.get(id);
      return target?.loaded ? target.session : undefined;
    },
    resume: async (id: string) => this.targets.get(id)?.session,
    create: async (options: { workDir: string }) => {
      const target = this.add(`created-${++this.createdCount}`, undefined, false, options.workDir);
      return target.session;
    },
    fork: async (options: { sourceSessionId: string; title?: string }) => {
      const source = this.targets.get(options.sourceSessionId)!;
      const target = this.add(
        `fork-${++this.forkedCount}`,
        options.title,
        false,
        source.summary.cwd,
      );
      target.history.push(...source.history);
      target.records.push(...source.records);
      return target.summary;
    },
  } as unknown as ISessionManager;

  readonly index = {
    get: async (id: string) => this.targets.get(id)?.summary,
    listRecent: async () => ({ items: [...this.targets.values()].map((target) => target.summary) }),
  } as unknown as ISessionIndex;

  readonly appendLog = {
    read: (scope: string) => this.readRecords(scope),
  } as never;

  readonly instantiation = {
    invokeFunction: (fn: (accessor: ServicesAccessor) => unknown) =>
      fn(
        accessor([
          [ISessionManager, this.manager],
          [
            ITelemetryService,
            {
              withContext: () => ({ track2: () => undefined }),
            },
          ],
        ]),
      ),
  };

  add(id: string, title = id, running = false, cwd = `/work/${id}`): FakeTarget {
    const summary: SessionSummary = {
      id,
      title,
      workspaceId: 'wd_test',
      cwd,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    };
    const history: ContextMessage[] = [];
    const submissions: UserEntry[] = [];
    const sent: Event2<any>[] = [];
    const context = {
      get: () => history,
      append: (...messages: ContextMessage[]) => history.push(...messages),
    } as unknown as IAgentContextMemoryService;
    const dispatcher = {
      dispatch: async (event: Event2<any>) => {
        sent.push(event);
      },
    } as unknown as IEventDispatcher;
    const target = {
      summary,
      history,
      records: [],
      submissions,
      sent,
      running,
      loaded: true,
      steerIfActive: false as boolean,
      session: undefined as unknown as ISessionScopeHandle,
    } satisfies FakeTarget;
    const handle: PromptHandle = {
      id: '',
      userMessageId: '',
      createdAt: '',
      state: 'pending',
      message: { role: 'user', content: [] },
      launched: Promise.resolve(undefined),
      completion: Promise.resolve({ promptId: '', state: 'completed', result: undefined }),
    };
    const loop = {
      snapshot: () => ({
        state: target.running ? 'running' : 'idle',
        paused: false,
        queue: target.running ? [{}] : [],
      }),
      submit: (entry: UserEntry, options?: LoopSubmitOptions) => {
        submissions.push(entry);
        target.steerIfActive = options?.steerIfActive === true;
        const id = (entry.meta?.promptId as string | undefined) ?? `prompt-${submissions.length}`;
        history.push({
          role: 'user',
          content: [...entry.message.content],
          id,
          origin: entry.meta?.origin as unknown as ContextMessage['origin'],
        });
        return { id };
      },
      promptHandle: (id: string): PromptHandle => ({
        ...handle,
        id,
        state: target.running && target.steerIfActive ? 'steered' : 'pending',
      }),
    } as unknown as IAgentLoopService;
    const agent = {
      accessor: accessor([
        [IAgentLoopService, loop],
        [IEventDispatcher, dispatcher],
        [IAgentContextMemoryService, context],
      ]),
    } as unknown as IAgentScopeHandle;
    const agentContext = { agentId: 'main', generation: 1 };
    const lifecycle = {
      create: async () => agentContext,
      handleOf: () => agent,
    } as unknown as IAgentLifecycleService;
    const sessionContext = {
      sessionId: id,
      workspaceId: summary.workspaceId,
      cwd: summary.cwd,
      sessionDir: `/tmp/kimi-home/sessions/wd_test/${id}`,
    } as unknown as ISessionContext;
    const metadata = {
      read: async () => summary,
      setTitle: async (title: string) => Object.assign(summary, { title }),
    } as unknown as ISessionMetadata;
    target.session = {
      accessor: accessor([
        [ISessionContext, sessionContext],
        [ISessionMetadata, metadata],
        [IAgentLifecycleService, lifecycle],
      ]),
    } as unknown as ISessionScopeHandle;
    this.targets.set(id, target);
    return target;
  }

  tools(sessionId: string): {
    readonly service: SessionMessageService;
    readonly send: SessionSendTool;
    readonly list: SessionListTool;
    readonly read: SessionReadTool;
    readonly create: SessionCreateTool;
  } {
    const target = this.targets.get(sessionId)!;
    const sessionContext = target.session.accessor.get(ISessionContext);
    const service = new SessionMessageService(
      sessionContext,
      target.session.accessor.get(ISessionMetadata),
      { agentId: 'main' } as never,
      {
        get: () => target.history,
      } as unknown as IAgentContextMemoryService,
      {
        readRestorable: async function* () {
          for (const record of target.records) yield record;
        },
      } as never,
      {
        dispatch: async (event: Event2<any>) => {
          target.sent.push(event);
        },
      } as never,
      this.manager,
      this.index,
      {
        homeDir: '/tmp/kimi-home',
        scope: () => 'sessions',
      } as never,
      this.appendLog,
      this.instantiation as never,
    );
    return {
      service,
      send: new SessionSendTool(service),
      list: new SessionListTool(service),
      read: new SessionReadTool(service),
      create: new SessionCreateTool(service),
    };
  }

  private async *readRecords(scope: string): AsyncGenerator<WireRecord> {
    const sessionId = scope.split('/').at(-3);
    for (const record of this.targets.get(sessionId!)?.records ?? []) yield record;
  }
}

async function callTool(
  tool: ExecutableTool<any>,
  args: unknown,
): Promise<{ readonly data: any; readonly isError: boolean }> {
  const result = await executeTool(tool, {
    turnId: 1,
    toolCallId: 'call_1',
    args,
    signal,
  });
  return { data: JSON.parse(result.output as string), isError: result.isError === true };
}

function submittedOrigin(target: FakeTarget, index = 0): SessionMessageOrigin {
  return target.submissions[index]!.meta!.origin as SessionMessageOrigin;
}

describe('session2session tools', () => {
  it('sends to an idle session with origin metadata and records the send in the sender wire events', async () => {
    const daemon = new FakeDaemon();
    const a = daemon.add('session-a', 'Alpha');
    const b = daemon.add('session-b', 'Beta');
    const tools = daemon.tools('session-a');
    expect(tools.send.parameters).toMatchObject({ required: ['to', 'message'] });
    expect(tools.send.parameters['properties']).toHaveProperty('replyTo');
    expect(tools.send.parameters['properties']).not.toHaveProperty('wait');

    const { data, isError } = await callTool(tools.send, {
      to: 'session-b',
      message: 'Please inspect the parser.',
    });

    expect(isError).toBe(false);
    expect(data).toEqual({ messageId: expect.any(String), status: 'started' });
    const origin = submittedOrigin(b);
    expect(origin).toEqual({
      kind: 'session_message',
      messageId: data.messageId,
      fromSessionId: 'session-a',
      fromTitle: 'Alpha',
      chainId: expect.any(String),
      expectReply: false,
    });
    expect(b.submissions[0]!.meta).toMatchObject({ promptId: data.messageId, tracked: true });
    expect(b.submissions[0]!.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(`[message_id: ${data.messageId}][from: Alpha(session-a)]`),
    });
    expect(b.submissions[0]!.message.content[0]).toMatchObject({
      text: expect.stringContaining('Please inspect the parser.'),
    });
    expect(a.sent.some((event) => event instanceof SessionMessageSent)).toBe(true);
  });

  it('queues naturally for a busy session', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const b = daemon.add('session-b', 'Beta', true);
    const tools = daemon.tools('session-a');

    const { data } = await callTool(tools.send, { to: 'Beta', message: 'Queued work' });

    expect(data.status).toBe('queued');
    expect(b.submissions).toHaveLength(1);
    expect(b.steerIfActive).toBe(false);
  });

  it('steers a busy session only when explicitly requested', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const b = daemon.add('session-b', 'Beta', true);
    const tools = daemon.tools('session-a');

    const { data, isError } = await callTool(tools.send, {
      to: 'session-b',
      message: 'Correct the active turn',
      delivery: 'steer',
    });

    expect(isError).toBe(false);
    expect(data.status).toBe('steered');
    expect(b.steerIfActive).toBe(true);
  });

  it('starts a new turn instead of reporting steered for an idle session', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const b = daemon.add('session-b', 'Beta');
    const tools = daemon.tools('session-a');

    const { data } = await callTool(tools.send, {
      to: 'session-b',
      message: 'Start work',
      delivery: 'steer',
    });

    expect(data.status).toBe('started');
    expect(b.steerIfActive).toBe(true);
  });

  it('reads and truncates the latest live assistant text', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const b = daemon.add('session-b', 'Beta');
    b.history.push(
      { role: 'assistant', toolCalls: [], content: [{ type: 'text', text: 'Older answer' }] },
      { role: 'assistant', toolCalls: [], content: [{ type: 'text', text: 'abcdef' }] },
      { role: 'assistant', toolCalls: [], content: [] },
    );
    const tools = daemon.tools('session-a');

    const { data, isError } = await callTool(tools.read, { to: 'Beta', limit: 4 });

    expect(isError).toBe(false);
    expect(data).toEqual({
      id: 'session-b',
      title: 'Beta',
      status: 'idle',
      latestAssistant: 'abcd…',
    });
  });

  it('reads an archived cold session from wire records without resuming it', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const b = daemon.add('session-b', 'Beta');
    b.loaded = false;
    Object.assign(b.summary, { archived: true });
    b.records.push({
      type: 'context.append_message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Recovered from disk' }],
        toolCalls: [],
      },
    });
    const tools = daemon.tools('session-a');

    const { data, isError } = await callTool(tools.read, { to: 'session-b' });

    expect(data).toEqual({
      id: 'session-b',
      title: 'Beta',
      status: 'archived',
      latestAssistant: 'Recovered from disk',
    });
    expect(isError).toBe(false);
    expect(b.history).toHaveLength(0);
    expect(b.submissions).toHaveLength(0);
  });

  it('returns an error when reading an unknown session', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const tools = daemon.tools('session-a');

    const { data, isError } = await callTool(tools.read, { to: 'missing' });

    expect(isError).toBe(true);
    expect(data).toMatchObject({ status: 'error', error: { code: 'SESSION_NOT_FOUND' } });
  });

  it('creates a fresh session in the current directory with an optional title', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const tools = daemon.tools('session-a');

    const { data, isError } = await callTool(tools.create, { title: 'Fresh Worker' });

    expect(isError).toBe(false);
    expect(data).toEqual({ sessionId: 'created-1', status: 'created' });
    expect(daemon.targets.get('created-1')!.summary).toMatchObject({
      title: 'Fresh Worker',
      cwd: '/work/session-a',
    });
  });

  it('forks history and cwd before submitting a tracked first user task', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const b = daemon.add('session-b', 'Beta');
    b.history.push(
      { role: 'user', content: [{ type: 'text', text: 'Original task' }] },
      { role: 'assistant', toolCalls: [], content: [{ type: 'text', text: 'Original answer' }] },
    );
    const tools = daemon.tools('session-a');

    const { data, isError } = await callTool(tools.create, {
      forkFrom: 'session-b',
      title: 'Forked Beta',
      prompt: 'Continue the original task',
    });

    expect(isError).toBe(false);
    expect(data).toEqual({
      sessionId: 'fork-1',
      status: 'created',
      promptId: 'prompt-1',
      promptStatus: 'started',
    });
    const fork = daemon.targets.get('fork-1')!;
    expect(fork.summary).toMatchObject({ title: 'Forked Beta', cwd: b.summary.cwd });
    expect(fork.history.slice(0, 2)).toEqual(b.history);
    expect(fork.submissions).toHaveLength(1);
    expect(fork.submissions[0]!.meta).toMatchObject({ origin: { kind: 'user' }, tracked: true });
    expect(fork.submissions[0]!.message.content).toEqual([
      { type: 'text', text: 'Continue the original task' },
    ]);
    expect(b.submissions).toHaveLength(0);
  });

  it('rejects archived and unknown fork sources', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const b = daemon.add('session-b', 'Beta');
    Object.assign(b.summary, { archived: true });
    const tools = daemon.tools('session-a');

    const archived = await callTool(tools.create, { forkFrom: 'session-b' });
    const unknown = await callTool(tools.create, { forkFrom: 'missing' });

    expect(archived.isError).toBe(true);
    expect(archived.data).toMatchObject({
      status: 'error',
      error: { code: 'SESSION_ARCHIVED' },
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.data).toMatchObject({
      status: 'error',
      error: { code: 'SESSION_NOT_FOUND' },
    });
    expect(daemon.targets.has('fork-1')).toBe(false);
  });

  it('returns send immediately and delivers a later replyTo message as an independent correlated message', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a', 'Alpha');
    const b = daemon.add('session-b', 'Beta');
    const aTools = daemon.tools('session-a');
    const bTools = daemon.tools('session-b');

    const sent = await callTool(aTools.send, {
      to: 'session-b',
      message: 'Need an answer',
      expectReply: true,
    });
    expect(sent.data).toEqual({ messageId: expect.any(String), status: 'started' });

    const original = submittedOrigin(b);
    expect(original.messageId).toBe(sent.data.messageId);
    const replied = await callTool(bTools.send, {
      to: 'session-a',
      replyTo: original.messageId,
      message: 'The answer is 42.',
    });

    expect(replied.data.status).toBe('started');
    expect(replied.data.messageId).not.toBe(original.messageId);
    const a = daemon.targets.get('session-a')!;
    const replyOrigin = submittedOrigin(a);
    expect(replyOrigin).toMatchObject({
      messageId: replied.data.messageId,
      fromSessionId: 'session-b',
      fromTitle: 'Beta',
      replyTo: original.messageId,
      chainId: original.chainId,
      expectReply: false,
    });
    expect(a.submissions[0]!.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('The answer is 42.'),
    });
  });

  it('rejects an unknown replyTo id with a useful message', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const tools = daemon.tools('session-a');

    const { data, isError } = await callTool(tools.send, {
      to: 'session-a',
      replyTo: 'msg_missing',
      message: 'Hello',
    });

    expect(isError).toBe(true);
    expect(data).toMatchObject({
      status: 'error',
      error: { code: 'SESSION_MESSAGE_NOT_FOUND' },
    });
    expect(data.error.message).toContain('请使用收到消息信封里的 messageId');
  });

  it('finds replyTo correlation in restorable wire records when the live context no longer has it', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const b = daemon.add('session-b');
    const origin: SessionMessageOrigin = {
      kind: 'session_message',
      messageId: 'msg_original',
      fromSessionId: 'session-a',
      fromTitle: 'Alpha',
      chainId: 'chain_1',
      expectReply: true,
    };
    b.records.push({
      type: 'context.append_message',
      message: { role: 'user', id: 'msg_original', content: [], origin },
    });
    const tools = daemon.tools('session-b');

    const { data } = await callTool(tools.send, {
      to: 'session-a',
      replyTo: 'msg_original',
      message: 'Reply',
    });

    expect(data.status).toBe('started');
    expect(submittedOrigin(daemon.targets.get('session-a')!)).toMatchObject({
      replyTo: 'msg_original',
      chainId: 'chain_1',
    });
  });

  it('returns candidates for duplicate title aliases', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const b = daemon.add('session-b', 'Duplicate');
    const c = daemon.add('session-c', 'Duplicate');
    const tools = daemon.tools('session-a');

    const { data, isError } = await callTool(tools.send, { to: 'Duplicate', message: 'Hello' });

    expect(isError).toBe(true);
    expect(data).toMatchObject({ status: 'error', error: { code: 'SESSION_ALIAS_AMBIGUOUS' } });
    expect(data.error.candidates.map((entry: SessionListEntry) => entry.id).toSorted()).toEqual([
      'session-b',
      'session-c',
    ]);
    expect(b.submissions).toHaveLength(0);
    expect(c.submissions).toHaveLength(0);
  });

  it('lists sessions with status and absolute directories and applies filter', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a', 'Alpha');
    daemon.add('session-b', 'Beta', true);
    const tools = daemon.tools('session-a');

    const all = await callTool(tools.list, {});
    const filtered = await callTool(tools.list, { filter: 'beta' });

    expect(all.data).toHaveLength(2);
    expect(all.data[1]).toEqual({
      id: 'session-b',
      title: 'Beta',
      cwd: '/work/session-b',
      status: 'running',
      dir: '/tmp/kimi-home/sessions/wd_test/session-b',
    });
    expect(filtered.data).toEqual([all.data[1]]);
  });

  it('returns a structured archived-session error without resuming it', async () => {
    const daemon = new FakeDaemon();
    daemon.add('session-a');
    const b = daemon.add('session-b');
    Object.assign(b.summary, { archived: true });
    const tools = daemon.tools('session-a');

    const { data, isError } = await callTool(tools.send, { to: 'session-b', message: 'Hello' });

    expect(isError).toBe(true);
    expect(data).toMatchObject({ status: 'error', error: { code: 'SESSION_ARCHIVED' } });
    expect(b.submissions).toHaveLength(0);
  });
});

function collectionViewOf<T>(scope: Scope, token: CollectionToken<T>): CollectionView<T> {
  return (scope.instantiation as InstantiationService).fiberHost.collectionView(token);
}

describe('Session2SessionFeature flag', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    _clearFeatureRecipesForTests();
    registerScopedService(
      LifecycleScope.App,
      IFeatureManager,
      FeatureManagerService,
      ScopeActivation.OnScopeCreated,
      'feature',
    );
    registerScopedService(
      LifecycleScope.App,
      IFeatureAssemblyService,
      FeatureAssemblyService,
      ScopeActivation.OnScopeCreated,
      'features',
    );
    registerFeature(Session2SessionFeature);
  });

  it('defaults on in this branch and exposes the dedicated env override', () => {
    expect(session2sessionFlag).toMatchObject({
      id: SESSION2SESSION_FLAG_ID,
      env: SESSION2SESSION_FLAG_ENV,
      default: true,
    });
    expect(SESSION2SESSION_DEFAULT_ENABLED).toBe(true);
  });

  it('does not register tools when the flag is off', () => {
    const host = createScopedTestHost([[IFlagService, stubFlag(false)]]);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');

    expect(collectionViewOf(agent, AgentToolContribution).items).toHaveLength(0);

    host.dispose();
  });

  it('registers exactly the four tools when the flag is on', () => {
    const host = createScopedTestHost([
      [IFlagService, stubFlag((id) => id === SESSION2SESSION_FLAG_ID)],
    ]);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');

    expect(
      collectionViewOf(agent, AgentToolContribution).items.map((entry) => entry.options.name).toSorted(),
    ).toEqual(['session_create', 'session_list', 'session_read', 'session_send']);

    host.dispose();
  });
});
