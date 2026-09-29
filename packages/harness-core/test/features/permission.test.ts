import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigRef,
  createConfig,
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  UNKNOWN_CAPABILITY,
  useAgent,
  useAgentTools,
  type AgentHandle,
  type ConfigPersist,
  type FeatureSpec,
  type LlmModel,
  type LlmRequester,
  type SessionStores,
} from '@moonshot-ai/agent-core';

import {
  interaction,
  InteractionRef,
  type Interaction,
} from '#/features/interaction/index';
import {
  createPermission,
  DANGEROUS_COMMAND_GUARD_ENV,
  PERMISSION_MODE_REMINDER_ENV,
  PERMISSION_REMIND_KEY,
  PermissionRef,
  type ApprovalResponse,
  type CreatePermissionProps,
  type PermissionApprovalResolvedEvent,
} from '#/features/permission/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type ScriptStep = { text: string } | { toolCall: { name: string; arguments: string } };

let queue: ScriptStep[] = [];
let callSeq = 0;

function createMockRequester(): LlmRequester {
  return {
    generate: async (_config, _content, { onEvent }) => {
      const out = queue.shift() ?? { text: 'done' };
      if ('toolCall' in out) {
        onEvent?.({
          type: 'llm.streaming.part',
          part: {
            type: 'function',
            id: `call-${(callSeq += 1)}`,
            name: out.toolCall.name,
            arguments: out.toolCall.arguments,
          },
        });
      } else {
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: out.text } });
      }
      onEvent?.({
        type: 'llm.streaming.usage',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      onEvent?.({ type: 'llm.done' });
    },
  };
}

function bindTestLlm(requester: LlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

const TEST_TOOL_NAMES = ['Bash', 'Write', 'Edit', 'Read', 'CustomTool'];

function bindTestTools(): FeatureSpec {
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

async function startPermissionTest(options?: {
  readonly configText?: string | null;
  readonly permissionProps?: CreatePermissionProps;
}) {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const permission = createPermission(options?.permissionProps);
  const features: FeatureSpec[] = [
    ...(options?.configText !== undefined && options?.configText !== null
      ? [createConfig({ persist: fakePersist(options.configText) })]
      : []),
    interaction,
    permission,
    bindTestTools(),
    bindTestLlm(createMockRequester()),
  ];
  const app = createHarness({ features });
  const session = await app.create({ sessionId: 'sess', stores });
  const agents = new Map<string, AgentHandle>();
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  agents.set(MAIN_AGENT_ID, main);
  const interactions = session.resolve(InteractionRef);
  const captured: Interaction[] = [];
  let response: ApprovalResponse = { decision: 'approved' };
  session.on(interaction, 'interaction.requested', (event) => {
    captured.push(event.interaction);
    interactions.respond(event.interaction.id, response);
  });
  const resolved: PermissionApprovalResolvedEvent[] = [];
  session.on(permission, 'permission.approval.resolved', (event) => {
    resolved.push(event);
  });
  const runTurn = async (agentId = MAIN_AGENT_ID, text = 'go'): Promise<void> => {
    const agent = agents.get(agentId)!;
    const done = new Promise<void>((resolveDone) => {
      agent.on('turn.done', () => {
        resolveDone();
      });
    });
    agent.submit(createUserMessage(text));
    await done;
    await stores.flush();
  };
  const spawnWorker = async (agentId: string): Promise<AgentHandle> => {
    const worker = await session.create({ agentId, systemPrompt: 'worker-host' });
    agents.set(agentId, worker);
    return worker;
  };
  const remount = async (): Promise<void> => {
    await session.close(MAIN_AGENT_ID);
    agents.set(MAIN_AGENT_ID, await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' }));
  };
  const dispose = async (): Promise<void> => {
    await app.disposeAsync();
    await stores.dispose();
  };
  return {
    app,
    session,
    stores,
    captured,
    resolved,
    runTurn,
    spawnWorker,
    remount,
    dispose,
    setResponse: (next: ApprovalResponse): void => {
      response = next;
    },
    get main(): AgentHandle {
      return agents.get(MAIN_AGENT_ID)!;
    },
  };
}

function toolResultTexts(stores: SessionStores, agentId = MAIN_AGENT_ID): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function permissionReminders(stores: SessionStores, agentId = MAIN_AGENT_ID): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === PERMISSION_REMIND_KEY)
    .map((entry) => extractText(entry.message));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('permission feature', () => {
  it('tracks mode through the facade, broadcasts to sibling agents, and restores across remount', async () => {
    const env = await startPermissionTest();
    const face = env.main.resolve(PermissionRef);
    expect(face.mode()).toBe('manual');
    expect(face.state.value.configured).toBe(false);

    await face.setMode('yolo');
    expect(face.mode()).toBe('yolo');
    await face.setMode('yolo');
    expect(face.state.value.mode).toBe('yolo');

    const worker = await env.spawnWorker('worker-1');
    expect(worker.resolve(PermissionRef).mode()).toBe('manual');
    await face.setModeAndBroadcast('auto');
    expect(face.mode()).toBe('auto');
    expect(worker.resolve(PermissionRef).mode()).toBe('auto');

    await worker.resolve(PermissionRef).setMode('manual');
    expect(face.mode()).toBe('auto');
    expect(worker.resolve(PermissionRef).mode()).toBe('manual');

    await env.remount();
    expect(env.main.resolve(PermissionRef).mode()).toBe('auto');

    await env.main.resolve(PermissionRef).addRules([
      { decision: 'deny', scope: 'user', pattern: 'Bash(sudo *)' },
    ]);
    expect(env.main.resolve(PermissionRef).state.value.rules).toEqual([
      { decision: 'deny', scope: 'user', pattern: 'Bash(sudo *)' },
    ]);

    await env.dispose();
  });

  it('registers the permission config section with env binding override', async () => {
    vi.stubEnv(DANGEROUS_COMMAND_GUARD_ENV, 'true');
    const env = await startPermissionTest({
      configText: [
        '[permission]',
        'dangerousCommandGuard = false',
        '',
        '[[permission.rules]]',
        'decision = "deny"',
        'pattern = "Bash(sudo *)"',
        'reason = "no sudo"',
        '',
      ].join('\n'),
    });
    expect(env.app.resolve(ConfigRef).get('permission')).toEqual({
      dangerousCommandGuard: true,
      rules: [{ decision: 'deny', scope: 'user', pattern: 'Bash(sudo *)', reason: 'no sudo' }],
    });
    await env.dispose();
  });

  it('routes the policy chain across auto, yolo, and manual modes', async () => {
    const env = await startPermissionTest();
    const face = env.main.resolve(PermissionRef);
    const lastResult = (): string => toolResultTexts(env.stores).at(-1) ?? '';

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
    const face = env.main.resolve(PermissionRef);
    const lastResult = (): string => toolResultTexts(env.stores).at(-1) ?? '';

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
    const offFace = off.main.resolve(PermissionRef);
    const offLastResult = (): string => toolResultTexts(off.stores).at(-1) ?? '';

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
    const face = env.main.resolve(PermissionRef);
    const lastResult = (): string => toolResultTexts(env.stores).at(-1) ?? '';

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
    const lastResult = (): string => toolResultTexts(env.stores).at(-1) ?? '';

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
    expect(toolResultTexts(env.stores).at(-1)).toBe('Read ok');
    expect(env.captured).toHaveLength(0);
    await env.dispose();
  });

  it('appends worker guidance to rejection messages for non-main agents', async () => {
    const env = await startPermissionTest();
    const worker = await env.spawnWorker('worker-1');
    expect(worker.resolve(PermissionRef).mode()).toBe('manual');

    env.setResponse({ decision: 'rejected' });
    queue = [{ toolCall: { name: 'CustomTool', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn('worker-1');
    expect(toolResultTexts(env.stores, 'worker-1').at(-1)).toBe(
      'Tool "CustomTool" was not run because the user rejected the approval request. Try a different approach — don\'t retry the same call, don\'t attempt to bypass the restriction.',
    );

    await env.dispose();
  });

  it('injects auto mode enter and exit reminders with dedup, gated by the env switch', async () => {
    const env = await startPermissionTest();
    const face = env.main.resolve(PermissionRef);

    await face.setMode('auto');
    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'ok' }];
    await env.runTurn();
    expect(permissionReminders(env.stores)).toHaveLength(1);
    expect(permissionReminders(env.stores)[0]).toContain('Auto permission mode is active.');

    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'ok' }];
    await env.runTurn();
    expect(permissionReminders(env.stores)).toHaveLength(1);

    await face.setMode('manual');
    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'ok' }];
    await env.runTurn();
    expect(permissionReminders(env.stores)).toHaveLength(2);
    expect(permissionReminders(env.stores)[1]).toContain('Auto permission mode is no longer active.');

    await env.dispose();

    vi.stubEnv(PERMISSION_MODE_REMINDER_ENV, 'false');
    const off = await startPermissionTest();
    await off.main.resolve(PermissionRef).setMode('auto');
    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'ok' }];
    await off.runTurn();
    expect(permissionReminders(off.stores)).toHaveLength(0);
    await off.dispose();
  });
});
