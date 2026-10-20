import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { memoryBlobBackend } from '@moonshot-ai/agent-core/blob/backend/memory';
import { openBlobStore } from '@moonshot-ai/agent-core/blob/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import {
  createAssistantMessage,
  createUserMessage,
  type Message,
  type ToolCall,
  type ToolDescription,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  type Harness,
} from '#/runtime/index';
import { ConfigRef, createConfig, type ConfigPersist, type ConfigStore } from '#/features/config/index';
import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
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
  type McpEvent,
  type McpFacade,
  type McpMediaStore,
  type McpSection,
  type McpServerConfig,
  type McpServerStdioConfig,
} from '#/features/mcp/index';

const FAKE_MCP_SERVER_BASE64 =
  'aW1wb3J0IHsgY3JlYXRlSW50ZXJmYWNlIH0gZnJvbSAnbm9kZTpyZWFkbGluZSc7CmltcG9ydCB7IGV4aXN0c1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJzsKCmNvbnN0IFRJTllfUE5HX0JBU0U2NCA9CiAgJ2lWQk9SdzBLR2dvQUFBQU5TVWhFVWdBQUFBRUFBQUFCQ0FZQUFBQWZGY1NKQUFBQURVbEVRVlI0Mm1OaytNOVFEd0FEaGdHQVdqUjlhd0FBQUFCSlJVNUVya0pnZ2c9PSc7Cgpjb25zdCBkZWZhdWx0VG9vbHMgPSBbCiAgewogICAgbmFtZTogJ2VjaG8nLAogICAgZGVzY3JpcHRpb246ICdFY2hvIGJhY2sgdGhlIHByb3ZpZGVkIHRleHQuJywKICAgIGlucHV0U2NoZW1hOiB7CiAgICAgIHR5cGU6ICdvYmplY3QnLAogICAgICBwcm9wZXJ0aWVzOiB7IHRleHQ6IHsgdHlwZTogJ3N0cmluZycgfSB9LAogICAgfSwKICB9LAogIHsKICAgIG5hbWU6ICdpbWFnZScsCiAgICBkZXNjcmlwdGlvbjogJ1JldHVybiBhIHRpbnkgUE5HIGltYWdlLicsCiAgICBpbnB1dFNjaGVtYTogeyB0eXBlOiAnb2JqZWN0JywgcHJvcGVydGllczoge30gfSwKICB9LAogIHsKICAgIG5hbWU6ICdiaWcnLAogICAgZGVzY3JpcHRpb246ICdSZXR1cm4gYW4gb3ZlcnNpemVkIGltYWdlIHBheWxvYWQuJywKICAgIGlucHV0U2NoZW1hOiB7IHR5cGU6ICdvYmplY3QnLCBwcm9wZXJ0aWVzOiB7fSB9LAogIH0sCiAgewogICAgbmFtZTogJ3N0cnVjdHVyZWQnLAogICAgZGVzY3JpcHRpb246ICdSZXR1cm4gc3RydWN0dXJlZCBjb250ZW50IHdpdGggbWV0YS4nLAogICAgaW5wdXRTY2hlbWE6IHsgdHlwZTogJ29iamVjdCcsIHByb3BlcnRpZXM6IHt9IH0sCiAgfSwKICB7CiAgICBuYW1lOiAnZGllX29uY2UnLAogICAgZGVzY3JpcHRpb246ICdDcmFzaCB0aGUgc2VydmVyIG9uIHRoZSBmaXJzdCBjYWxsLCBzdWNjZWVkIGFmdGVyd2FyZHMuJywKICAgIGlucHV0U2NoZW1hOiB7IHR5cGU6ICdvYmplY3QnLCBwcm9wZXJ0aWVzOiB7fSB9LAogIH0sCl07Cgpjb25zdCB0b29scyA9IHByb2Nlc3MuZW52LkZBS0VfTUNQX1RPT0xTCiAgPyBKU09OLnBhcnNlKHByb2Nlc3MuZW52LkZBS0VfTUNQX1RPT0xTKQogIDogZGVmYXVsdFRvb2xzOwoKaWYgKHByb2Nlc3MuZW52LkZBS0VfTUNQX1NUREVSUikgewogIHByb2Nlc3Muc3RkZXJyLndyaXRlKHByb2Nlc3MuZW52LkZBS0VfTUNQX1NUREVSUik7Cn0KCmZ1bmN0aW9uIHJlc3VsdChpZCwgdmFsdWUpIHsKICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh7IGpzb25ycGM6ICcyLjAnLCBpZCwgcmVzdWx0OiB2YWx1ZSB9KX1cbmApOwp9CgpmdW5jdGlvbiBlcnJvcihpZCwgY29kZSwgbWVzc2FnZSkgewogIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsganNvbnJwYzogJzIuMCcsIGlkLCBlcnJvcjogeyBjb2RlLCBtZXNzYWdlIH0gfSl9XG5gKTsKfQoKZnVuY3Rpb24gY2FsbFRvb2wobmFtZSwgYXJncykgewogIGlmIChuYW1lID09PSAnZWNobycpIHsKICAgIHJldHVybiB7IGNvbnRlbnQ6IFt7IHR5cGU6ICd0ZXh0JywgdGV4dDogdHlwZW9mIGFyZ3M/LnRleHQgPT09ICdzdHJpbmcnID8gYXJncy50ZXh0IDogSlNPTi5zdHJpbmdpZnkoYXJncyA/PyB7fSkgfV0gfTsKICB9CiAgaWYgKG5hbWUgPT09ICdpbWFnZScpIHsKICAgIHJldHVybiB7IGNvbnRlbnQ6IFt7IHR5cGU6ICdpbWFnZScsIGRhdGE6IFRJTllfUE5HX0JBU0U2NCwgbWltZVR5cGU6ICdpbWFnZS9wbmcnIH1dIH07CiAgfQogIGlmIChuYW1lID09PSAnYmlnJykgewogICAgcmV0dXJuIHsKICAgICAgY29udGVudDogWwogICAgICAgIHsKICAgICAgICAgIHR5cGU6ICdpbWFnZScsCiAgICAgICAgICBkYXRhOiBCdWZmZXIuYWxsb2MoMTEgKiAxMDI0ICogMTAyNCkudG9TdHJpbmcoJ2Jhc2U2NCcpLAogICAgICAgICAgbWltZVR5cGU6ICdpbWFnZS9wbmcnLAogICAgICAgIH0sCiAgICAgIF0sCiAgICB9OwogIH0KICBpZiAobmFtZSA9PT0gJ3N0cnVjdHVyZWQnKSB7CiAgICByZXR1cm4gewogICAgICBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcsIHRleHQ6ICd7Im9rIjp0cnVlfScgfV0sCiAgICAgIHN0cnVjdHVyZWRDb250ZW50OiB7IG9rOiB0cnVlLCBleHRyYTogJ3llcycgfSwKICAgICAgX21ldGE6IHsgJ21jcC5pbnRlcm5hbC9zZWNyZXQnOiAxLCAnZXhhbXBsZS5jb20vY3VzdG9tJzogMiB9LAogICAgfTsKICB9CiAgaWYgKG5hbWUgPT09ICdkaWVfb25jZScpIHsKICAgIGNvbnN0IG1hcmtlciA9IHByb2Nlc3MuZW52LkZBS0VfTUNQX0RJRV9PTkNFX0ZJTEU7CiAgICBpZiAobWFya2VyICE9PSB1bmRlZmluZWQgJiYgIWV4aXN0c1N5bmMobWFya2VyKSkgewogICAgICB3cml0ZUZpbGVTeW5jKG1hcmtlciwgJ2RpZWQnKTsKICAgICAgcHJvY2Vzcy5leGl0KDIpOwogICAgfQogICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogJ3RleHQnLCB0ZXh0OiAnc3Vydml2ZWQnIH1dIH07CiAgfQogIHJldHVybiB1bmRlZmluZWQ7Cn0KCmNvbnN0IHJsID0gY3JlYXRlSW50ZXJmYWNlKHsgaW5wdXQ6IHByb2Nlc3Muc3RkaW4gfSk7CgpybC5vbignbGluZScsIChsaW5lKSA9PiB7CiAgaWYgKGxpbmUudHJpbSgpLmxlbmd0aCA9PT0gMCkgcmV0dXJuOwogIGxldCBtZXNzYWdlOwogIHRyeSB7CiAgICBtZXNzYWdlID0gSlNPTi5wYXJzZShsaW5lKTsKICB9IGNhdGNoIHsKICAgIHJldHVybjsKICB9CiAgaWYgKG1lc3NhZ2UuaWQgPT09IHVuZGVmaW5lZCkgcmV0dXJuOwogIGlmIChtZXNzYWdlLm1ldGhvZCA9PT0gJ2luaXRpYWxpemUnKSB7CiAgICByZXN1bHQobWVzc2FnZS5pZCwgewogICAgICBwcm90b2NvbFZlcnNpb246ICcyMDI0LTExLTA1JywKICAgICAgY2FwYWJpbGl0aWVzOiB7IHRvb2xzOiB7fSB9LAogICAgICBzZXJ2ZXJJbmZvOiB7IG5hbWU6ICdmYWtlLW1jcCcsIHZlcnNpb246ICcwLjAuMScgfSwKICAgIH0pOwogICAgcmV0dXJuOwogIH0KICBpZiAobWVzc2FnZS5tZXRob2QgPT09ICdwaW5nJykgewogICAgcmVzdWx0KG1lc3NhZ2UuaWQsIHt9KTsKICAgIHJldHVybjsKICB9CiAgaWYgKG1lc3NhZ2UubWV0aG9kID09PSAndG9vbHMvbGlzdCcpIHsKICAgIHJlc3VsdChtZXNzYWdlLmlkLCB7IHRvb2xzIH0pOwogICAgcmV0dXJuOwogIH0KICBpZiAobWVzc2FnZS5tZXRob2QgPT09ICd0b29scy9jYWxsJykgewogICAgY29uc3QgbmFtZSA9IG1lc3NhZ2UucGFyYW1zPy5uYW1lOwogICAgY29uc3QgdmFsdWUgPSBjYWxsVG9vbChuYW1lLCBtZXNzYWdlLnBhcmFtcz8uYXJndW1lbnRzKTsKICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7CiAgICAgIGVycm9yKG1lc3NhZ2UuaWQsIC0zMjYwMSwgYHVua25vd24gdG9vbDogJHtTdHJpbmcobmFtZSl9YCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHJlc3VsdChtZXNzYWdlLmlkLCB2YWx1ZSk7CiAgICByZXR1cm47CiAgfQogIGVycm9yKG1lc3NhZ2UuaWQsIC0zMjYwMSwgYHVua25vd24gbWV0aG9kOiAke1N0cmluZyhtZXNzYWdlLm1ldGhvZCl9YCk7Cn0pOwo=';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let fixturePath = '';

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-fixture-'));
  fixturePath = join(dir, 'fake-mcp-server.mjs');
  await writeFile(fixturePath, Buffer.from(FAKE_MCP_SERVER_BASE64, 'base64'));
});

afterAll(async () => {
  await rm(dirname(fixturePath), { recursive: true, force: true });
});

interface LlmCall {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall, index: number) => { text: string } | { toolCall: { name: string; arguments: string } };

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function createMockRequester(script: LlmScript): { requester: LoopLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, _control) => {
      const call: LlmCall = {
        messages: rest.content?.messages ?? [],
        tools: rest.profile?.tools ?? [],
      };
      calls.push(call);
      const out = script(call, calls.length - 1);
      if ('toolCall' in out) {
        return textOutcome('', [
          {
            type: 'function',
            id: `call-${calls.length}`,
            name: out.toolCall.name,
            arguments: out.toolCall.arguments,
          },
        ]);
      }
      return textOutcome(out.text);
    },
  };
  return { calls, requester: self };
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

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface StartedApp {
  readonly harness: Harness;
  readonly agent: Agent;
  readonly calls: LlmCall[];
  readonly requester: LoopLlmRequester;
  readonly workDir: string;
  readonly homeDir: string;
  readonly feature: Feature<void, McpEvent>;
  readonly facade: () => McpFacade;
  readonly config: () => ConfigStore;
  readonly dispose: () => Promise<void>;
}

async function startApp(opts: {
  readonly script: LlmScript;
  readonly servers?: Record<string, McpServerConfig>;
  readonly trusted?: boolean;
  readonly mediaStore?: McpMediaStore;
  readonly host?: OsHost | null;
  readonly env?: Record<string, string>;
  readonly features?: readonly Feature<any, any>[];
  readonly sessionCwd?: (sessionId: string) => string | undefined;
  readonly beforeReady?: (harness: Harness, feature: Feature<void, McpEvent>) => void;
}): Promise<StartedApp> {
  const workDir = await tmpDir('mcp-work-');
  const homeDir = await tmpDir('mcp-home-');
  const harness = createHarness({ space: memoryHarnessSpace() });
  const feature = createMcp({
    workDir,
    home: homeDir,
    host: opts.host === null ? undefined : (opts.host ?? createNodeOsHost()),
    trusted: opts.trusted,
    servers: opts.servers,
    mediaStore: opts.mediaStore,
    sessionCwd: opts.sessionCwd,
  });
  let mcpFace: Readonly<ShallowRef<McpFacade | undefined>> | undefined;
  let configFace: Readonly<ShallowRef<ConfigStore | undefined>> | undefined;
  const probe = createFeature('mcp-probe', {
    app() {
      mcpFace = useInject(McpRef);
      configFace = useInject(ConfigRef);
    },
  });
  await harness.app.features.add(createConfig({ persist: fakePersist(), env: opts.env }));
  for (const extra of opts.features ?? []) await harness.app.features.add(extra);
  await harness.app.features.add(feature);
  await harness.app.features.add(probe);
  opts.beforeReady?.(harness, feature);
  const { requester, calls } = createMockRequester(opts.script);
  const session = await harness.app.create({ sessionId: 'sess' });
  const agent = await harness.ensureAgent(session, 'main', { systemPrompt: 'main-host' });
  setRequester(harness, 'sess', 'main', requester);
  const facade = (): McpFacade => {
    const face = mcpFace?.value;
    if (face === undefined) throw new Error('McpRef was not exposed');
    return face;
  };
  await facade().listAuthStatuses({ verify: false });
  const config = (): ConfigStore => {
    const store = configFace?.value;
    if (store === undefined) throw new Error('ConfigRef was not exposed');
    return store;
  };
  return {
    harness,
    agent,
    calls,
    requester,
    workDir,
    homeDir,
    feature,
    facade,
    config,
    dispose: () => harness.close(),
  };
}

async function runTurn(agent: Agent, text: string): Promise<void> {
  const outcome = await agent.loop.runTurn(user(text));
  if (outcome.type !== 'done') throw new Error(`turn ended as ${outcome.type}`);
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
      await waitFor(
        () => started.facade().list()[0]?.status === 'connected',
        'fake server to connect',
      );
      await runTurn(started.agent, 'call echo');
      expect(toolNames(started.calls[0])).toContain('mcp__fake__echo');
      const toolMessage = started.calls[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([{ type: 'text', text: 'hello-mcp' }]);
      const entries = started.facade().list();
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
      await waitFor(
        () => started.facade().list()[0]?.status === 'failed',
        'fake server to fail',
      );
      await runTurn(started.agent, 'hi');
      const [entry] = started.facade().list();
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
      await waitFor(
        () => started.facade().list()[0]?.status === 'connected',
        'fake server to connect',
      );
      await runTurn(started.agent, 'call the deferred tool by name');
      for (const call of started.calls) {
        expect(toolNames(call)).not.toContain('mcp__fake__echo');
      }
      const toolMessage = started.calls[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([{ type: 'text', text: 'hello-deferred' }]);
      expect(dynamicToolNames(started.calls[1])).toContain('mcp__fake__echo');
      await started.agent.flush();
      const history = started.agent.view.getState().messages;
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
      await runTurn(started.agent, 'before the server exists');
      expect(toolNames(started.calls[0])).not.toContain('mcp__fake__echo');
      await writeFile(
        join(started.homeDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [fixturePath] } } }),
      );
      await started.facade().reload();
      expect(started.facade().list().map((entry) => entry.status)).toEqual(['connected']);
      await runTurn(started.agent, 'call the late tool by name');
      expect(dynamicToolNames(started.calls[1])).toContain('mcp__fake__echo');
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

    const store = openBlobStore(memoryBlobBackend(new Map()));
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
    expect(mediaPart.source.ref).toMatch(/^[0-9a-f]{64}$/);
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
      await waitFor(
        () => started.facade().list()[0]?.status === 'connected',
        'fake server to connect',
      );
      await runTurn(started.agent, 'call the flaky tool');
      const toolMessage = started.calls[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([{ type: 'text', text: 'survived' }]);
      expect(started.facade().list().map((entry) => entry.status)).toEqual(['connected']);
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
        beforeReady: (harness, feature) => {
          const offState = harness.app.on(feature, 'mcp.server.state', (event) => {
            stateEvents.push({ server: event.server, state: event.state });
          });
          const offAuth = harness.app.on(feature, 'mcp.oauth.authorization_url', (event) => {
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
        await waitFor(
          () => started.facade().list()[0]?.status === 'needs-auth',
          'auth server to be marked needs-auth',
        );
        const turn = started.agent.loop.runTurn(user('authenticate'));
        await authUrlSeen;
        started.agent.loop.abort();
        await turn;
        expect(started.facade().list().map((entry) => entry.status)).toEqual(['needs-auth']);
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
      await waitFor(
        () => started.config().get<McpSection>('mcp').startupTimeoutMs === 12345,
        'mcp config section to bind env',
      );
      const section = started.config().get<McpSection>('mcp');
      expect(section).toEqual({ startupTimeoutMs: 12345, toolTimeoutMs: 2345 });

      const facade = started.facade();
      await waitFor(
        () => facade.list()[0]?.status === 'connected',
        'fake server to connect',
      );
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
      await waitFor(
        () => started.facade().list().filter((entry) => entry.status === 'connected').length === 2,
        'both servers to connect',
      );
      const entries = Object.fromEntries(
        started.facade().list().map((entry) => [entry.name, entry.status]),
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
      const facade = started.facade();
      expect(facade.list()).toEqual([]);
      current = { latesource: stdioServer() };
      for (const listener of listeners) listener();
      await waitFor(
        () => facade.list().some((entry) => entry.name === 'latesource' && entry.status === 'connected'),
        'latesource to connect after source change',
      );
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
      const facade = started.facade();
      expect(facade.list()).toEqual([]);
      await facade.connect('fake', stdioServer());
      expect(facade.list()).toEqual([
        { name: 'fake', transport: 'stdio', status: 'connected', toolCount: 5, error: undefined },
      ]);
      await facade.connect('fake', stdioServer());
      expect(facade.list()).toEqual([
        { name: 'fake', transport: 'stdio', status: 'connected', toolCount: 5, error: undefined },
      ]);
      await runTurn(started.agent, 'call the ephemeral tool');
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
      const facade = started.facade();
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
    const sessionB = await started.harness.app.create({ sessionId: 'sess-b' });
    const mainB = await started.harness.ensureAgent(sessionB, 'main', { systemPrompt: 'main-host' });
    setRequester(started.harness, 'sess-b', 'main', started.requester);
    try {
      const facade = started.facade();
      await facade.connect('fake', stdioServer(), { cwd: '/work/alpha' });
      expect(facade.list().map((entry) => entry.status)).toEqual(['connected']);
      await runTurn(started.agent, 'alpha turn');
      expect(dynamicToolNames(started.calls[1])).toContain('mcp__fake__echo');
      const toolMessage = started.calls[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([{ type: 'text', text: 'hello-alpha' }]);
      await runTurn(mainB, 'beta turn');
      expect(toolNames(started.calls[2])).not.toContain('mcp__fake__echo');
      expect(dynamicToolNames(started.calls[2])).not.toContain('mcp__fake__echo');
    } finally {
      await started.dispose();
    }
  }, 30_000);

  it('manages servers through the management facade with persistence, read-only guards, and redaction', async () => {
    const started = await startApp({
      servers: { propsone: stdioServer({ env: { SECRET: 's3cret' } }) },
      trusted: true,
      script: () => ({ text: 'ok' }),
    });
    try {
      const facade = started.facade();
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
      const facade = started.facade();

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
        const facade = started.facade();
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
        const facade = started.facade();
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

async function startFakeOAuthServer(): Promise<{ url: string; close: () => Promise<void> }> {
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
