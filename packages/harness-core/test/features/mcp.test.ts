import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigRef,
  createConfig,
  createFeature,
  createUserMessage,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  useAgent,
  type AgentHandle,
  type AppHandle,
  type ConfigPersist,
  type AgentLlmRequester,
  type LlmModelSpec,
  type Message,
  type SessionStores,
  type ToolDescription,
} from '@moonshot-ai/agent-core';

import {
  MCP_DYNAMIC_TOOLS_REMIND_KEY,
  McpRef,
  convertMCPContentBlock,
  createMcp,
  loadMcpServers,
  mcpResultToToolResult,
  planMcpToolRegistrations,
  qualifyMcpToolName,
  useMcpServerSource,
  type McpServerConfig,
  type McpServerStdioConfig,
  type McpSection,
} from '#/features/mcp/index';
import { createNodeOsHost, type OsHost } from '#/features/os/host/index';

import type { MediaStore } from '#/features/media/index';

import { fakeRequester, textOutcome } from '../fake-llm';
import { createMemoryMediaStore } from '../fake-media';

const fixturePath = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const model: LlmModelSpec = { provider: 'test', name: 'test-model', capability: { image_in: true } };

interface LlmCall {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall, index: number) => { text: string } | { toolCall: { name: string; arguments: string } };

function createMockRequester(script: LlmScript): { requester: AgentLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: fakeRequester((rest, onEvent) => {
        const call: LlmCall = { messages: rest.content?.messages ?? [], tools: rest.profile?.tools ?? [] };
        calls.push(call);
        const out = script(call, calls.length - 1);
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        });
        if ('toolCall' in out) {
          return textOutcome('', [
            { type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments },
          ]);
        }
        return textOutcome(out.text);
      }),
  };
}

function fakePersist(initial?: string): ConfigPersist {
  let text = initial;
  return {
    load: () => Promise.resolve(text),
    save: (value) => {
      text = value;
      return Promise.resolve();
    },
  };
}

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function stdioServer(
  extra?: Partial<Omit<McpServerStdioConfig, 'transport' | 'command' | 'args'>>,
): McpServerConfig {
  return { transport: 'stdio', command: process.execPath, args: [fixturePath], ...extra };
}

interface StartedApp {
  readonly app: AppHandle;
  readonly main: AgentHandle;
  readonly calls: LlmCall[];
  readonly workDir: string;
  readonly homeDir: string;
  readonly stores: SessionStores;
  readonly feature: ReturnType<typeof createMcp>;
  readonly dispose: () => Promise<void>;
}

async function startApp(opts: {
  readonly script: LlmScript;
  readonly servers?: Record<string, McpServerConfig>;
  readonly trusted?: boolean;
  readonly mediaStore?: MediaStore;
  readonly host?: OsHost | null;
  readonly env?: Record<string, string>;
  readonly features?: readonly ReturnType<typeof createMcp>[];
  readonly sessionCwd?: (sessionId: string) => string | undefined;
  readonly beforeReady?: (app: AppHandle, feature: ReturnType<typeof createMcp>) => void;
}): Promise<StartedApp> {
  const workDir = await tmpDir('mcp-work-');
  const homeDir = await tmpDir('mcp-home-');
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const { requester, calls } = createMockRequester(opts.script);
  const bindLlm = createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel({ spec: model });
      agent.setRequester(requester);
    },
  });
  const feature = createMcp({
    workDir,
    home: homeDir,
    host: opts.host === null ? undefined : (opts.host ?? createNodeOsHost()),
    trusted: opts.trusted,
    servers: opts.servers,
    mediaStore: opts.mediaStore,
    sessionCwd: opts.sessionCwd,
  });
  const app = createHarness({
    features: [
      createConfig({ persist: fakePersist(), env: opts.env }),
      ...(opts.features ?? []),
      feature,
      bindLlm,
    ],
  });
  opts.beforeReady?.(app, feature);
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  return {
    app,
    main,
    calls,
    workDir,
    homeDir,
    stores,
    feature,
    dispose: async () => {
      await app.disposeAsync();
      await stores.dispose();
    },
  };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

async function runTurn(main: AgentHandle, text: string): Promise<void> {
  const done = nextTurnDone(main);
  main.submit(createUserMessage(text));
  await done;
}

function toolNames(call: LlmCall | undefined): string[] {
  return call?.tools.map((tool) => tool.name) ?? [];
}

function dynamicToolNames(call: LlmCall | undefined): string[] {
  return (
    call?.messages.flatMap((message) =>
      message.role === 'system' ? (message.tools ?? []) : [],
    ).map((tool) => tool.name) ?? []
  );
}

describe('mcp feature', () => {
  it('merges config layers with props.servers as the base and respects trusted', async () => {
    const home = await tmpDir('mcp-cfg-home-');
    const work = await tmpDir('mcp-cfg-work-');
    await mkdir(join(work, '.git'));
    await mkdir(join(work, '.kimi-code'), { recursive: true });
    await writeFile(
      join(home, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          shared: { transport: 'http', url: 'http://example.com/user' },
          useronly: { command: 'user-cmd' },
        },
      }),
    );
    await writeFile(
      join(work, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'root-cmd', cwd: 'sub' } } }),
    );
    await writeFile(
      join(work, '.kimi-code', 'mcp.json'),
      JSON.stringify({ mcpServers: { projectonly: { command: 'project-cmd' } } }),
    );
    const programmatic = {
      base: { transport: 'stdio', command: 'base-cmd' } as McpServerConfig,
      shared: { transport: 'stdio', command: 'props-cmd' } as McpServerConfig,
    };

    const untrusted = await loadMcpServers({ fs: createNodeOsHost().fs, cwd: work, home, trusted: false, servers: programmatic });
    expect(Object.keys(untrusted).toSorted()).toEqual(['base', 'shared', 'useronly']);
    expect(untrusted['shared']).toMatchObject({ transport: 'http', url: 'http://example.com/user' });
    expect(untrusted['base']).toMatchObject({ transport: 'stdio', command: 'base-cmd' });

    const trusted = await loadMcpServers({ fs: createNodeOsHost().fs, cwd: work, home, trusted: true, servers: programmatic });
    expect(Object.keys(trusted).toSorted()).toEqual(['base', 'projectonly', 'shared', 'useronly']);
    expect(trusted['shared']).toMatchObject({ transport: 'stdio', command: 'root-cmd', cwd: join(work, 'sub') });
    expect(trusted['projectonly']).toMatchObject({ transport: 'stdio', command: 'project-cmd' });
  });

  it('qualifies tool names with sanitization, hash truncation, and collision/filter planning', () => {
    expect(qualifyMcpToolName('my server', 'do.thing')).toBe('mcp__my_server__do_thing');
    const long = qualifyMcpToolName('s'.repeat(40), 't'.repeat(40));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/_-?[0-9a-f]{8}$/);
    expect(qualifyMcpToolName('s'.repeat(40), 't'.repeat(40))).toBe(long);

    const plan = planMcpToolRegistrations(
      'srv',
      ['a.b', 'a_b', 'taken', 'dropped'],
      new Set(['a.b', 'a_b', 'taken']),
      (qualified) => (qualified === 'mcp__srv__taken' ? 'other-srv' : undefined),
    );
    expect(plan.planned).toEqual([{ qualified: 'mcp__srv__a_b', toolName: 'a.b' }]);
    expect(plan.collisions).toEqual([
      {
        qualified: 'mcp__srv__a_b',
        toolName: 'a_b',
        collidesWith: { kind: 'same_server', toolName: 'a.b' },
      },
      {
        qualified: 'mcp__srv__taken',
        toolName: 'taken',
        collidesWith: { kind: 'other_server', serverName: 'other-srv' },
      },
    ]);
  });

  it('gates the frozen spec on initial load and calls stdio tools end to end', async () => {
    const started = await startApp({
      servers: { fake: stdioServer() },
      script: (_call, index) =>
        index === 0
          ? { toolCall: { name: 'mcp__fake__echo', arguments: JSON.stringify({ text: 'hello-mcp' }) } }
          : { text: 'done' },
    });
    try {
      await runTurn(started.main, 'call echo');
      expect(toolNames(started.calls[0])).toContain('mcp__fake__echo');
      const toolMessage = started.calls[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([{ type: 'text', text: 'hello-mcp' }]);
      const entries = started.app.resolve(McpRef).list();
      expect(entries).toEqual([
        { name: 'fake', transport: 'stdio', status: 'connected', toolCount: 5, error: undefined },
      ]);
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('fails stdio servers with a clear error when mounted without an OS host', async () => {
    const started = await startApp({
      host: null,
      servers: { fake: stdioServer() },
      script: () => ({ text: 'ok' }),
    });
    try {
      await runTurn(started.main, 'hi');
      const [entry] = started.app.resolve(McpRef).list();
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('createMcp was mounted without an OS host');
      expect(toolNames(started.calls[0])).not.toContain('mcp__fake__echo');
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('keeps deferred server tools out of the frozen spec and delivers them through the dynamic channel', async () => {
    const started = await startApp({
      servers: { fake: stdioServer({ deferred: true }) },
      script: (call, index) => {
        if (index === 0) {
          return { toolCall: { name: 'mcp__fake__echo', arguments: JSON.stringify({ text: 'hello-deferred' }) } };
        }
        return { text: 'done' };
      },
    });
    try {
      await runTurn(started.main, 'call the deferred tool by name');
      expect(toolNames(started.calls[0])).not.toContain('mcp__fake__echo');
      const toolMessage = started.calls[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([{ type: 'text', text: 'hello-deferred' }]);
      const schemasMessage = started.calls[1]?.messages.find(
        (message) => message.role === 'system' && message.tools !== undefined,
      );
      expect(schemasMessage?.tools?.map((tool) => tool.name)).toContain('mcp__fake__echo');
      expect(toolNames(started.calls[1])).not.toContain('mcp__fake__echo');
      const history = started.stores.get(MAIN_AGENT_ID)?.getState().history ?? [];
      const reminder = history.find(
        (entry) => entry.meta?.source === 'reminder' && entry.meta.key === MCP_DYNAMIC_TOOLS_REMIND_KEY,
      );
      expect(reminder?.message.role).toBe('system');
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('delivers late-connected tools through the dynamic channel without touching the frozen spec', async () => {
    const started = await startApp({
      script: (call, index) => {
        if (index === 0) return { text: 'ok' };
        if (index === 1) {
          return { toolCall: { name: 'mcp__fake__echo', arguments: JSON.stringify({ text: 'hello-late' }) } };
        }
        return { text: 'done' };
      },
    });
    try {
      await runTurn(started.main, 'before the server exists');
      expect(toolNames(started.calls[0])).not.toContain('mcp__fake__echo');
      await writeFile(
        join(started.homeDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [fixturePath] } } }),
      );
      await started.app.resolve(McpRef).reload();
      expect(started.app.resolve(McpRef).list().map((entry) => entry.status)).toEqual(['connected']);
      await runTurn(started.main, 'call the late tool by name');
      const schemasMessage = started.calls[2]?.messages.find(
        (message) => message.role === 'system' && message.tools !== undefined,
      );
      expect(schemasMessage?.tools?.map((tool) => tool.name)).toContain('mcp__fake__echo');
      for (const call of started.calls) {
        expect(toolNames(call)).not.toContain('mcp__fake__echo');
      }
      const toolMessage = started.calls[2]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([{ type: 'text', text: 'hello-late' }]);
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('governs MCP output: extras, media store offload, data URLs, and per-part caps', async () => {
    const withExtras = await mcpResultToToolResult(
      {
        content: [{ type: 'text', text: '{"ok":true}' }],
        isError: false,
        structuredContent: { ok: true, extra: 'yes' },
        _meta: { 'mcp.internal/secret': 1, 'example.com/custom': 2 },
      },
      'mcp__fake__structured',
    );
    const extras = withExtras.content.find(
      (part) => part.type === 'text' && part.text.includes('<mcp-result-extras>'),
    );
    expect(extras?.type).toBe('text');
    if (extras?.type !== 'text') throw new Error('expected extras text');
    expect(extras.text).toContain('"structuredContent":{"ok":true,"extra":"yes"}');
    expect(extras.text).toContain('example.com/custom');
    expect(extras.text).not.toContain('secret');

    const deepEqualCopy = await mcpResultToToolResult(
      {
        content: [{ type: 'text', text: '{"ok":true}' }],
        isError: false,
        structuredContent: { ok: true },
      },
      'mcp__fake__structured',
    );
    expect(deepEqualCopy.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
    expect(deepEqualCopy.isError).toBeUndefined();

    const serverFlagged = await mcpResultToToolResult(
      { content: [{ type: 'text', text: 'boom' }], isError: true },
      'mcp__fake__echo',
    );
    expect(serverFlagged.isError).toBe(true);

    const store = createMemoryMediaStore();
    const offloaded = await mcpResultToToolResult(
      { content: [{ type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }], isError: false },
      'mcp__fake__image',
      { mediaStore: store },
    );
    expect(offloaded.content[0]).toEqual({ type: 'text', text: '<mcp_tool_result name="mcp__fake__image">' });
    const mediaPart = offloaded.content[1];
    if (mediaPart?.type !== 'image_url') throw new Error('expected an image_url part');
    expect(mediaPart.source.kind).toBe('store');
    if (mediaPart.source.kind !== 'store') throw new Error('expected a store source');
    expect(mediaPart.source.ref.startsWith('media://')).toBe(true);
    const stored = await store.get(mediaPart.source.ref);
    expect(stored?.mimeType).toBe('image/png');
    expect(offloaded.content[2]).toEqual({ type: 'text', text: '</mcp_tool_result>' });

    const inline = await mcpResultToToolResult(
      { content: [{ type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }], isError: false },
      'mcp__fake__image',
    );
    expect(inline.content[1]).toEqual({
      type: 'image_url',
      source: { kind: 'inline', mimeType: 'image/png', data: TINY_PNG_BASE64 },
    });

    const oversized = await mcpResultToToolResult(
      {
        content: [{ type: 'image', data: Buffer.alloc(11 * 1024 * 1024).toString('base64'), mimeType: 'image/png' }],
        isError: false,
      },
      'mcp__fake__big',
    );
    const notice = oversized.content.find(
      (part) => part.type === 'text' && part.text.includes('dropped'),
    );
    expect(notice?.type).toBe('text');
    if (notice?.type !== 'text') throw new Error('expected a drop notice');
    expect(notice.text).toContain('image_url dropped');
    expect(oversized.content.every((part) => part.type === 'text')).toBe(true);

    expect(convertMCPContentBlock({ type: 'resource', resource: { uri: 'file:///x.bin', mimeType: 'application/octet-stream', blob: 'AAEC' } })).toEqual({
      type: 'text',
      text: '[MCP content dropped: resource blob with unsupported mimeType "application/octet-stream" (~0.0 MB, uri: file:///x.bin) was not delivered.]',
    });
    expect(convertMCPContentBlock({ type: 'resource_link', uri: 'https://example.com/p.png', mimeType: 'image/png' })).toEqual({
      type: 'image_url',
      source: { kind: 'url', url: 'https://example.com/p.png' },
    });
  }, 60_000);

  it('probes liveness, reconnects, and retries the call once after a transport failure', async () => {
    const marker = join(await tmpDir('mcp-die-'), 'died.marker');
    const started = await startApp({
      servers: { fake: stdioServer({ env: { FAKE_MCP_DIE_ONCE_FILE: marker } }) },
      script: (call) =>
        call.messages.at(-1)?.role === 'tool'
          ? { text: 'done' }
          : { toolCall: { name: 'mcp__fake__die_once', arguments: '{}' } },
    });
    try {
      await runTurn(started.main, 'call the flaky tool');
      const toolMessage = started.calls[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([{ type: 'text', text: 'survived' }]);
      expect(started.app.resolve(McpRef).list().map((entry) => entry.status)).toEqual(['connected']);
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('marks a 401 server needs-auth and fires an authorization URL from the authenticate tool', async () => {
    const base = await startFakeOAuthServer();
    const stateEvents: { server: string; state: string }[] = [];
    const authUrlEvents: { server: string; authorizationUrl: string }[] = [];
    let resolveAuthUrl: () => void = () => {};
    const authUrlSeen = new Promise<void>((resolve) => {
      resolveAuthUrl = resolve;
    });
    let offAll: () => void = () => {};
    try {
      const started = await startApp({
        host: null,
        servers: { auth: { transport: 'http', url: `${base.url}/mcp` } },
        beforeReady: (app, feature) => {
          const offState = app.on(feature, 'mcp.server.state', (event) => {
            stateEvents.push({ server: event.server, state: event.state });
          });
          const offAuth = app.on(feature, 'mcp.oauth.authorization_url', (event) => {
            authUrlEvents.push({ server: event.server, authorizationUrl: event.authorizationUrl });
            resolveAuthUrl();
          });
          offAll = () => {
            offState();
            offAuth();
          };
        },
        script: (call) =>
          call.messages.at(-1)?.role === 'tool'
            ? { text: 'done' }
            : { toolCall: { name: 'mcp__auth__authenticate', arguments: '{}' } },
      });
      try {
        const done = nextTurnDone(started.main);
        started.main.submit(createUserMessage('authenticate'));
        await authUrlSeen;
        started.main.abort();
        await done;
        expect(started.app.resolve(McpRef).list().map((entry) => entry.status)).toEqual(['needs-auth']);
        expect(toolNames(started.calls[0])).toContain('mcp__auth__authenticate');
        expect(stateEvents.some((event) => event.server === 'auth' && event.state === 'needs-auth')).toBe(true);
        expect(authUrlEvents[0]?.server).toBe('auth');
        expect(authUrlEvents[0]?.authorizationUrl.startsWith(`${base.url}/authorize?`)).toBe(true);
      } finally {
        await started.dispose();
      }
    } finally {
      offAll();
      await base.close();
    }
  }, 30_000);

  it('binds the mcp config section env and exposes the facade list/reconnect/reload', async () => {
    const started = await startApp({
      servers: { fake: stdioServer() },
      env: { KIMI_MCP_STARTUP_TIMEOUT_MS: '12345', KIMI_MCP_TOOL_TIMEOUT_MS: '2345' },
      script: () => ({ text: 'ok' }),
    });
    try {
      const section = started.app.resolve(ConfigRef).get<McpSection>('mcp');
      expect(section).toEqual({ startupTimeoutMs: 12345, toolTimeoutMs: 2345 });

      const facade = started.app.resolve(McpRef);
      expect(facade.list().map((entry) => entry.name)).toEqual(['fake']);
      await facade.reconnect('fake');
      expect(facade.list().map((entry) => entry.status)).toEqual(['connected']);

      await writeFile(
        join(started.homeDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            fake: { command: process.execPath, args: [fixturePath] },
            second: { command: process.execPath, args: [fixturePath] },
          },
        }),
      );
      await facade.reload();
      expect(facade.list().map((entry) => entry.name).toSorted()).toEqual(['fake', 'second']);

      await writeFile(join(started.homeDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
      await facade.reload();
      const afterRemoval = Object.fromEntries(facade.list().map((entry) => [entry.name, entry.status]));
      expect(afterRemoval).toEqual({ fake: 'connected', second: 'removed' });
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('merges contributed server sources beneath config files and tolerates source failures', async () => {
    const sourceFeature = createFeature('test-source', {
      app() {
        useMcpServerSource({
          id: 'test-source',
          load: async () => ({
            fromsource: stdioServer(),
            fake: { transport: 'stdio', command: 'definitely-not-a-real-command-xyz' },
          }),
        });
        useMcpServerSource({
          id: 'broken-source',
          load: async () => {
            throw new Error('source exploded');
          },
        });
      },
    });
    const started = await startApp({
      servers: { fake: stdioServer() },
      features: [sourceFeature],
      script: () => ({ text: 'ok' }),
    });
    try {
      const entries = Object.fromEntries(
        started.app.resolve(McpRef).list().map((entry) => [entry.name, entry.status]),
      );
      expect(entries).toEqual({ fake: 'connected', fromsource: 'connected' });
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('reloads when a contributed source signals a change', async () => {
    let current: Record<string, McpServerConfig> = {};
    const listeners = new Set<() => void>();
    const sourceFeature = createFeature('test-source', {
      app() {
        useMcpServerSource({
          id: 'test-source',
          load: async () => current,
          onDidChange: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        });
      },
    });
    const started = await startApp({
      features: [sourceFeature],
      script: () => ({ text: 'ok' }),
    });
    try {
      const facade = started.app.resolve(McpRef);
      expect(facade.list()).toEqual([]);
      current = { latesource: stdioServer() };
      for (const listener of listeners) listener();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const entries = Object.fromEntries(facade.list().map((entry) => [entry.name, entry.status]));
        if (entries['latesource'] === 'connected') return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('latesource did not connect after source change');
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('connects and disconnects ephemeral servers through the facade', async () => {
    const started = await startApp({
      script: (_call, index) =>
        index === 0
          ? { toolCall: { name: 'mcp__fake__echo', arguments: JSON.stringify({ text: 'hello-ephemeral' }) } }
          : { text: 'done' },
    });
    try {
      const facade = started.app.resolve(McpRef);
      expect(facade.list()).toEqual([]);
      await facade.connect('fake', stdioServer());
      expect(facade.list()).toEqual([
        { name: 'fake', transport: 'stdio', status: 'connected', toolCount: 5, error: undefined },
      ]);
      await facade.connect('fake', stdioServer());
      expect(facade.list()).toEqual([
        { name: 'fake', transport: 'stdio', status: 'connected', toolCount: 5, error: undefined },
      ]);
      await runTurn(started.main, 'call the ephemeral tool');
      expect(toolNames(started.calls[0])).not.toContain('mcp__fake__echo');
      expect(dynamicToolNames(started.calls[1])).toContain('mcp__fake__echo');
      const toolMessage = started.calls[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([{ type: 'text', text: 'hello-ephemeral' }]);
      await facade.disconnect('fake');
      expect(facade.list().map((entry) => [entry.name, entry.status])).toEqual([
        ['fake', 'removed'],
      ]);
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('keeps ephemeral servers across reloads and lets config files win name collisions', async () => {
    const started = await startApp({ script: () => ({ text: 'ok' }) });
    try {
      const facade = started.app.resolve(McpRef);
      await facade.connect('fake', stdioServer());
      await writeFile(
        join(started.homeDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: { second: { command: process.execPath, args: [fixturePath] } },
        }),
      );
      await facade.reload();
      expect(Object.fromEntries(facade.list().map((entry) => [entry.name, entry.status]))).toEqual(
        { fake: 'connected', second: 'connected' },
      );
      await writeFile(
        join(started.homeDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: { fake: { command: 'definitely-not-a-real-command-xyz' } },
        }),
      );
      await facade.reload();
      expect(Object.fromEntries(facade.list().map((entry) => [entry.name, entry.status]))).toEqual(
        { fake: 'failed', second: 'removed' },
      );
      await writeFile(join(started.homeDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
      await facade.reload();
      expect(Object.fromEntries(facade.list().map((entry) => [entry.name, entry.status]))).toEqual(
        { fake: 'connected', second: 'removed' },
      );
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('scopes cwd-bound ephemeral servers to matching sessions and hides them elsewhere', async () => {
    const started = await startApp({
      script: (_call, index) =>
        index === 0
          ? { toolCall: { name: 'mcp__fake__echo', arguments: JSON.stringify({ text: 'hello-alpha' }) } }
          : { text: 'done' },
      sessionCwd: (sessionId) => (sessionId === 'sess' ? '/work/alpha' : '/work/beta'),
    });
    const backend = new MemoryBackend();
    const trees = await Trees.open(backend.trees, {});
    const storesB = await openSessionStores(await trees.tree('sess-b'), openBlobs(backend.blobs));
    try {
      const sessionB = await started.app.create({ sessionId: 'sess-b', stores: storesB });
      const mainB = await sessionB.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
      const facade = started.app.resolve(McpRef);
      await facade.connect('fake', stdioServer(), { cwd: '/work/alpha' });
      expect(facade.list().map((entry) => entry.status)).toEqual(['connected']);
      await runTurn(started.main, 'alpha turn');
      expect(dynamicToolNames(started.calls[1])).toContain('mcp__fake__echo');
      const toolMessage = started.calls[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([{ type: 'text', text: 'hello-alpha' }]);
      await runTurn(mainB, 'beta turn');
      expect(toolNames(started.calls[2])).not.toContain('mcp__fake__echo');
      expect(dynamicToolNames(started.calls[2])).not.toContain('mcp__fake__echo');
    } finally {
      await started.dispose();
      await storesB.dispose();
    }
  }, 30_000);

  it('manages servers through the management facade with persistence, read-only guards, and redaction', async () => {
    const started = await startApp({
      servers: { propsone: stdioServer({ env: { SECRET: 's3cret' } }) },
      trusted: true,
      script: () => ({ text: 'ok' }),
    });
    try {
      const facade = started.app.resolve(McpRef);
      const initial = await facade.listServers();
      expect(initial).toHaveLength(1);
      expect(initial[0]).toMatchObject({
        name: 'propsone',
        source: 'global',
        origin: 'props',
        mutable: false,
      });
      expect(initial[0]?.config).toMatchObject({ transport: 'stdio', envKeys: ['SECRET'] });
      expect((initial[0]?.config as Record<string, unknown>)['env']).toBeUndefined();

      const userPath = join(started.homeDir, 'mcp.json');
      const added = await facade.addServer({ name: 'fake', ...stdioServer() });
      expect(added.find((server) => server.name === 'fake')).toMatchObject({
        source: 'global',
        origin: userPath,
        mutable: true,
      });
      const onDisk = JSON.parse(await readFile(userPath, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(onDisk.mcpServers)).toEqual(['fake']);
      expect(facade.list().map((entry) => [entry.name, entry.status])).toContainEqual([
        'fake',
        'connected',
      ]);

      const duplicate = await facade
        .addServer({ name: 'fake', ...stdioServer() })
        .catch((error: unknown) => error);
      expect(duplicate).toMatchObject({ code: 'mcp.request_invalid' });
      expect((duplicate as Error).message).toBe('MCP server "fake" already exists');

      const missingUpdate = await facade
        .updateServer({ name: 'ghost', ...stdioServer() })
        .catch((error: unknown) => error);
      expect(missingUpdate).toMatchObject({ code: 'mcp.server_not_found' });
      expect((missingUpdate as Error).message).toBe('MCP server "ghost" was not found');

      const projectPath = join(started.workDir, '.mcp.json');
      await writeFile(
        projectPath,
        JSON.stringify({ mcpServers: { fake: { command: 'shadow-cmd' } } }),
      );
      const readOnly = await facade
        .updateServer({ name: 'fake', ...stdioServer() })
        .catch((error: unknown) => error);
      expect(readOnly).toMatchObject({ code: 'mcp.request_invalid' });
      expect((readOnly as Error).message).toBe(
        `MCP server "fake" is read-only: it is defined in ${projectPath} — edit that file instead`,
      );
      expect(await facade.getServer('fake')).toMatchObject({ origin: projectPath, mutable: false });
      await rm(projectPath);

      const updated = await facade.updateServer({
        name: 'fake',
        ...stdioServer({ env: { KEY: 'value' } }),
      });
      expect(updated.find((server) => server.name === 'fake')?.config).toMatchObject({
        env: { KEY: 'value' },
      });

      const afterRemove = await facade.removeServer('fake');
      expect(afterRemove.some((server) => server.name === 'fake')).toBe(false);
      expect(facade.list().map((entry) => [entry.name, entry.status])).toContainEqual([
        'fake',
        'removed',
      ]);
      await facade.removeServer('ghost');
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('tests connection targets and removes ephemeral servers through the management facade', async () => {
    const started = await startApp({
      servers: { propsone: stdioServer() },
      script: () => ({ text: 'ok' }),
    });
    try {
      const facade = started.app.resolve(McpRef);

      const inline = await facade.testServer({ server: { name: 'probe', ...stdioServer() } });
      expect(inline.success).toBe(true);
      expect(inline.output).toContain('Connected to MCP server "probe".');
      expect(inline.output).toContain('Available tools: 5');
      expect(inline.output).toContain('- echo: Echo back the provided text.');

      expect((await facade.testServer({ name: 'propsone' })).success).toBe(true);

      const unknown = await facade.testServer({ name: 'ghost' }).catch((error: unknown) => error);
      expect(unknown).toMatchObject({ code: 'mcp.server_not_found' });

      const empty = await facade.testServer({}).catch((error: unknown) => error);
      expect(empty).toMatchObject({ code: 'mcp.request_invalid' });
      expect((empty as Error).message).toBe('Pass an MCP server name or an inline server config');

      const both = await facade
        .testServer({ name: 'propsone', server: { name: 'other', ...stdioServer() } })
        .catch((error: unknown) => error);
      expect(both).toMatchObject({ code: 'mcp.request_invalid' });

      const failing = await facade.testServer({
        server: { name: 'bad', transport: 'stdio', command: 'definitely-not-a-real-command-xyz' },
      });
      expect(failing.success).toBe(false);
      expect(failing.output.length).toBeGreaterThan(0);

      await facade.connect('eph', stdioServer());
      expect((await facade.listServers()).find((server) => server.name === 'eph')).toMatchObject({
        source: 'caller',
        origin: 'caller',
        mutable: false,
      });
      expect((await facade.getServer('eph')).source).toBe('caller');
      await facade.removeServer('eph');
      expect((await facade.listServers()).some((server) => server.name === 'eph')).toBe(false);
      expect(facade.list().map((entry) => [entry.name, entry.status])).toContainEqual([
        'eph',
        'removed',
      ]);
    } finally {
      await started.dispose();
    }
  }, 60_000);

  it('inspects the server catalog and reports oauth auth statuses', async () => {
    const base = await startFakeOAuthServer();
    try {
      const started = await startApp({
        host: null,
        servers: {
          fake: stdioServer(),
          web: { transport: 'http', url: `${base.url}/mcp` },
        },
        script: () => ({ text: 'ok' }),
      });
      try {
        const facade = started.app.resolve(McpRef);
        const inspections = await facade.inspectServers();
        expect(inspections).toHaveLength(2);
        const fake = inspections.find((inspection) => inspection.runtimeName === 'fake');
        expect(fake).toMatchObject({
          serverId: 'global:fake',
          locator: { source: 'global', name: 'fake' },
          runtimeName: 'fake',
          origin: 'global',
          enabled: true,
          editable: false,
          authStatus: 'not-applicable',
        });
        expect(fake?.checkedAt).toBeUndefined();
        expect(fake?.config).toMatchObject({ transport: 'stdio', command: process.execPath });
        const web = inspections.find((inspection) => inspection.runtimeName === 'web');
        expect(web).toMatchObject({
          serverId: 'global:web',
          canonicalUrl: `${base.url}/mcp`,
          authStatus: 'oauth-required',
          editable: false,
        });
        expect(typeof web?.checkedAt).toBe('number');

        const targeted = await facade.inspectServers([{ source: 'global', name: 'fake' }]);
        expect(targeted.map((inspection) => inspection.runtimeName)).toEqual(['fake']);
        const miss = await facade
          .inspectServers([{ source: 'global', name: 'ghost' }])
          .catch((error: unknown) => error);
        expect(miss).toMatchObject({ code: 'mcp.server_not_found' });
        expect((miss as Error).message).toBe('MCP server "ghost" was not found');

        const offline = await facade.listAuthStatuses({ verify: false });
        expect(offline).toEqual([
          { name: 'fake', authStatus: 'not-applicable' },
          { name: 'web', authStatus: 'not-applicable' },
        ]);
        const verified = await facade.listAuthStatuses({ verify: true });
        expect(verified).toEqual([
          { name: 'fake', authStatus: 'not-applicable' },
          { name: 'web', authStatus: 'oauth-required' },
        ]);
      } finally {
        await started.dispose();
      }
    } finally {
      await base.close();
    }
  }, 60_000);

  it('runs the management oauth flow lifecycle', async () => {
    const base = await startFakeOAuthServer();
    try {
      const started = await startApp({
        host: null,
        servers: {
          auth: { transport: 'http', url: `${base.url}/mcp` },
          fake: stdioServer(),
        },
        script: () => ({ text: 'ok' }),
      });
      try {
        const facade = started.app.resolve(McpRef);
        const begin = await facade.beginServerAuth({ source: 'global', name: 'auth' });
        if (begin.status !== 'authorization-required') {
          throw new Error(`expected authorization-required, got ${begin.status}`);
        }
        expect(begin.authorizationUrl.startsWith(`${base.url}/authorize?`)).toBe(true);
        expect(begin.flowId.length).toBeGreaterThan(0);

        const unknown = await facade
          .completeServerAuth({ flowId: 'unknown-flow' })
          .catch((error: unknown) => error);
        expect(unknown).toMatchObject({ code: 'mcp.request_invalid' });
        expect((unknown as Error).message).toBe('Unknown MCP OAuth flow: unknown-flow');

        const timedOut = await facade
          .completeServerAuth({ flowId: begin.flowId, timeoutMs: 50 })
          .catch((error: unknown) => error);
        expect(timedOut).toMatchObject({ code: 'mcp.oauth_failed' });
        expect((timedOut as Error).message).toContain('OAuth flow for "auth" failed');

        const beginAgain = await facade.beginServerAuth({ source: 'global', name: 'auth' });
        if (beginAgain.status !== 'authorization-required') {
          throw new Error(`expected authorization-required, got ${beginAgain.status}`);
        }
        await facade.cancelServerAuth({ flowId: beginAgain.flowId });
        await facade.cancelServerAuth({ flowId: 'unknown-flow' });
        await facade.resetServerAuth({ source: 'global', name: 'auth' });

        const stdio = await facade
          .beginServerAuth({ source: 'global', name: 'fake' })
          .catch((error: unknown) => error);
        expect(stdio).toMatchObject({ code: 'mcp.request_invalid' });
        expect((stdio as Error).message).toBe('MCP server "fake" does not use a remote transport');

        const missing = await facade
          .beginServerAuth({ source: 'global', name: 'ghost' })
          .catch((error: unknown) => error);
        expect(missing).toMatchObject({ code: 'mcp.server_not_found' });
      } finally {
        await started.dispose();
      }
    } finally {
      await base.close();
    }
  }, 60_000);
});

async function startFakeOAuthServer(): Promise<{ url: string; dir: string; close: () => Promise<void> }> {
  const dir = await tmpDir('mcp-oauth-');
  let base = '';
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(404).end();
      return;
    }
    if (path.startsWith('/.well-known/oauth-authorization-server')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }
    if (path === '/register' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        res.writeHead(201, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ...body, client_id: 'fake-client-id', client_id_issued_at: 1700000000 }),
        );
      });
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: base,
    dir,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
