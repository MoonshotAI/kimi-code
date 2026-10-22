import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeature, useAgent, type Feature, createApp, type App, useAgentTools, useFeatureStore } from '#/app/index';
import { createUserEntry, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import type { FeatureStore } from '#/app/index';
import { useInject, type ShallowRef } from '#/composition-api/index';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, memorySessionSpace, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';

import { createConfig, useConfig, type ConfigPersist, type ConfigStore } from '#/todo-features/config/index';
import {
  createInteraction,
  InteractionRef,
  type Interaction,
  type Interactions,
} from '#/todo-features/interaction/index';
import {
  createPermission,
  DANGEROUS_COMMAND_GUARD_ENV,
  PermissionRef,
  permissionProjection,
  type ApprovalResponse,
  type CreatePermissionProps,
  type PermissionApprovalResolvedEvent,
  type PermissionFace,
  type PermissionState,
  type PermissionStoreEvent,
} from '#/todo-features/permission/index';

const interaction = createInteraction();

type ScriptStep = { text: string } | { toolCall: { name: string; arguments: string } };

let queue: ScriptStep[] = [];
let callSeq = 0;

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function createMockRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async () => {
      const out = queue.shift() ?? { text: 'done' };
      if ('toolCall' in out) {
        return textOutcome('', [
          {
            type: 'function',
            id: `call-${(callSeq += 1)}`,
            name: out.toolCall.name,
            arguments: out.toolCall.arguments,
          },
        ]);
      }
      return textOutcome(out.text);
    },
  };
  return self;
}

function setRequester(harness: App, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.sessions.get(sessionId);
  const agent = session !== undefined ? session.liveAgents.get(agentId) : undefined;
  if (agent === undefined) throw new Error(`no live agent '${agentId}'`);
  agent.loop.setRequester(requester);
}

const TEST_TOOL_NAMES = ['Bash', 'Write', 'Edit', 'Read', 'CustomTool'];

function bindTestTools(): Feature {
  return createFeature('test-tools', {
    agent() {
      for (const name of TEST_TOOL_NAMES) {
        useAgentTools({
          name,
          description: `${name} tool`,
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text' as const, text: `${name} ok` }] }),
        });
      }
    },
  });
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface PermissionProbe {
  readonly feature: Feature;
  face(agentId: string): PermissionFace | undefined;
  store(): FeatureStore<PermissionState, PermissionStoreEvent> | undefined;
  interactions(): Interactions | undefined;
  config(): ConfigStore | undefined;
}

function capturePermission(): PermissionProbe {
  const faces = new Map<string, Readonly<ShallowRef<PermissionFace | undefined>>>();
  let storeRef: FeatureStore<PermissionState, PermissionStoreEvent> | undefined;
  let interactionsRef: Readonly<ShallowRef<Interactions | undefined>> | undefined;
  let configRef: Readonly<ShallowRef<ConfigStore | undefined>> | undefined;
  const feature = createFeature('permission-probe', {
    app() {
      configRef = useConfig();
    },
    session() {
      interactionsRef = useInject(InteractionRef);
      storeRef = useFeatureStore('session', 'permission', permissionProjection);
    },
    agent() {
      const id = useAgent().id;
      faces.set(id, useInject(PermissionRef));
    },
  });
  return {
    feature,
    face: (agentId) => faces.get(agentId)?.value,
    store: () => storeRef,
    interactions: () => interactionsRef?.value,
    config: () => configRef?.value,
  };
}

interface PermissionTestEnv {
  readonly harness: App;
  readonly session: Session;
  readonly captured: Interaction[];
  readonly resolved: PermissionApprovalResolvedEvent[];
  runTurn(agentId?: string, text?: string): Promise<void>;
  spawnWorker(agentId: string): Promise<Agent>;
  remount(): Promise<void>;
  dispose(): Promise<void>;
  setResponse(next: ApprovalResponse): void;
  face(agentId?: string): PermissionFace;
  storeReady(): Promise<void>;
  agent(agentId?: string): Agent;
  config(): ConfigStore | undefined;
}

async function startPermissionTest(options?: {
  readonly configText?: string | null;
  readonly permissionProps?: CreatePermissionProps;
}): Promise<PermissionTestEnv> {
  const permission = createPermission(options?.permissionProps);
  const probe = capturePermission();
  const harness = createApp({ space: memorySessionSpace() });
  if (options?.configText !== undefined && options?.configText !== null) {
    harness.features.add(createConfig({ persist: fakePersist(options.configText) }));
  }
  harness.features.add(interaction);
  harness.features.add(permission);
  harness.features.add(bindTestTools());
  harness.features.add(probe.feature);
  const session = await harness.open('sess');
  const agents = new Map<string, Agent>();
  const { agent: main } = await session.ensureAgent(MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  agents.set(MAIN_AGENT_ID, main);
  setRequester(harness, 'sess', MAIN_AGENT_ID, createMockRequester());
  await tick();
  const interactions = probe.interactions();
  if (interactions === undefined) throw new Error('interactions were not captured');
  const captured: Interaction[] = [];
  let response: ApprovalResponse = { decision: 'approved' };
  harness.on(interaction, 'interaction.requested', (event) => {
    captured.push(event.interaction);
    interactions.respond(event.interaction.id, response);
  });
  const resolved: PermissionApprovalResolvedEvent[] = [];
  harness.on(permission, 'permission.approval.resolved', (event) => {
    resolved.push(event);
  });
  const runTurn = async (agentId = MAIN_AGENT_ID, text = 'go'): Promise<void> => {
    const agent = agents.get(agentId)!;
    await agent.loop.runTurn(user(text));
    await agent.flush();
  };
  const spawnWorker = async (agentId: string): Promise<Agent> => {
    const { agent: worker } = await session.ensureAgent(agentId, { systemPrompt: 'worker-host' });
    agents.set(agentId, worker);
    setRequester(harness, 'sess', agentId, createMockRequester());
    await tick();
    return worker;
  };
  const remount = async (): Promise<void> => {
    await session.closeAgent(MAIN_AGENT_ID);
    const { agent: reopened } = await session.ensureAgent(MAIN_AGENT_ID, { systemPrompt: 'main-host' });
    agents.set(MAIN_AGENT_ID, reopened);
    setRequester(harness, 'sess', MAIN_AGENT_ID, createMockRequester());
    await tick();
    await probe.store()?.ready;
  };
  const dispose = async (): Promise<void> => {
    await harness.close();
  };
  return {
    harness,
    session,
    captured,
    resolved,
    runTurn,
    spawnWorker,
    remount,
    dispose,
    setResponse: (next) => {
      response = next;
    },
    face: (agentId = MAIN_AGENT_ID) => {
      const face = probe.face(agentId);
      if (face === undefined) throw new Error(`no permission facade captured for agent '${agentId}'`);
      return face;
    },
    storeReady: async () => {
      await probe.store()?.ready;
    },
    agent: (agentId = MAIN_AGENT_ID) => agents.get(agentId)!,
    config: () => probe.config(),
  };
}

function toolResultTexts(agent: Agent): string[] {
  return agent.view
    .getState()
    .messages.filter((entry: HistoryMessage) => entry.message.role === 'tool')
    .map((entry: HistoryMessage) => extractText(entry.message));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('permission feature', () => {
  it('shares one session-scoped state across agents and restores it across remount', async () => {
    const env = await startPermissionTest();
    const face = env.face();
    expect(face.mode()).toBe('manual');
    expect(face.state.value.configured).toBe(false);

    await face.setMode('yolo');
    expect(face.mode()).toBe('yolo');
    await face.setMode('yolo');
    expect(face.state.value.mode).toBe('yolo');

    await env.spawnWorker('worker-1');
    expect(env.face('worker-1').mode()).toBe('yolo');
    await env.face('worker-1').setMode('auto');
    expect(face.mode()).toBe('auto');
    expect(env.face('worker-1').mode()).toBe('auto');

    await env.remount();
    expect(env.face().mode()).toBe('auto');

    await env.face().addRules([{ decision: 'deny', scope: 'user', pattern: 'Bash(sudo *)' }]);
    expect(env.face().state.value.rules).toEqual([
      { decision: 'deny', scope: 'user', pattern: 'Bash(sudo *)' },
    ]);

    await env.dispose();
  });

  it('registers the permission config section with env binding override', async () => {
    vi.stubEnv(DANGEROUS_COMMAND_GUARD_ENV, 'true');
    const env = await startPermissionTest({
      configText: [
        '[permission]',
        'dangerous_command_guard = false',
        '',
        '[[permission.rules]]',
        'decision = "deny"',
        'pattern = "Bash(sudo *)"',
        'reason = "no sudo"',
        '',
        '[[permission.deny]]',
        'tool = "Bash"',
        'match = "rm *"',
        '',
      ].join('\n'),
    });
    expect(env.config()?.get('permission')).toEqual({
      dangerousCommandGuard: true,
      rules: [
        { decision: 'deny', scope: 'user', pattern: 'Bash(sudo *)', reason: 'no sudo' },
        { decision: 'deny', scope: 'user', pattern: 'Bash(rm *)' },
      ],
    });
    await env.dispose();
  });

  it('routes the policy chain across auto, yolo, and manual modes', async () => {
    const env = await startPermissionTest();
    const face = env.face();
    const lastResult = (): string => toolResultTexts(env.agent()).at(-1) ?? '';

    await face.setMode('auto');
    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"rm -rf /"}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(lastResult()).toBe('Bash ok');
    expect(env.captured).toHaveLength(0);

    await face.setMode('yolo');
    queue = [{ toolCall: { name: 'CustomTool', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe('CustomTool ok');
    expect(env.captured).toHaveLength(0);

    await face.setMode('manual');
    env.setResponse({ decision: 'approved' });
    queue = [
      { toolCall: { name: 'CustomTool', arguments: '{"foo":1}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(lastResult()).toBe('CustomTool ok');
    expect(env.captured).toHaveLength(1);
    const request = env.captured[0]!;
    expect(request.kind).toBe('approval');
    const payload = request.payload as Record<string, unknown>;
    expect(payload['id']).toMatch(/^approval_/);
    expect(payload['sessionId']).toBe('sess');
    expect(payload['agentId']).toBe(MAIN_AGENT_ID);
    expect(payload['toolName']).toBe('CustomTool');
    expect(payload['action']).toBe('Approve CustomTool');
    expect(payload['display']).toEqual({
      kind: 'generic',
      summary: 'Approve CustomTool',
      detail: { foo: 1 },
    });
    expect('toolInput' in payload).toBe(false);
    expect(env.resolved.at(-1)).toMatchObject({
      type: 'permission.approval.resolved',
      toolName: 'CustomTool',
      toolInput: { foo: 1 },
      decision: 'approved',
    });

    env.setResponse({ decision: 'rejected', feedback: 'nope' });
    queue = [{ toolCall: { name: 'CustomTool', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe(
      'Tool "CustomTool" was not run because the user rejected the approval request. Reason: nope',
    );

    env.setResponse({ decision: 'cancelled' });
    queue = [{ toolCall: { name: 'CustomTool', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe(
      'Tool "CustomTool" was not run because the approval request was cancelled.',
    );

    await env.dispose();
  });

  it('asks for dangerous commands under the guard and lets yolo through when the guard is off', async () => {
    const env = await startPermissionTest({ configText: '' });
    const face = env.face();
    const lastResult = (): string => toolResultTexts(env.agent()).at(-1) ?? '';

    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"rm -rf /"}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(env.captured).toHaveLength(1);
    expect(lastResult()).toBe('Bash ok');

    await face.setMode('yolo');
    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"sudo rm -rf /"}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(env.captured).toHaveLength(2);
    expect(lastResult()).toBe('Bash ok');

    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"bash -c \\"$SCRIPT\\""}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(env.captured).toHaveLength(3);
    expect(lastResult()).toBe('Bash ok');

    await env.dispose();

    vi.stubEnv(DANGEROUS_COMMAND_GUARD_ENV, 'false');
    const off = await startPermissionTest({ configText: '' });
    const offFace = off.face();
    const offLastResult = (): string => toolResultTexts(off.agent()).at(-1) ?? '';

    await offFace.setMode('yolo');
    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"rm -rf /"}' } },
      { text: 'done' },
    ];
    await off.runTurn();
    expect(off.captured).toHaveLength(0);
    expect(offLastResult()).toBe('Bash ok');

    await offFace.setMode('manual');
    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"rm -rf /"}' } },
      { text: 'done' },
    ];
    await off.runTurn(MAIN_AGENT_ID, 'again');
    expect(off.captured).toHaveLength(1);
    expect(offLastResult()).toBe('Bash ok');

    await off.dispose();
  });

  it('approves repeated calls from the session approval history without asking again', async () => {
    const env = await startPermissionTest();
    const face = env.face();
    const lastResult = (): string => toolResultTexts(env.agent()).at(-1) ?? '';

    env.setResponse({ decision: 'approved', scope: 'session' });
    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"npm test"}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(env.captured).toHaveLength(1);
    expect(lastResult()).toBe('Bash ok');
    expect(face.state.value.sessionApprovalRulePatterns).toEqual(['Bash(npm test)']);
    expect(env.resolved.at(-1)).toMatchObject({ decision: 'approved', scope: 'session' });

    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"npm test"}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(env.captured).toHaveLength(1);
    expect(lastResult()).toBe('Bash ok');

    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"npm run build"}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(env.captured).toHaveLength(2);
    expect(lastResult()).toBe('Bash ok');

    await env.dispose();
  });

  it('applies user-configured rules with deny before allow before the fallback', async () => {
    const env = await startPermissionTest({
      configText: [
        '[[permission.rules]]',
        'decision = "deny"',
        'pattern = "Bash(sudo *)"',
        '',
        '[[permission.rules]]',
        'decision = "allow"',
        'pattern = "Bash(*)"',
        '',
        '[[permission.rules]]',
        'decision = "allow"',
        'pattern = "CustomTool"',
        '',
      ].join('\n'),
    });
    const lastResult = (): string => toolResultTexts(env.agent()).at(-1) ?? '';

    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"sudo ls"}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(lastResult()).toBe('Tool "Bash" was denied by permission rule.');
    expect(env.captured).toHaveLength(0);

    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"ls"}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(lastResult()).toBe('Bash ok');
    expect(env.captured).toHaveLength(0);

    queue = [{ toolCall: { name: 'CustomTool', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe('CustomTool ok');
    expect(env.captured).toHaveLength(0);

    await env.dispose();
  });

  it('approves default whitelisted tools without asking in manual mode', async () => {
    const env = await startPermissionTest();
    queue = [
      { toolCall: { name: 'Read', arguments: '{"path":"/tmp/x"}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(toolResultTexts(env.agent()).at(-1)).toBe('Read ok');
    expect(env.captured).toHaveLength(0);
    await env.dispose();
  });

  it('appends worker guidance to rejection messages for non-main agents', async () => {
    const env = await startPermissionTest();
    await env.spawnWorker('worker-1');
    expect(env.face('worker-1').mode()).toBe('manual');

    env.setResponse({ decision: 'rejected' });
    queue = [{ toolCall: { name: 'CustomTool', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn('worker-1');
    expect(toolResultTexts(env.agent('worker-1')).at(-1)).toBe(
      'Tool "CustomTool" was not run because the user rejected the approval request. Try a different approach — don\'t retry the same call, don\'t attempt to bypass the restriction.',
    );

    await env.dispose();
  });
});
