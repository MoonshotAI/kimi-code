import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeature, useAgent, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';

import { createConfig, useConfig, type ConfigPersist, type ConfigStore } from '#/features/config/index';
import {
  interaction,
  InteractionRef,
  type Interaction,
  type Interactions,
} from '#/features/interaction/index';
import {
  createPermission,
  DANGEROUS_COMMAND_GUARD_ENV,
  PERMISSION_MODE_REMINDER_ENV,
  PERMISSION_REMIND_KEY,
  PermissionRef,
  permissionProjection,
  type ApprovalResponse,
  type CreatePermissionProps,
  type PermissionApprovalResolvedEvent,
  type PermissionFace,
  type PermissionState,
  type PermissionStoreEvent,
} from '#/features/permission/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  useFeatureStore,
  type FeatureStore,
  type Harness,
} from '#/runtime/index';

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

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
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
  store(agentId: string): FeatureStore<PermissionState, PermissionStoreEvent> | undefined;
  interactions(): Interactions | undefined;
  config(): ConfigStore | undefined;
}

function capturePermission(): PermissionProbe {
  const faces = new Map<string, Readonly<ShallowRef<PermissionFace | undefined>>>();
  const stores = new Map<string, FeatureStore<PermissionState, PermissionStoreEvent>>();
  let interactionsRef: Readonly<ShallowRef<Interactions | undefined>> | undefined;
  let configRef: Readonly<ShallowRef<ConfigStore | undefined>> | undefined;
  const feature = createFeature('permission-probe', {
    app() {
      configRef = useConfig();
    },
    session() {
      interactionsRef = useInject(InteractionRef);
    },
    agent() {
      const id = useAgent().id;
      faces.set(id, useInject(PermissionRef));
      stores.set(id, useFeatureStore('agent', 'permission', permissionProjection));
    },
  });
  return {
    feature,
    face: (agentId) => faces.get(agentId)?.value,
    store: (agentId) => stores.get(agentId),
    interactions: () => interactionsRef?.value,
    config: () => configRef?.value,
  };
}

interface PermissionTestEnv {
  readonly harness: Harness;
  readonly session: Session;
  readonly captured: Interaction[];
  readonly resolved: PermissionApprovalResolvedEvent[];
  runTurn(agentId?: string, text?: string): Promise<void>;
  spawnWorker(agentId: string): Promise<Agent>;
  remount(): Promise<void>;
  dispose(): Promise<void>;
  setResponse(next: ApprovalResponse): void;
  face(agentId?: string): PermissionFace;
  storeReady(agentId?: string): Promise<void>;
  agent(agentId?: string): Agent;
  config(): ConfigStore | undefined;
}

async function startPermissionTest(options?: {
  readonly configText?: string | null;
  readonly permissionProps?: CreatePermissionProps;
}): Promise<PermissionTestEnv> {
  const permission = createPermission(options?.permissionProps);
  const probe = capturePermission();
  const harness = createHarness({ space: memoryHarnessSpace() });
  if (options?.configText !== undefined && options?.configText !== null) {
    harness.app.features.add(createConfig({ persist: fakePersist(options.configText) }));
  }
  harness.app.features.add(interaction);
  harness.app.features.add(permission);
  harness.app.features.add(bindTestTools());
  harness.app.features.add(probe.feature);
  const session = await harness.app.create({ sessionId: 'sess' });
  const agents = new Map<string, Agent>();
  const main = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  agents.set(MAIN_AGENT_ID, main);
  setRequester(harness, 'sess', MAIN_AGENT_ID, createMockRequester());
  await tick();
  const interactions = probe.interactions();
  if (interactions === undefined) throw new Error('interactions were not captured');
  const captured: Interaction[] = [];
  let response: ApprovalResponse = { decision: 'approved' };
  harness.app.on(interaction, 'interaction.requested', (event) => {
    captured.push(event.interaction);
    interactions.respond(event.interaction.id, response);
  });
  const resolved: PermissionApprovalResolvedEvent[] = [];
  harness.app.on(permission, 'permission.approval.resolved', (event) => {
    resolved.push(event);
  });
  const runTurn = async (agentId = MAIN_AGENT_ID, text = 'go'): Promise<void> => {
    const agent = agents.get(agentId)!;
    await agent.loop.runTurn(user(text));
    await agent.flush();
  };
  const spawnWorker = async (agentId: string): Promise<Agent> => {
    const worker = await harness.ensureAgent(session, agentId, { systemPrompt: 'worker-host' });
    agents.set(agentId, worker);
    setRequester(harness, 'sess', agentId, createMockRequester());
    await tick();
    return worker;
  };
  const remount = async (): Promise<void> => {
    await session.close(MAIN_AGENT_ID);
    const reopened = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
    agents.set(MAIN_AGENT_ID, reopened);
    setRequester(harness, 'sess', MAIN_AGENT_ID, createMockRequester());
    await tick();
    await probe.store(MAIN_AGENT_ID)?.ready;
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
    storeReady: async (agentId = MAIN_AGENT_ID) => {
      await probe.store(agentId)?.ready;
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

function permissionReminders(agent: Agent): string[] {
  return agent.view
    .getState()
    .messages.filter(
      (entry: HistoryMessage) =>
        entry.meta?.source === 'reminder' && entry.meta?.key === PERMISSION_REMIND_KEY,
    )
    .map((entry: HistoryMessage) => extractText(entry.message));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('permission feature', () => {
  it('tracks mode through the facade, broadcasts to sibling agents, and restores across remount', async () => {
    const env = await startPermissionTest();
    const face = env.face();
    expect(face.mode()).toBe('manual');
    expect(face.state.value.configured).toBe(false);

    await face.setMode('yolo');
    expect(face.mode()).toBe('yolo');
    await face.setMode('yolo');
    expect(face.state.value.mode).toBe('yolo');

    await env.spawnWorker('worker-1');
    expect(env.face('worker-1').mode()).toBe('manual');
    await face.setModeAndBroadcast('auto');
    expect(face.mode()).toBe('auto');
    expect(env.face('worker-1').mode()).toBe('auto');

    await env.face('worker-1').setMode('manual');
    expect(face.mode()).toBe('auto');
    expect(env.face('worker-1').mode()).toBe('manual');

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
    queue = [{ toolCall: { name: 'AskUserQuestion', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe(
      'AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.',
    );
    expect(env.captured).toHaveLength(0);

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

  it('injects auto mode enter and exit reminders with dedup, gated by the env switch', async () => {
    const env = await startPermissionTest();
    const face = env.face();

    await face.setMode('auto');
    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'ok' }];
    await env.runTurn();
    expect(permissionReminders(env.agent())).toHaveLength(1);
    expect(permissionReminders(env.agent())[0]).toContain('Auto permission mode is active.');

    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'ok' }];
    await env.runTurn();
    expect(permissionReminders(env.agent())).toHaveLength(1);

    await face.setMode('manual');
    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'ok' }];
    await env.runTurn();
    expect(permissionReminders(env.agent())).toHaveLength(2);
    expect(permissionReminders(env.agent())[1]).toContain('Auto permission mode is no longer active.');

    await env.dispose();

    vi.stubEnv(PERMISSION_MODE_REMINDER_ENV, 'false');
    const off = await startPermissionTest();
    await off.face().setMode('auto');
    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'ok' }];
    await off.runTurn();
    expect(permissionReminders(off.agent())).toHaveLength(0);
    await off.dispose();
  });
});
