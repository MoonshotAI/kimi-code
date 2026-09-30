import { PassThrough, Readable, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ClientSideConnection,
  ndJsonStream,
  type ClientCapabilities,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { Jimp } from 'jimp';
import {
  createFeature,
  createMemoryUploadCache,
  createUserMessage,
  MAIN_AGENT_ID,
  memorySessionSpace,
  createHarness,
  providerCatalog,
  useAgent,
  useAgentTools,
  useProvider,
  type AppHandle,
  type CatalogModelConfig,
  type CatalogModelDefinition,
  type FeatureSpec,
  type LlmRemoteErrorMessage,
  type AgentLlmRequester,
  type CatalogProviderHandle,
  type Message,
  type ModelCapability,
  type StoredContent,
  type StreamedMessagePart,
  type AssistantMessage,
  type ContentPart,
  type ToolCall,
  type LlmOutcome,
  createAssistantMessage,
} from '@moonshot-ai/agent-core';
import { afterEach, describe, expect, it } from 'vitest';

import { createAcp } from '#/feature-acp/index';
import { createAcpOsHost, createAcpOsHostRouter, type AcpOsConnection } from '#/feature-acp/os-host';
import { buildAcpSkillSlashCommands, resolveSkillCommand } from '#/feature-acp/slash';
import { interaction } from '#/features/interaction/index';
import { createMedia, type MediaStore } from '#/features/media/index';
import { createMcp, McpRef, type McpServerConfig } from '#/features/mcp/index';
import { createNodeOsHost } from '#/features/os/host/index';
import { createPermission, PermissionRef } from '#/features/permission/index';
import { createMemoryPlanStorage, createPlan, PlanRef } from '#/features/plan/index';
import {
  createSkill,
  useSkillSource,
  type SkillDefinition,
  type SkillSource,
  type SkillSummary,
} from '#/features/skill/index';
import { todo as todoFeature } from '#/features/todo/index';
import { usage } from '#/features/usage/index';

import { failureOutcome, testModel } from './fake-llm';
import { createMemoryMediaStore } from './fake-media';

const fixturePath = fileURLToPath(new URL('./features/fixtures/fake-mcp-server.mjs', import.meta.url));

type ScriptStep = { parts: StreamedMessagePart[] } | { hang: true } | { fail: LlmRemoteErrorMessage };

let queue: ScriptStep[] = [];
let callSeq = 0;
let callCount = 0;
let llmCalls: Array<{ messages: Message[]; thinking?: string | undefined }> = [];

function messageFromParts(parts: StreamedMessagePart[]): AssistantMessage {
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  for (const part of parts) {
    if (part.type === 'function') {
      toolCalls.push(part);
      continue;
    }
    if (part.type === 'tool_call_part') {
      const target = toolCalls.at(-1);
      if (target !== undefined && part.argumentsPart !== null) {
        toolCalls[toolCalls.length - 1] = {
          ...target,
          arguments: (target.arguments ?? '') + part.argumentsPart,
        };
      }
      continue;
    }
    content.push(part);
  }
  return createAssistantMessage(content, toolCalls);
}

function createMockRequester(): AgentLlmRequester {
  const requester: AgentLlmRequester = {
    with: () => requester,
    request: () => {
      throw new Error('fake requester cannot build wire requests');
    },
    generate: async (rest, { onEvent, signal }) => {
      callCount += 1;
      llmCalls.push({
        messages: [...(rest.content?.messages ?? [])],
        thinking: rest.model?.thinking?.effort,
      });
      const step = queue.shift() ?? { parts: [{ type: 'text', text: 'done' }] };
      if ('hang' in step) {
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        throw new Error('unreachable');
      }
      if ('fail' in step) {
        const failed = failureOutcome(step.fail);
        onEvent?.({ type: 'llm.ended', outcome: failed });
        return failed;
      }
      for (const part of step.parts) {
        onEvent?.({ type: 'llm.streaming.part', part });
      }
      onEvent?.({
        type: 'llm.streaming.usage',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      const outcome: LlmOutcome = { type: 'done', message: messageFromParts(step.parts) };
      onEvent?.({ type: 'llm.ended', outcome });
      return outcome;
    },
  };
  return requester;
}

function bindTestLlm(requester: AgentLlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
      agent.setRequester(requester);
    },
  });
}

function contributeTestProvider(
  requester: AgentLlmRequester,
  extraModels: CatalogModelConfig[] = [],
): FeatureSpec {
  const provider: CatalogProviderHandle = {
    id: 'test',
    requester,
    listModels: async () => [{ id: 'test-model', provider: 'test', maxContextSize: 8192 }],
  };
  return createFeature('test-provider', {
    app() {
      useProvider({
        handle: provider,
        models: [
          {
            provider: 'test',
            model: 'test-model',
            maxContextSize: 8192,
          },
          ...extraModels,
        ],
      });
    },
  });
}

const THINKING_CAPABILITY: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
};

function reasonerModel(): CatalogModelConfig {
  return {
    provider: 'test',
    model: 'test-reasoner',
    capability: THINKING_CAPABILITY,
    supportEfforts: ['low', 'high'],
    defaultEffort: 'low',
  };
}

function booleanThinkerModel(): CatalogModelConfig {
  return {
    provider: 'test',
    model: 'test-boolean-thinker',
    capability: THINKING_CAPABILITY,
  };
}

function alwaysThinkingModel(): CatalogModelConfig {
  return {
    provider: 'test',
    model: 'test-always-thinker',
    capability: THINKING_CAPABILITY,
    alwaysThinking: true,
    supportEfforts: ['low', 'high'],
  };
}

function bindTestTools(terminalBash = false): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      for (const name of ['Read', 'Bash', 'Write', 'Edit']) {
        useAgentTools({
          name,
          description: `${name} tool`,
          parameters: { type: 'object', properties: {} },
          execute: async ({ onUpdate }) => {
            if (terminalBash && name === 'Bash') {
              onUpdate?.({ key: 'terminal', text: 'term-1' });
            }
            return { content: [{ type: 'text' as const, text: `${name} ok` }] };
          },
        });
      }
    },
  });
}

function makeTestSkill(
  name: string,
  source: SkillSource,
  extraMetadata: Record<string, unknown> = {},
): SkillDefinition {
  return {
    name,
    description: `${name} skill`,
    path: `/test/skills/${name}/SKILL.md`,
    dir: `/test/skills/${name}`,
    content: `${name} instructions body.`,
    metadata: { type: 'inline', ...extraMetadata },
    source,
  };
}

function contributeTestSkillSource(
  skills: SkillDefinition[],
  skillChange: { fire: () => void },
): FeatureSpec {
  return createFeature('test-skill-source', {
    app() {
      useSkillSource({
        id: 'test-skills',
        priority: 30,
        load: async () => ({ skills }),
        onDidChange: (listener) => {
          skillChange.fire = listener;
          return () => {};
        },
      });
    },
  });
}

interface AcpTestEnv {
  readonly app: AppHandle;
  readonly conn: ClientSideConnection;
  readonly initializeResponse: InitializeResponse;
  readonly updates: SessionNotification[];
  readonly permissionRequests: RequestPermissionRequest[];
  readonly elicitationRequests: unknown[];
  readonly mediaPuts: StoredContent[];
  readonly readPaths: string[];
  readonly triggerSkillChange: () => void;
  respondPermission(response: RequestPermissionResponse): void;
  respondElicitation(response: unknown): void;
  dispose(): Promise<void>;
}

function recordingStore(): { store: MediaStore; puts: StoredContent[] } {
  const inner = createMemoryMediaStore();
  const puts: StoredContent[] = [];
  return {
    puts,
    store: {
      get: (ref) => inner.get(ref),
      put: async (content) => {
        puts.push(content);
        return inner.put(content);
      },
    },
  };
}

function noisePngBytes(width: number, height: number): Promise<Buffer> {
  const image = new Jimp({ width, height });
  const data = image.bitmap.data;
  let seed = 42;
  for (let i = 0; i < data.length; i += 1) {
    if (i % 4 === 3) {
      data[i] = 255;
      continue;
    }
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed >>> 23;
  }
  return image.getBuffer('image/png');
}

async function startAcpTest(options?: {
  capabilities?: ClientCapabilities;
  withPermission?: boolean;
  withPlan?: boolean;
  withMedia?: boolean;
  withTodo?: boolean;
  withSkill?: boolean;
  testSkills?: SkillDefinition[];
  withMcp?: boolean | Record<string, McpServerConfig>;
  mcpHost?: boolean;
  withTerminalBash?: boolean;
  extraModels?: CatalogModelConfig[];
  fileContent?: string;
  onSessionActive?: (connection: AcpOsConnection) => void;
  onSessionClose?: (sessionId: string) => void;
}): Promise<AcpTestEnv> {
  queue = [];
  callSeq = 0;
  callCount = 0;
  llmCalls = [];
  const requester = createMockRequester();
  const { store, puts } = recordingStore();
  const skillChange = { fire: () => {} };
  const mcpHome =
    options?.withMcp !== undefined && options.withMcp !== false
      ? await mkdtemp(join(tmpdir(), 'acp-mcp-home-'))
      : undefined;
  const features: FeatureSpec[] = [
    contributeTestProvider(requester, options?.extraModels),
    providerCatalog,
    interaction,
    usage,
    ...(options?.withPermission === true ? [createPermission()] : []),
    ...(options?.withPlan === true ? [createPlan({ storage: createMemoryPlanStorage() })] : []),
    ...(options?.withMedia === true
      ? [createMedia({ workDir: '/tmp/acp-test', store, cache: createMemoryUploadCache() })]
      : []),
    ...(options?.withTodo === true ? [todoFeature] : []),
    ...(options?.withSkill === true ? [createSkill({ workDir: '/tmp/acp-test' })] : []),
    ...(options?.testSkills !== undefined
      ? [contributeTestSkillSource(options.testSkills, skillChange)]
      : []),
    ...(mcpHome !== undefined
      ? [
          createMcp({
            workDir: options?.mcpHost === true ? mcpHome : '/tmp/acp-test',
            home: mcpHome,
            host: options?.mcpHost === true ? createNodeOsHost() : undefined,
            servers: typeof options?.withMcp === 'object' ? options.withMcp : undefined,
          }),
        ]
      : []),
    bindTestTools(options?.withTerminalBash),
    bindTestLlm(requester),
  ];
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const agentStream = ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent));
  const clientStream = ndJsonStream(Writable.toWeb(toAgent), Readable.toWeb(toClient));
  const app = createHarness({
    features: [
      createAcp({
        streams: agentStream,
        disableAuth: true,
        onSessionActive: options?.onSessionActive,
        onSessionClose: options?.onSessionClose,
      }),
      ...features,
    ],
    space: memorySessionSpace(),
  });
  const updates: SessionNotification[] = [];
  const permissionRequests: RequestPermissionRequest[] = [];
  const elicitationRequests: unknown[] = [];
  const readPaths: string[] = [];
  let permissionResponse: RequestPermissionResponse = {
    outcome: { outcome: 'selected', optionId: 'approve_once' },
  };
  let elicitationResponse: unknown = { action: 'accept', content: { q0: 'B' } };
  const conn = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params) => {
        updates.push(params);
      },
      requestPermission: async (params) => {
        permissionRequests.push(params);
        return permissionResponse;
      },
      unstable_createElicitation: async (params) => {
        elicitationRequests.push(params);
        return elicitationResponse as never;
      },
      readTextFile: async (params: { sessionId: string; path: string }) => {
        readPaths.push(params.path);
        return { content: options?.fileContent ?? 'old content\n' };
      },
      writeTextFile: async () => ({}),
    }),
    clientStream,
  );
  const initializeResponse = await conn.initialize({
    protocolVersion: 1,
    clientCapabilities: options?.capabilities ?? {},
  });
  return {
    app,
    conn,
    initializeResponse,
    updates,
    permissionRequests,
    elicitationRequests,
    mediaPuts: puts,
    readPaths,
    triggerSkillChange: () => {
      skillChange.fire();
    },
    respondPermission: (response) => {
      permissionResponse = response;
    },
    respondElicitation: (response) => {
      elicitationResponse = response;
    },
    dispose: async () => {
      toAgent.end();
      toClient.end();
      await app.disposeAsync();
      if (mcpHome !== undefined) {
        await rm(mcpHome, { recursive: true, force: true });
      }
    },
  };
}

function sessionUpdatesOf(env: AcpTestEnv, kind: string): SessionNotification[] {
  return env.updates.filter(
    (notification) => (notification.update as { sessionUpdate?: string }).sessionUpdate === kind,
  );
}

function chunkTexts(env: AcpTestEnv, kind: string): string[] {
  return sessionUpdatesOf(env, kind).map(
    (notification) => (notification.update as { content?: { text?: string } }).content?.text ?? '',
  );
}

interface ToolCallWire {
  sessionUpdate?: string;
  toolCallId?: string;
  status?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string }>;
  content?: Array<{ type?: string; terminalId?: string; content?: { text?: string } }>;
}

function toolCallWires(env: AcpTestEnv): ToolCallWire[] {
  return env.updates
    .map((notification) => notification.update as unknown as ToolCallWire)
    .filter((update) => update.toolCallId !== undefined);
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let env: AcpTestEnv | undefined;

afterEach(async () => {
  await env?.dispose();
  env = undefined;
});

describe('feature-acp', () => {
  it('negotiates capabilities and advertises auth methods on initialize', async () => {
    env = await startAcpTest();
    const response = env.initializeResponse;
    expect(response.protocolVersion).toBe(1);
    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(response.agentCapabilities?.promptCapabilities?.audio).toBe(false);
    expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
    expect(response.agentCapabilities?.sessionCapabilities?.list).toEqual({});
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
    expect(response.agentCapabilities?.sessionCapabilities?.close).toEqual({});
    expect(response.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
    expect(response.agentCapabilities?.sessionCapabilities?.delete).toEqual({});
    expect(response.agentCapabilities?.mcpCapabilities).toBeUndefined();
    expect(response.authMethods?.[0]).toMatchObject({
      id: 'login',
      type: 'terminal',
      args: ['--login'],
    });
  });

  it('creates a session and streams a prompt turn as agent_message_chunk with end_turn', async () => {
    env = await startAcpTest();
    queue = [
      { parts: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    expect(created.sessionId).toMatch(/^session_/);
    const configOptions = created.configOptions ?? [];
    expect(configOptions.map((option) => option.id)).toEqual(['model', 'mode']);
    const modelOption = configOptions[0];
    expect(modelOption?.type === 'select' && modelOption.options).toEqual([
      { value: 'test-model', name: 'test-model' },
    ]);
    expect(created.modes?.currentModeId).toBe('default');
    expect(created.modes?.availableModes.map((mode) => mode.id)).toEqual([
      'default',
      'plan',
      'auto',
      'yolo',
    ]);

    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'say hi' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(chunkTexts(env, 'agent_message_chunk')).toEqual(['hello ', 'world']);
    expect(callCount).toBe(1);

    await until(() => sessionUpdatesOf(env, 'available_commands_update').length > 0);
    const commands = sessionUpdatesOf(env, 'available_commands_update');
    expect(commands).toHaveLength(1);
    const names = (
      commands[0]?.update as { availableCommands?: Array<{ name: string }> }
    ).availableCommands?.map((command) => command.name);
    expect(names).toEqual(['status', 'usage', 'tasks']);

    await until(() => sessionUpdatesOf(env, 'usage_update').length > 0);
    const usageUpdate = sessionUpdatesOf(env, 'usage_update')[0]?.update as {
      used?: number;
      size?: number;
    };
    expect(usageUpdate.size).toBe(8192);
    expect(usageUpdate.used).toBe(15);
  });

  it('maps a tool call to lazy create, started upgrade, and terminal update', async () => {
    env = await startAcpTest();
    const filePath = '/tmp/acp-test/note.txt';
    queue = [
      {
        parts: [
          { type: 'function', id: 'call-1', name: 'Read', arguments: `{"path":"${filePath}` },
          { type: 'tool_call_part', argumentsPart: '"}' },
        ],
      },
      { parts: [{ type: 'text', text: 'read it' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'read the note' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(callCount).toBe(2);

    const wires = toolCallWires(env).filter((wire) => wire.toolCallId?.endsWith(':call-1'));
    expect(wires.map((wire) => wire.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
      'tool_call_update',
      'tool_call_update',
    ]);
    expect(wires[0]?.status).toBe('pending');
    expect(wires[0]?.title).toBe('Read');
    expect(wires[0]?.kind).toBe('read');
    expect(wires[0]?.rawInput).toBeUndefined();
    expect(wires[0]?.content?.map((entry) => entry.content?.text ?? '').join('')).toBe(
      `{"path":"${filePath}`,
    );
    expect(wires[1]?.status).toBe('in_progress');
    expect(wires[1]?.content?.map((entry) => entry.content?.text ?? '').join('')).toBe(
      `{"path":"${filePath}"}`,
    );
    expect(wires[2]?.status).toBe('in_progress');
    expect(wires[2]?.rawInput).toEqual({ path: filePath });
    expect(wires[2]?.locations?.[0]?.path).toBe(filePath);
    const terminal = wires[3];
    expect(terminal?.status).toBe('completed');
    expect(terminal?.locations?.[0]?.path).toBe(filePath);
    expect(terminal?.content?.map((entry) => entry.content?.text ?? '').join('')).toContain(
      'Read ok',
    );
  });

  it('embeds a client terminal in the tool card when the tool reports a terminal handle', async () => {
    env = await startAcpTest({ withTerminalBash: true });
    queue = [
      {
        parts: [{ type: 'function', id: 'call-1', name: 'Bash', arguments: '{"command":"echo hi"}' }],
      },
      { parts: [{ type: 'text', text: 'done' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run echo' }],
    });
    expect(response.stopReason).toBe('end_turn');

    const wires = toolCallWires(env).filter((wire) => wire.toolCallId?.endsWith(':call-1'));
    expect(wires.map((wire) => wire.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
      'tool_call_update',
      'tool_call_update',
    ]);
    const embedOf = (wire: ToolCallWire | undefined) =>
      wire?.content?.find((entry) => entry.type === 'terminal');
    expect(wires[2]?.status).toBeUndefined();
    expect(embedOf(wires[2])?.terminalId).toBe('term-1');
    const terminal = wires[3];
    expect(terminal?.status).toBe('completed');
    expect(embedOf(terminal)?.terminalId).toBe('term-1');
    expect(terminal?.content?.some((entry) => entry.content?.text?.includes('Bash ok'))).toBe(
      false,
    );
    expect(terminal?.rawOutput).toBeUndefined();
  });

  it('createAcpOsHost routes bash-shaped spawns through terminal/create and exposes the handle', async () => {
    const created: Array<{ command: string; args?: string[] }> = [];
    const host = createAcpOsHost({
      connection: {
        sessionId: 's-1',
        client: {
          readTextFile: async () => {
            throw new Error('unused');
          },
          writeTextFile: async () => {
            throw new Error('unused');
          },
          createTerminal: async (params) => {
            created.push(params);
            return {
              id: 'term-1',
              currentOutput: async () => ({ output: 'hello\n', truncated: false }),
              waitForExit: async () => ({ exitCode: 0 }),
              kill: async () => ({}),
              release: async () => ({}),
            };
          },
        },
        fsReadTextFile: false,
        fsWriteTextFile: false,
        terminalEnabled: true,
      },
    });
    const proc = await host.process.spawn('/bin/bash', ['-c', 'echo hi'], {
      env: { NO_COLOR: '1', TERM: 'dumb' },
    });
    expect(proc.external).toEqual({ kind: 'terminal', id: 'term-1' });
    expect(created).toHaveLength(1);
    expect(created[0]?.command).toBe('/bin/bash');
    expect(created[0]?.args).toEqual(['-c', 'echo hi']);
    expect(await proc.wait()).toBe(0);
    let out = '';
    for await (const chunk of proc.stdout) {
      out += new TextDecoder().decode(chunk);
    }
    expect(out).toBe('hello\n');
    proc.dispose();
  });

  it('bridges a permission approval through session/request_permission and resumes the tool', async () => {
    env = await startAcpTest({ withPermission: true });
    queue = [
      {
        parts: [
          { type: 'function', id: 'call-1', name: 'Bash', arguments: '{"command":"echo hi"}' },
        ],
      },
      { parts: [{ type: 'text', text: 'ran it' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run echo' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(callCount).toBe(2);
    expect(env.permissionRequests).toHaveLength(1);
    const request = env.permissionRequests[0]!;
    expect(request.toolCall.title).toBe('Bash');
    expect(request.toolCall.toolCallId).toContain('call-1');
    expect(request.options.map((option) => option.optionId)).toEqual([
      'approve_once',
      'approve_always',
      'reject',
    ]);
    expect(request.options.map((option) => option.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
    ]);
    const terminal = toolCallWires(env).find(
      (wire) => wire.sessionUpdate === 'tool_call_update' && wire.status === 'completed',
    );
    expect(terminal?.content?.map((entry) => entry.content?.text ?? '').join('')).toContain(
      'Bash ok',
    );
  });

  it('degrades a question interaction to a single-select request_permission prompt', async () => {
    env = await startAcpTest();
    queue = [
      {
        parts: [
          {
            type: 'function',
            id: 'call-q',
            name: 'AskUserQuestion',
            arguments: JSON.stringify({
              questions: [
                {
                  question: 'Pick one',
                  header: 'One',
                  options: [{ label: 'A' }, { label: 'B' }],
                  multi_select: false,
                },
              ],
            }),
          },
        ],
      },
      { parts: [{ type: 'text', text: 'noted' }] },
    ];
    env.respondPermission({ outcome: { outcome: 'selected', optionId: 'q0_opt_1' } });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'ask me' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(env.permissionRequests).toHaveLength(1);
    const request = env.permissionRequests[0]!;
    expect(request.toolCall.title).toBe('AskUserQuestion');
    expect(request.options.map((option) => option.optionId)).toEqual([
      'q0_opt_0',
      'q0_opt_1',
      'q0_skip',
    ]);
    expect(request.options.map((option) => option.name)).toEqual(['A', 'B', 'Skip']);
    expect(callCount).toBe(2);
  });

  it('maps set_mode to plan and permission facades and emits current_mode_update', async () => {
    env = await startAcpTest({ withPermission: true, withPlan: true });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const main = env.app.get(created.sessionId)?.get(MAIN_AGENT_ID);
    expect(main).toBeDefined();

    env.updates.length = 0;
    await env.conn.setSessionMode({ sessionId: created.sessionId, modeId: 'plan' });
    expect(main!.resolve(PlanRef).state.value.active).toBe(true);
    expect(main!.resolve(PermissionRef).mode()).toBe('manual');
    const modeUpdates = sessionUpdatesOf(env, 'current_mode_update');
    expect(
      (modeUpdates.at(-1)?.update as { currentModeId?: string }).currentModeId,
    ).toBe('plan');

    await env.conn.setSessionMode({ sessionId: created.sessionId, modeId: 'auto' });
    expect(main!.resolve(PlanRef).state.value.active).toBe(false);
    expect(main!.resolve(PermissionRef).mode()).toBe('auto');
    expect(
      (sessionUpdatesOf(env, 'current_mode_update').at(-1)?.update as { currentModeId?: string })
        .currentModeId,
    ).toBe('auto');

    await env.conn.setSessionMode({ sessionId: created.sessionId, modeId: 'default' });
    expect(main!.resolve(PermissionRef).mode()).toBe('manual');
  });

  it('replays history as session updates before the session/load response', async () => {
    env = await startAcpTest();
    queue = [
      {
        parts: [
          { type: 'function', id: 'call-1', name: 'Read', arguments: '{"path":"/tmp/a.txt"}' },
        ],
      },
      { parts: [{ type: 'text', text: 'all read' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const first = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'read a' }],
    });
    expect(first.stopReason).toBe('end_turn');

    env.updates.length = 0;
    const loaded = await env.conn.loadSession({
      sessionId: created.sessionId,
      cwd: '/tmp/acp-test',
      mcpServers: [],
    });
    expect(loaded.configOptions?.map((option) => option.id)).toEqual(['model', 'mode']);
    expect(loaded.modes?.currentModeId).toBe('default');

    const kinds = env.updates.map(
      (notification) => (notification.update as { sessionUpdate?: string }).sessionUpdate,
    );
    expect(kinds).toContain('user_message_chunk');
    expect(kinds).toContain('agent_message_chunk');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_call_update');
    expect(chunkTexts(env, 'user_message_chunk')).toEqual(['read a']);
    expect(chunkTexts(env, 'agent_message_chunk')).toContain('all read');
    const wires = toolCallWires(env).filter((wire) => wire.toolCallId?.endsWith(':call-1'));
    expect(wires[0]?.sessionUpdate).toBe('tool_call');
    expect(wires[0]?.status).toBe('in_progress');
    expect(wires.at(-1)?.sessionUpdate).toBe('tool_call_update');
    expect(wires.at(-1)?.status).toBe('completed');
  });

  it('settles session/prompt as cancelled after session/cancel aborts the turn', async () => {
    env = await startAcpTest();
    queue = [{ hang: true }];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const promptPromise = env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hang' }],
    });
    await until(() => callCount === 1);
    await env.conn.cancel({ sessionId: created.sessionId });
    const response = await promptPromise;
    expect(response.stopReason).toBe('cancelled');
  });

  it('converts image and resource blocks and drops audio and blob resources', async () => {
    env = await startAcpTest();
    queue = [{ parts: [{ type: 'text', text: 'seen' }] }];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'resource_link', uri: 'file:///tmp/notes/a.ts#L3-L9', name: 'a.ts' },
        { type: 'resource_link', uri: 'https://example.com/x', name: 'x' },
        {
          type: 'resource',
          resource: { uri: 'file:///tmp/notes/b.ts', text: 'const b = 1;', mimeType: 'text/plain' },
        },
        { type: 'audio', data: 'aGk=', mimeType: 'audio/wav' },
        {
          type: 'resource',
          resource: { uri: 'file:///tmp/notes/c.bin', blob: 'aGk=', mimeType: 'application/octet-stream' },
        },
      ],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(callCount).toBe(1);
    const userMessage = llmCalls.at(-1)?.messages.findLast((message) => message.role === 'user');
    expect(userMessage?.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', source: { kind: 'inline', mimeType: 'image/png', data: 'aGk=' } },
      { type: 'text', text: '/tmp/notes/a.ts:3-9' },
      { type: 'text', text: '<resource_link uri="https://example.com/x" name="x" />' },
      { type: 'text', text: '<resource uri="file:///tmp/notes/b.ts">const b = 1;</resource>' },
    ]);
  });

  it('routes oversized image blocks through the media intake gate when media is mounted', async () => {
    env = await startAcpTest({ withMedia: true });
    queue = [{ parts: [{ type: 'text', text: 'nice pic' }] }];
    const noise = await noisePngBytes(1200, 900);
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'image', data: noise.toString('base64'), mimeType: 'image/png' }],
    });
    expect(response.stopReason).toBe('end_turn');
    const userMessage = llmCalls.at(-1)?.messages.findLast((message) => message.role === 'user');
    if (userMessage === undefined) throw new Error('no user message captured');
    const texts = userMessage.content
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text);
    expect(texts.some((text) => text.includes('Image compressed to fit model limits:'))).toBe(true);
    const images = userMessage.content.filter((part) => part.type === 'image_url');
    expect(images).toHaveLength(1);
    const lowered = images[0] as { source: { kind: string; ref?: string } };
    expect(lowered.source.kind).toBe('store');
    expect(lowered.source.ref?.startsWith('media://')).toBe(true);
    expect(lowered.source.ref?.includes('image/png')).toBe(false);
    expect(env.mediaPuts.some((put) => put.mimeType === 'image/jpeg')).toBe(true);
  }, 60_000);

  it('answers builtin slash commands locally without launching a turn', async () => {
    env = await startAcpTest();
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    env.updates.length = 0;
    const status = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/status' }],
    });
    expect(status.stopReason).toBe('end_turn');
    const chunks = chunkTexts(env, 'agent_message_chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain(`Session: ${created.sessionId}`);
    expect(chunks[0]).toContain('Model: test-model');
    expect(chunks[0]).toContain('Mode: default');
    expect(chunks[0]).toContain('Working directory: /tmp/acp-test');
    expect(callCount).toBe(0);

    const unknown = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/nope' }],
    });
    expect(unknown.stopReason).toBe('end_turn');
    expect(chunkTexts(env, 'agent_message_chunk').at(-1)).toContain('Unknown ACP command: /nope');
    expect(callCount).toBe(0);
  });

  it('routes elicitation-form clients through elicitation/create for questions', async () => {
    env = await startAcpTest({ capabilities: { elicitation: { form: {} } } });
    queue = [
      {
        parts: [
          {
            type: 'function',
            id: 'call-q',
            name: 'AskUserQuestion',
            arguments: JSON.stringify({
              questions: [
                {
                  question: 'Pick one',
                  header: 'One',
                  options: [{ label: 'A' }, { label: 'B' }],
                  multi_select: false,
                },
              ],
            }),
          },
        ],
      },
      { parts: [{ type: 'text', text: 'noted' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'ask me' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(callCount).toBe(2);
    expect(env.permissionRequests).toHaveLength(0);
    expect(env.elicitationRequests).toHaveLength(1);
    const elicitation = env.elicitationRequests[0] as {
      mode?: string;
      toolCallId?: string;
      requestedSchema?: { required?: string[]; properties?: Record<string, { type?: string }> };
    };
    expect(elicitation.mode).toBe('form');
    expect(elicitation.toolCallId).toContain('call-q');
    expect(elicitation.requestedSchema?.required).toEqual(['q0']);
    expect(elicitation.requestedSchema?.properties?.['q0']?.type).toBe('string');
  });

  it('rejects the prompt with auth_required when the turn fails with an auth error', async () => {
    env = await startAcpTest();
    queue = [
      {
        fail: {
          kind: 'auth',
          message: 'HTTP 401 unauthorized',
          statusCode: 401,
          requestId: null,
          retryAfterMs: null,
          headers: null,
        },
      },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    await expect(
      env.conn.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: -32000 });
  });

  it('maps provider-filtered failures to refusal', async () => {
    env = await startAcpTest();
    queue = [
      {
        fail: {
          kind: 'empty_response',
          message: 'The provider filtered the response before visible output was emitted.',
          finishReason: 'filtered',
          rawFinishReason: 'content_filter',
        },
      },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    });
    expect(response.stopReason).toBe('refusal');
  });

  it('attaches a derived diff card to Edit tool calls at creation', async () => {
    env = await startAcpTest();
    queue = [
      {
        parts: [
          {
            type: 'function',
            id: 'call-e',
            name: 'Edit',
            arguments: JSON.stringify({
              path: '/tmp/acp-test/note.txt',
              old_string: 'old line',
              new_string: 'new line',
            }),
          },
        ],
      },
      { parts: [{ type: 'text', text: 'edited' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'edit note' }],
    });
    expect(response.stopReason).toBe('end_turn');
    const wire = toolCallWires(env).find(
      (entry) =>
        entry.sessionUpdate === 'tool_call_update' &&
        entry.status === 'in_progress' &&
        entry.toolCallId?.endsWith(':call-e'),
    );
    const content = (wire?.content ?? []) as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'diff',
      path: '/tmp/acp-test/note.txt',
      oldText: 'old line',
      newText: 'new line',
    });
  });

  it('folds a derived Write diff with client fs pre-read into the terminal update', async () => {
    env = await startAcpTest({
      capabilities: { fs: { readTextFile: true, writeTextFile: false } },
      fileContent: 'before\n',
    });
    queue = [
      {
        parts: [
          {
            type: 'function',
            id: 'call-w',
            name: 'Write',
            arguments: JSON.stringify({ path: 'note.txt', content: 'after\n' }),
          },
        ],
      },
      { parts: [{ type: 'text', text: 'wrote' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'write note' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(env.readPaths).toEqual(['/tmp/acp-test/note.txt']);
    const wire = toolCallWires(env).find(
      (entry) =>
        entry.sessionUpdate === 'tool_call_update' &&
        entry.status === 'completed' &&
        entry.toolCallId?.endsWith(':call-w'),
    );
    const content = (wire?.content ?? []) as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'diff', path: 'note.txt', oldText: 'before\n', newText: 'after\n' });
  });

  it('derives a Write diff with null oldText when the client has no fs capability', async () => {
    env = await startAcpTest();
    queue = [
      {
        parts: [
          {
            type: 'function',
            id: 'call-w',
            name: 'Write',
            arguments: JSON.stringify({ path: '/tmp/acp-test/new.txt', content: 'fresh\n' }),
          },
        ],
      },
      { parts: [{ type: 'text', text: 'wrote' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'write new' }],
    });
    expect(env.readPaths).toHaveLength(0);
    const wire = toolCallWires(env).find(
      (entry) =>
        entry.sessionUpdate === 'tool_call_update' &&
        entry.status === 'completed' &&
        entry.toolCallId?.endsWith(':call-w'),
    );
    const content = (wire?.content ?? []) as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'diff',
      path: '/tmp/acp-test/new.txt',
      oldText: null,
      newText: 'fresh\n',
    });
  });

  it('includes the derived diff in the permission request card', async () => {
    env = await startAcpTest({ withPermission: true });
    queue = [
      {
        parts: [
          {
            type: 'function',
            id: 'call-p',
            name: 'Edit',
            arguments: JSON.stringify({
              path: '/tmp/acp-test/note.txt',
              old_string: 'a',
              new_string: 'b',
            }),
          },
        ],
      },
      { parts: [{ type: 'text', text: 'approved' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'edit note' }],
    });
    expect(env.permissionRequests).toHaveLength(1);
    const content = (env.permissionRequests[0]?.toolCall.content ?? []) as Array<
      Record<string, unknown>
    >;
    expect(content[0]).toEqual({
      type: 'diff',
      path: '/tmp/acp-test/note.txt',
      oldText: 'a',
      newText: 'b',
    });
  });

  it('mirrors todo list changes as ACP plan notifications', async () => {
    env = await startAcpTest({ withTodo: true });
    queue = [
      {
        parts: [
          {
            type: 'function',
            id: 'call-t',
            name: 'TodoList',
            arguments: JSON.stringify({
              todos: [
                { title: 'write tests', status: 'in_progress' },
                { title: 'ship', status: 'pending' },
              ],
            }),
          },
        ],
      },
      { parts: [{ type: 'text', text: 'noted' }] },
    ];
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'track work' }],
    });
    await until(() => sessionUpdatesOf(env, 'plan').length > 0);
    const plan = sessionUpdatesOf(env, 'plan').at(-1)?.update as {
      entries?: Array<Record<string, unknown>>;
    };
    expect(plan.entries).toEqual([
      { content: 'write tests', priority: 'medium', status: 'in_progress' },
      { content: 'ship', priority: 'medium', status: 'pending' },
    ]);
  });

  it('projects skill summaries into ACP slash commands', () => {
    const summary = (
      name: string,
      source: SkillSource,
      extra: Partial<SkillSummary> = {},
    ): SkillSummary => ({
      name,
      description: `${name} skill`,
      path: `/test/skills/${name}/SKILL.md`,
      source,
      ...extra,
    });
    const { commands, commandMap } = buildAcpSkillSlashCommands([
      summary('zeta', 'project'),
      summary('alpha', 'user'),
      summary('write-goal', 'builtin'),
      summary('status', 'builtin'),
      summary('hidden', 'project', { type: 'reference' }),
      summary('sub.review', 'project', { isSubSkill: true }),
    ]);
    expect(commands.map((command) => command.name)).toEqual([
      'write-goal',
      'skill:alpha',
      'sub.review',
      'skill:zeta',
    ]);
    expect(commandMap.get('write-goal')).toBe('write-goal');
    expect(commandMap.get('skill:alpha')).toBe('alpha');
    expect(commandMap.get('sub.review')).toBe('sub.review');
    expect(resolveSkillCommand(commandMap, 'alpha')).toBe('alpha');
    expect(resolveSkillCommand(commandMap, 'skill:alpha')).toBe('alpha');
    expect(resolveSkillCommand(commandMap, 'status')).toBeUndefined();
    expect(resolveSkillCommand(commandMap, 'nope')).toBeUndefined();
  });

  it('advertises skill slash commands in available_commands_update', async () => {
    env = await startAcpTest({
      withSkill: true,
      testSkills: [makeTestSkill('deploy', 'project')],
    });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    expect(created.sessionId).toBeTruthy();
    await until(() => sessionUpdatesOf(env, 'available_commands_update').length > 0);
    const update = sessionUpdatesOf(env, 'available_commands_update').at(-1)?.update as {
      availableCommands?: Array<{ name: string }>;
    };
    const names = (update.availableCommands ?? []).map((command) => command.name);
    expect(names).toContain('status');
    expect(names).toContain('write-goal');
    expect(names).toContain('update-config');
    expect(names).toContain('skill:deploy');
  });

  it('activates a builtin skill via slash command and drives the turn', async () => {
    env = await startAcpTest({ withSkill: true });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/write-goal ship the feature' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(llmCalls).toHaveLength(1);
    const texts = llmCalls[0]!.messages.flatMap((message) =>
      message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text?: string }).text ?? ''),
    );
    expect(texts.some((text) => text.includes('<skill-loaded name="write-goal"'))).toBe(true);
    expect(texts.some((text) => text.includes('args="ship the feature"'))).toBe(true);
  });

  it('activates a prefixed skill via /skill:<name>', async () => {
    env = await startAcpTest({
      withSkill: true,
      testSkills: [makeTestSkill('deploy', 'project')],
    });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/skill:deploy production' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(llmCalls).toHaveLength(1);
    const texts = llmCalls[0]!.messages.flatMap((message) =>
      message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text?: string }).text ?? ''),
    );
    expect(texts.some((text) => text.includes('<skill-loaded name="deploy"'))).toBe(true);
    expect(texts.some((text) => text.includes('args="production"'))).toBe(true);
  });

  it('re-pushes available_commands_update when the skill catalog changes', async () => {
    const skills = [makeTestSkill('alpha', 'user')];
    env = await startAcpTest({ withSkill: true, testSkills: skills });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    expect(created.sessionId).toBeTruthy();
    await until(() => sessionUpdatesOf(env, 'available_commands_update').length > 0);
    const baseline = sessionUpdatesOf(env, 'available_commands_update').length;
    skills.push(makeTestSkill('beta', 'user'));
    env.triggerSkillChange();
    await until(() => sessionUpdatesOf(env, 'available_commands_update').length > baseline);
    const update = sessionUpdatesOf(env, 'available_commands_update').at(-1)?.update as {
      availableCommands?: Array<{ name: string }>;
    };
    const names = (update.availableCommands ?? []).map((command) => command.name);
    expect(names).toContain('skill:alpha');
    expect(names).toContain('skill:beta');
  });

  it('answers /mcp locally with the MCP server status list', async () => {
    env = await startAcpTest({
      withMcp: { fake: { transport: 'stdio', command: 'fake-acp-mcp-binary' } },
    });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    await until(() => sessionUpdatesOf(env, 'available_commands_update').length > 0);
    const update = sessionUpdatesOf(env, 'available_commands_update').at(-1)?.update as {
      availableCommands?: Array<{ name: string }>;
    };
    expect((update.availableCommands ?? []).map((command) => command.name)).toContain('mcp');
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/mcp' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(llmCalls).toHaveLength(0);
    const text = chunkTexts(env, 'agent_message_chunk').at(-1) ?? '';
    expect(text).toContain('MCP servers (1):');
    expect(text).toContain('- fake (stdio): failed, 0 tools — ');
    expect(text).toContain('createMcp was mounted without an OS host');
  });

  it('answers /mcp with the empty message when no MCP servers are configured', async () => {
    env = await startAcpTest({ withMcp: true });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/mcp' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(chunkTexts(env, 'agent_message_chunk').at(-1)).toBe(
      'No MCP servers configured for this session.',
    );
  });

  it('treats /mcp as unavailable when the mcp feature is not mounted', async () => {
    env = await startAcpTest();
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    await until(() => sessionUpdatesOf(env, 'available_commands_update').length > 0);
    const update = sessionUpdatesOf(env, 'available_commands_update').at(-1)?.update as {
      availableCommands?: Array<{ name: string }>;
    };
    expect((update.availableCommands ?? []).map((command) => command.name)).not.toContain('mcp');
    const response = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/mcp' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(chunkTexts(env, 'agent_message_chunk').at(-1)).toBe('/mcp failed: MCP is unavailable');
  });

  it('exposes the thinking select for thinking-capable models and applies setThinking', async () => {
    env = await startAcpTest({ extraModels: [reasonerModel()] });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    expect(created.configOptions?.map((option) => option.id)).toEqual(['model', 'mode']);

    const switched = await env.conn.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'test-reasoner',
    });
    expect(switched.configOptions?.map((option) => option.id)).toEqual([
      'model',
      'thinking',
      'mode',
    ]);
    const thinking = switched.configOptions?.[1];
    expect(thinking).toMatchObject({
      type: 'select',
      id: 'thinking',
      category: 'thought_level',
      currentValue: 'off',
    });
    expect(
      thinking?.type === 'select' && thinking.options.map((option) => option.value),
    ).toEqual(['off', 'low', 'high']);

    const accepted = await env.conn.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'thinking',
      value: 'high',
    });
    expect(accepted.configOptions?.[1]?.currentValue).toBe('high');

    await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'think hard' }],
    });
    expect(llmCalls.at(-1)?.thinking).toBe('high');

    await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/status' }],
    });
    expect(chunkTexts(env, 'agent_message_chunk').at(-1)).toContain('(thinking: high)');

    await expect(
      env.conn.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'thinking',
        value: 'extreme',
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('splits the ,thinking suffix in set_model and keeps bare switches orthogonal', async () => {
    env = await startAcpTest({ extraModels: [reasonerModel()] });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });

    const merged = await env.conn.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'test-reasoner,thinking',
    });
    expect(merged.configOptions?.[0]?.currentValue).toBe('test-reasoner');
    expect(merged.configOptions?.[1]?.currentValue).toBe('low');

    await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(llmCalls.at(-1)?.thinking).toBe('low');

    const unsupported = await env.conn.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'test-model',
    });
    expect(unsupported.configOptions?.map((option) => option.id)).toEqual(['model', 'mode']);

    const bare = await env.conn.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'test-reasoner',
    });
    expect(bare.configOptions?.[1]?.currentValue).toBe('low');
  });

  it('adapts the thinking select for boolean and always-thinking models', async () => {
    env = await startAcpTest({
      extraModels: [booleanThinkerModel(), alwaysThinkingModel()],
    });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });

    const booleanSwitched = await env.conn.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'test-boolean-thinker',
    });
    const booleanThinking = booleanSwitched.configOptions?.[1];
    expect(
      booleanThinking?.type === 'select' &&
        booleanThinking.options.map((option) => option.value),
    ).toEqual(['off', 'on']);
    const turnedOn = await env.conn.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'thinking',
      value: 'on',
    });
    expect(turnedOn.configOptions?.[1]?.currentValue).toBe('on');
    await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(llmCalls.at(-1)?.thinking).toBe('on');

    const alwaysSwitched = await env.conn.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'test-always-thinker',
    });
    const alwaysThinking = alwaysSwitched.configOptions?.[1];
    expect(alwaysThinking?.currentValue).toBe('on');
    expect(
      alwaysThinking?.type === 'select' &&
        alwaysThinking.options.map((option) => option.value),
    ).toEqual(['low', 'high', 'on']);
    await expect(
      env.conn.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'thinking',
        value: 'off',
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('advertises mcpCapabilities on initialize when the mcp feature is mounted', async () => {
    env = await startAcpTest({ withMcp: true });
    expect(env.initializeResponse.agentCapabilities?.mcpCapabilities).toEqual({
      http: true,
      sse: true,
    });
  });

  it('connects session mcpServers scoped to the session cwd and disconnects them on session/close', async () => {
    env = await startAcpTest({ withMcp: true, mcpHost: true });
    queue = [
      {
        parts: [
          {
            type: 'function',
            id: 'call-m',
            name: 'mcp__fake__echo',
            arguments: JSON.stringify({ text: 'hello-acp' }),
          },
        ],
      },
      { parts: [{ type: 'text', text: 'echoed' }] },
    ];
    const created = await env.conn.newSession({
      cwd: '/tmp/acp-test',
      mcpServers: [{ name: 'fake', command: process.execPath, args: [fixturePath], env: [] }],
    });
    const mcp = env.app.resolve(McpRef);
    expect(mcp.list().map((entry) => [entry.name, entry.status])).toEqual([['fake', 'connected']]);
    const first = await env.conn.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'call echo' }],
    });
    expect(first.stopReason).toBe('end_turn');
    const schemas = llmCalls[1]?.messages.find(
      (message) => message.role === 'system' && message.tools !== undefined,
    );
    expect(schemas?.role === 'system' && schemas.tools?.map((tool) => tool.name)).toContain(
      'mcp__fake__echo',
    );
    const toolMessage = llmCalls[1]?.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toEqual([{ type: 'text', text: 'hello-acp' }]);

    const other = await env.conn.newSession({ cwd: '/tmp/acp-other', mcpServers: [] });
    await env.conn.prompt({
      sessionId: other.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    });
    const otherDynamic = llmCalls[2]?.messages.flatMap((message) =>
      message.role === 'system' ? (message.tools ?? []) : [],
    );
    expect(otherDynamic?.map((tool) => tool.name) ?? []).not.toContain('mcp__fake__echo');

    await env.conn.closeSession({ sessionId: created.sessionId });
    expect(mcp.list().map((entry) => [entry.name, entry.status])).toEqual([['fake', 'removed']]);
  }, 30_000);

  it('ignores mcpServers on session/fork', async () => {
    env = await startAcpTest({ withMcp: true, mcpHost: true });
    const created = await env.conn.newSession({
      cwd: '/tmp/acp-test',
      mcpServers: [{ name: 'fake', command: process.execPath, args: [fixturePath], env: [] }],
    });
    const mcp = env.app.resolve(McpRef);
    expect(mcp.list().map((entry) => entry.name)).toEqual(['fake']);
    const forked = await env.conn.unstable_forkSession({
      sessionId: created.sessionId,
      cwd: '/tmp/acp-test',
      mcpServers: [{ name: 'other', command: process.execPath, args: [fixturePath], env: [] }],
    });
    expect(forked.sessionId).not.toBe(created.sessionId);
    expect(mcp.list().map((entry) => entry.name)).toEqual(['fake']);
  }, 30_000);

  it('notifies session activation and closure through the host options', async () => {
    const active: AcpOsConnection[] = [];
    const closed: string[] = [];
    env = await startAcpTest({
      capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      onSessionActive: (connection) => active.push(connection),
      onSessionClose: (sessionId) => closed.push(sessionId),
    });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      sessionId: created.sessionId,
      fsReadTextFile: true,
      fsWriteTextFile: true,
      terminalEnabled: true,
    });
    await env.conn.closeSession({ sessionId: created.sessionId });
    expect(closed).toEqual([created.sessionId]);
  });

  it('routes the os host router through the active session connection and falls back to local', async () => {
    const router = createAcpOsHostRouter();
    env = await startAcpTest({
      capabilities: { fs: { readTextFile: true, writeTextFile: true } },
      onSessionActive: router.bind,
      onSessionClose: router.unbind,
    });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    await expect(router.host.fs.readText('/remote/file.ts')).resolves.toBe('old content\n');
    expect(env.readPaths).toEqual(['/remote/file.ts']);
    await env.conn.closeSession({ sessionId: created.sessionId });
    const dir = await mkdtemp(join(tmpdir(), 'acp-router-'));
    try {
      const file = join(dir, 'local.txt');
      await writeFile(file, 'local content\n');
      const routedCalls = env.readPaths.length;
      await expect(router.host.fs.readText(file)).resolves.toBe('local content\n');
      expect(env.readPaths).toHaveLength(routedCalls);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deletes a live session through session/delete and cleans up ACP-side wiring', async () => {
    const closed: string[] = [];
    env = await startAcpTest({ onSessionClose: (sessionId) => closed.push(sessionId) });
    const created = await env.conn.newSession({ cwd: '/tmp/acp-test', mcpServers: [] });
    expect(await env.app.space.get(created.sessionId)).toBeDefined();
    await expect(env.conn.deleteSession({ sessionId: created.sessionId })).resolves.toEqual({});
    expect(await env.app.space.get(created.sessionId)).toBeUndefined();
    expect(env.app.get(created.sessionId)).toBeUndefined();
    expect(closed).toEqual([created.sessionId]);
    await expect(
      env.conn.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(env.conn.listSessions({})).resolves.toMatchObject({ sessions: [] });
  });

  it('rejects session/delete for an unknown session with invalid_params', async () => {
    env = await startAcpTest();
    await expect(env.conn.deleteSession({ sessionId: 'session_missing' })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('Unknown sessionId: session_missing'),
    });
  });
});
