import { describe, expect, it, vi } from 'vitest';

import type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../src/core/channel.js';
import { createKlientFromChannel } from '../src/core/klient.js';
import { KlientValidationError } from '../src/core/validation.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Records calls, replays scripted results, and captures listen subscriptions. */
class FakeChannel implements KlientChannel {
  readonly calls: Array<{ scope: ScopeRef; service: string; method: string; args: unknown[] }> = [];
  readonly subscriptions: Array<{
    scope: ScopeRef;
    source: EventSourceRef;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  result: unknown;
  /** Keyed `${service}.${method}` result overrides. */
  readonly results = new Map<string, unknown>();
  private readonly handlers = new Map<number, (data: unknown) => void>();
  private nextSub = 0;

  call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown> {
    this.calls.push({ scope, service, method, args });
    const key = `${service}.${method}`;
    return Promise.resolve(this.results.has(key) ? this.results.get(key) : this.result);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(_scope: ScopeRef, _service: string, _method: string, _args: unknown[]): AsyncIterableIterator<unknown> {
    // stub — streaming is not exercised in facade tests
  }

  listen(scope: ScopeRef, source: EventSourceRef, handler: (data: unknown) => void): IDisposable {
    const id = this.nextSub;
    this.nextSub += 1;
    this.handlers.set(id, handler);
    const dispose = vi.fn(() => {
      this.handlers.delete(id);
    });
    this.subscriptions.push({ scope, source, dispose });
    return { dispose };
  }

  /** Push a raw payload into the Nth subscription (0-based). */
  emit(index: number, data: unknown): void {
    this.handlers.get(index)?.(data);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const SUMMARY = {
  id: 's1',
  workspaceId: 'w1',
  createdAt: 1,
  updatedAt: 2,
  archived: false,
};

describe('facade routing', () => {
  it('reshapes single-object params into positional wire args', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);

    channel.result = { id: 'w1', root: '/x', name: 'n', createdAt: 1, lastOpenedAt: 2 };
    await klient.global.workspaces.createOrTouch({ root: '/x', name: 'n' });
    expect(channel.calls[0]).toMatchObject({
      service: 'workspaceService',
      method: 'createOrTouch',
      args: ['/x', 'n'],
    });

    channel.result = undefined; // void output
    await klient.global.plugins.setMcpServerEnabled({ id: 'p', server: 's', enabled: true });
    expect(channel.calls[1]).toMatchObject({
      service: 'pluginService',
      method: 'setPluginMcpServerEnabled',
      args: [{ id: 'p', server: 's', enabled: true }],
    });

    channel.results.set('oauthService.status', { loggedIn: false });
    await klient.global.auth.status();
    expect(channel.calls[2]).toMatchObject({
      service: 'oauthService',
      method: 'status',
      args: [undefined],
    });
  });

  it('routes capability calls through the registered app service contract', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const status = {
      id: 'kimi-cu',
      displayName: 'Kimi Computer Use',
      description: 'Background GUI automation',
      supported: true,
      state: 'partial',
      steps: [{ id: 'permissions', state: 'missing' }],
      // The completed-install note survives the contract parse (not stripped).
      install: { running: false, note: 'user-skill-migrated' },
    };
    channel.result = [status];

    await expect(klient.global.capabilities.list()).resolves.toEqual([status]);
    channel.result = status;
    await expect(klient.global.capabilities.get('kimi-cu')).resolves.toEqual(status);
    await expect(klient.global.capabilities.install('kimi-cu')).resolves.toEqual(status);

    expect(channel.calls).toEqual([
      { scope: {}, service: 'capabilityService', method: 'listCapabilities', args: [] },
      { scope: {}, service: 'capabilityService', method: 'getCapability', args: ['kimi-cu'] },
      { scope: {}, service: 'capabilityService', method: 'installCapability', args: ['kimi-cu'] },
    ]);
  });

  it('env() fans out property reads and merges them', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'v';
    channel.results.set('bootstrapService.clientIdentity', {
      productName: 'v',
      version: 'v',
      platform: 'v',
    });
    const env = await klient.global.env();
    expect(env.platform).toBe('v');
    expect(env.logsDir).toBe('v');
    expect(env.clientVersion).toBe('v');
    expect(channel.calls).toHaveLength(12);
    expect(channel.calls.every((call) => call.service === 'bootstrapService')).toBe(true);
  });

  it('env() resolves once and serves repeats from the cache', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'v';
    channel.results.set('bootstrapService.clientIdentity', {
      productName: 'v',
      version: 'v',
      platform: 'v',
    });
    await klient.global.env();
    expect(channel.calls).toHaveLength(12);

    const again = await klient.global.env();
    expect(again.platform).toBe('v');
    expect(channel.calls).toHaveLength(12);
  });
});

describe('agent profile routing', () => {
  it('thinking calls route to agentProfileService with the agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    channel.result = undefined; // void output
    await agent.setThinking('on');
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentProfileService',
      method: 'setThinking',
      args: ['on'],
    });

    channel.result = 'high';
    await expect(agent.getThinking()).resolves.toBe('high');
    expect(channel.calls[1]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentProfileService',
      method: 'getEffectiveThinkingLevel',
      args: [],
    });
  });
});

describe('agent skill routing', () => {
  it('promptWithSkills routes to agentSkillService.promptWithSkills with the agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    channel.result = { turn_id: 7 };
    await expect(
      agent.promptWithSkills({
        input: [{ type: 'text', text: 'Review this change.' }],
        skills: [{ name: 'review' }, { name: 'security', args: 'src/app.ts' }],
      }),
    ).resolves.toEqual({ turn_id: 7 });
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentSkillService',
      method: 'promptWithSkills',
      args: [
        {
          input: [{ type: 'text', text: 'Review this change.' }],
          skills: [{ name: 'review' }, { name: 'security', args: 'src/app.ts' }],
        },
      ],
    });
  });
});

describe('session skills routing', () => {
  it('skills.list routes to sessionSkillCatalog.list with the session scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);

    const summaries = [
      {
        name: 'review',
        description: 'review changes',
        path: '/skills/review/SKILL.md',
        source: 'project',
      },
    ];
    channel.result = summaries;
    await expect(klient.session('s1').skills.list()).resolves.toEqual(summaries);
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1' },
      service: 'sessionSkillCatalog',
      method: 'list',
      args: [],
    });
  });

  it('skills.changed maps to the sessionSkillCatalog emitter', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: unknown[] = [];

    klient.session('s1').events.on('skills.changed', (event) => seen.push(event));
    expect(channel.subscriptions[0]?.source).toEqual({
      kind: 'emitter',
      service: 'sessionSkillCatalog',
      event: 'onDidChange',
    });

    channel.emit(0, 'workspace');
    await tick();
    expect(seen).toEqual(['workspace']);
  });

  it('activateSkill routes to agentSkillService with the agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    channel.result = { turn_id: 3 };
    await expect(agent.activateSkill({ name: 'review', args: 'src/app.ts' })).resolves.toEqual({
      turn_id: 3,
    });
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentSkillService',
      method: 'activate',
      args: [{ name: 'review', args: 'src/app.ts' }],
    });
  });

  it('turn-driving calls route to their domain services with the agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');
    const scope = { sessionId: 's1', agentId: 'main' };

    channel.results.set('agentPromptService.submit', { turn_id: 1 });
    channel.results.set('agentPromptService.submitSteer', { turn_id: 1 });
    channel.results.set('agentCommandService.list', []);
    await agent.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await agent.steer({ input: [{ type: 'text', text: 'steer' }] });
    await agent.cancel({ turnId: 2 });
    await agent.cancel();
    await agent.setPermission('yolo');
    await agent.listCommands();
    await agent.runCommand({ name: 'cmd', args: 'a b' });
    await agent.runCommand({ name: 'plain' });

    expect(channel.calls).toEqual([
      {
        scope,
        service: 'agentPromptService',
        method: 'submit',
        args: [{ input: [{ type: 'text', text: 'hi' }] }],
      },
      {
        scope,
        service: 'agentPromptService',
        method: 'submitSteer',
        args: [{ input: [{ type: 'text', text: 'steer' }] }],
      },
      { scope, service: 'agentLoopService', method: 'cancelFromUser', args: [2] },
      { scope, service: 'agentLoopService', method: 'cancelFromUser', args: [] },
      { scope, service: 'agentPermissionModeService', method: 'setModeAndBroadcast', args: ['yolo'] },
      { scope, service: 'agentCommandService', method: 'list', args: [] },
      { scope, service: 'agentCommandService', method: 'run', args: ['cmd', 'a b'] },
      { scope, service: 'agentCommandService', method: 'run', args: ['plain'] },
    ]);
  });

  it('getContext merges the contextMemory and tokenCounting reads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');
    const scope = { sessionId: 's1', agentId: 'main' };

    channel.results.set('agentContextMemoryService.get', [{ role: 'user' }]);
    channel.results.set('agentTokenCountingService.statusSize', 42);
    await expect(agent.getContext()).resolves.toEqual({
      history: [{ role: 'user' }],
      tokenCount: 42,
    });
    expect(channel.calls).toEqual([
      { scope, service: 'agentContextMemoryService', method: 'get', args: [] },
      { scope, service: 'agentTokenCountingService', method: 'statusSize', args: [] },
    ]);
  });
});

describe('agent mcp / compaction routing', () => {
  it('getMcpServers returns the live snapshot with the agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    const entries = [
      { name: 'mock', transport: 'stdio', status: 'pending', toolCount: 0 },
    ];
    channel.results.set('agentMcpService.list', entries);
    await expect(agent.getMcpServers()).resolves.toEqual(entries);
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentMcpService',
      method: 'list',
      args: [],
    });
    expect(channel.calls).toHaveLength(1);
  });

  it('compact issues a manual begin with the optional instruction', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    channel.result = true;
    await expect(agent.compact()).resolves.toBe(true);
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentFullCompactionService',
      method: 'begin',
      args: [{ source: 'manual', instruction: undefined }],
    });

    channel.result = false;
    await expect(agent.compact({ instruction: 'keep the plan' })).resolves.toBe(false);
    expect(channel.calls[1]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentFullCompactionService',
      method: 'begin',
      args: [{ source: 'manual', instruction: 'keep the plan' }],
    });
  });
});

describe('session lifecycle routing', () => {
  it('delete calls the App session manager', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.results.set('sessionManager.delete', undefined);

    await klient.session('s1').delete();

    expect(channel.calls).toEqual([
      { scope: {}, service: 'sessionManager', method: 'delete', args: ['s1'] },
    ]);
  });

  it('restore forwards resume options to the App session manager', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.results.set('sessionManager.restore', { id: 's1', kind: 'session' });

    const opts = {
      mcpServers: { example: { transport: 'stdio' as const, command: 'node' } },
    };
    await expect(klient.session('s1').restore(opts)).resolves.toBe(true);

    expect(channel.calls[0]).toEqual({
      scope: {},
      service: 'sessionManager',
      method: 'restore',
      args: ['s1', opts],
    });
  });

  it('sessions.create forwards mcpServers to the App session manager', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.results.set('sessionManager.create', { id: 's1', kind: 'session' });
    channel.results.set('sessionMetadata.read', {
      id: 's1',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    });

    const mcpServers = {
      example: { transport: 'stdio' as const, command: 'node', args: ['server.mjs'] },
    };
    await klient.global.sessions.create({ workDir: '/x', mcpServers });

    expect(channel.calls[0]).toMatchObject({
      scope: {},
      service: 'sessionManager',
      method: 'create',
      args: [{ workDir: '/x', mcpServers }],
    });
  });

  it('sessions.create rejects malformed mcpServers before the call leaves the client', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    await expect(
      klient.global.sessions.create({
        workDir: '/x',
        mcpServers: { bad: { transport: 'http', url: 'not-a-url' } },
      }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    expect(channel.calls.some((call) => call.method === 'create')).toBe(false);
  });
});

describe('contract validation', () => {
  it('rejects invalid input before the call leaves the client', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    await expect(
      klient.global.sessions.list({ limit: '20' as unknown as number }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    expect(channel.calls).toHaveLength(0);
  });

  it('rejects drifted output payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = { id: 's1' }; // missing required SessionSummary fields
    await expect(klient.global.sessions.get('s1')).rejects.toBeInstanceOf(KlientValidationError);
  });

  it('passes valid payloads through and returns parsed output', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = SUMMARY;
    await expect(klient.global.sessions.get('s1')).resolves.toEqual(SUMMARY);
  });

  it('validate:false skips both directions', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel, { validate: false });
    channel.result = { anything: true };
    await expect(
      klient.global.sessions.list({ limit: '20' as unknown as number }),
    ).resolves.toEqual({ anything: true });
  });
});

describe('event hub', () => {
  it('maps public names to emitter sources and validates payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: unknown[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => {
        errors.push(error);
      });

    klient.events.on('kosong.providers.changed', (event) => seen.push(event));
    expect(channel.subscriptions[0]?.source).toEqual({
      kind: 'emitter',
      service: 'providerService',
      event: 'onDidChangeProviders',
    });

    channel.emit(0, { added: ['p1'], removed: [], changed: [] });
    channel.emit(0, { added: 'not-an-array' });
    await tick();
    expect(seen).toEqual([{ added: ['p1'], removed: [], changed: [] }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(KlientValidationError);
  });

  it('shares one bus subscription across bus-derived events and filters by type', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const archived: unknown[] = [];
    const catalog: unknown[] = [];

    const subA = klient.events.on('session.archived', (event) => archived.push(event));
    const subB = klient.events.on('kosong.changed', (event) => catalog.push(event));
    expect(channel.subscriptions).toHaveLength(1);
    expect(channel.subscriptions[0]?.source).toEqual({ kind: 'stream', name: 'events' });

    channel.emit(0, { type: 'event.session.archived', payload: { sessionId: 's1' } });
    channel.emit(0, { type: 'event.model_catalog.changed', payload: { changed: [], unchanged: [], failed: [] } });
    channel.emit(0, { type: 'unrelated.type', payload: {} });
    await tick();
    expect(archived).toEqual([{ sessionId: 's1' }]);
    expect(catalog).toEqual([{ changed: [], unchanged: [], failed: [] }]);

    subA.dispose();
    expect(channel.subscriptions[0]?.dispose).not.toHaveBeenCalled();
    subB.dispose();
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('delivers session.metaUpdated when the patch carries no lastPrompt', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: unknown[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => {
      errors.push(error);
    });

    klient.events.on('session.metaUpdated', (event) => seen.push(event));
    channel.emit(0, {
      type: 'session.meta.updated',
      payload: {
        agentId: 'main',
        sessionId: 's1',
        title: 'generated title',
        patch: { title: 'generated title', isCustomTitle: false },
      },
    });
    await tick();
    expect(seen).toEqual([
      {
        agentId: 'main',
        sessionId: 's1',
        title: 'generated title',
        patch: { title: 'generated title', isCustomTitle: false },
      },
    ]);
    expect(errors).toHaveLength(0);
  });

  it('disposes the emitter subscription when the last listener detaches', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const a = klient.events.on('config.changed', () => undefined);
    const b = klient.events.on('config.changed', () => undefined);
    expect(channel.subscriptions).toHaveLength(1);
    a.dispose();
    expect(channel.subscriptions[0]?.dispose).not.toHaveBeenCalled();
    b.dispose();
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('forwards the newly registered agent stream events and validates payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');
    const seen = {
      delta: [] as unknown[],
      progress: [] as unknown[],
      started: [] as unknown[],
      blocked: [] as unknown[],
      cancelled: [] as unknown[],
      completed: [] as unknown[],
    };
    const errors: Error[] = [];
    agent.events.onError((error) => {
      errors.push(error);
    });

    agent.events.on('tool.call.delta', (event) => seen.delta.push(event));
    agent.events.on('tool.progress', (event) => seen.progress.push(event));
    agent.events.on('compaction.started', (event) => seen.started.push(event));
    agent.events.on('compaction.blocked', (event) => seen.blocked.push(event));
    agent.events.on('compaction.cancelled', (event) => seen.cancelled.push(event));
    agent.events.on('compaction.completed', (event) => seen.completed.push(event));

    // All six registrations share one `events` stream subscription bound to
    // the agent scope.
    expect(channel.subscriptions).toHaveLength(1);
    expect(channel.subscriptions[0]?.scope).toEqual({ sessionId: 's1', agentId: 'main' });
    expect(channel.subscriptions[0]?.source).toEqual({ kind: 'stream', name: 'events' });

    const delta = { type: 'tool.call.delta', turnId: 1, toolCallId: 'tc1', name: 'Bash', argumentsPart: '{"command":' };
    const progress = {
      type: 'tool.progress',
      turnId: 1,
      toolCallId: 'tc1',
      update: { kind: 'stdout', text: 'chunk' },
    };
    const started = { type: 'compaction.started', trigger: 'auto' };
    const blocked = { type: 'compaction.blocked', turnId: 2 };
    const cancelled = { type: 'compaction.cancelled' };
    const completed = {
      type: 'compaction.completed',
      result: { summary: 's', compactedCount: 3, tokensBefore: 100, tokensAfter: 40 },
    };
    channel.emit(0, delta);
    channel.emit(0, progress);
    channel.emit(0, started);
    channel.emit(0, blocked);
    channel.emit(0, cancelled);
    channel.emit(0, completed);
    channel.emit(0, { type: 'tool.progress', turnId: 1, toolCallId: 'tc1' }); // missing update
    channel.emit(0, { type: 'unregistered.type', turnId: 1 });
    await tick();

    expect(seen.delta).toEqual([delta]);
    expect(seen.progress).toEqual([progress]);
    expect(seen.started).toEqual([started]);
    expect(seen.blocked).toEqual([blocked]);
    expect(seen.cancelled).toEqual([cancelled]);
    expect(seen.completed).toEqual([completed]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(KlientValidationError);
  });
});
