import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
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
  ConfigRef,
  type AgentHandle,
  type FeatureSpec,
  type LlmModel,
  type LlmRequester,
  type SessionStores,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import {
  interaction,
  InteractionRef,
  type Interaction,
} from '#/features/interaction/index';
import { createPermission, PermissionRef } from '#/features/permission/index';
import {
  createMemoryPlanStorage,
  createPlan,
  PLAN_REMIND_KEY,
  PlanRef,
  type MemoryPlanStorage,
  type PlanApprovalResponse,
} from '#/features/plan/index';

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

const TEST_TOOL_NAMES = ['Write', 'Edit', 'Bash', 'Read', 'TaskStop', 'CronCreate', 'CronDelete'];

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

async function startPlanTest(options?: { withConfig?: boolean; withPermission?: boolean }) {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const blobs = openBlobs(backend.blobs);
  const storage = createMemoryPlanStorage();
  const features: FeatureSpec[] = [
    ...(options?.withConfig === true ? [createConfig({})] : []),
    interaction,
    ...(options?.withPermission === true ? [createPermission()] : []),
    createPlan({ storage }),
    bindTestTools(),
    bindTestLlm(createMockRequester()),
  ];
  const app = createHarness({ features });
  const session = await app.create({ sessionId: 'sess', stores });
  let main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  const runTurn = async (text = 'go'): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      main.on('turn.done', () => {
        resolve();
      });
    });
    main.submit(createUserMessage(text));
    await done;
    await stores.flush();
  };
  const remount = async (): Promise<void> => {
    await session.close(MAIN_AGENT_ID);
    main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  };
  const dispose = async (): Promise<void> => {
    await app.disposeAsync();
    await stores.dispose();
  };
  return {
    app,
    session,
    stores,
    storage,
    blobs,
    runTurn,
    remount,
    dispose,
    get main(): AgentHandle {
      return main;
    },
  };
}

function toolResultTexts(stores: SessionStores): string[] {
  return (stores.get(MAIN_AGENT_ID)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(stores: SessionStores): boolean[] {
  return (stores.get(MAIN_AGENT_ID)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function planReminders(stores: SessionStores): string[] {
  return (stores.get(MAIN_AGENT_ID)?.getState().history ?? [])
    .filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === PLAN_REMIND_KEY)
    .map((entry) => extractText(entry.message));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('plan feature', () => {
  it('tracks plan state through enter, clear, revisions, exit, and remount', async () => {
    const env = await startPlanTest();
    const plan = env.main.resolve(PlanRef);
    expect(await plan.status()).toBeNull();

    await plan.enter('p1');
    const path = env.storage.pathFor(MAIN_AGENT_ID, 'p1');
    expect(await plan.status()).toEqual({ id: 'p1', content: '', path });
    await expect(plan.enter('other')).rejects.toThrow('Already in plan mode');

    env.storage.files.set(path, '# Plan\n\n- Draft');
    expect((await plan.status())?.content).toBe('# Plan\n\n- Draft');
    await plan.clear();
    expect((await plan.status())?.content).toBe('');

    env.storage.files.set(path, '# Plan\n\n- v1');
    await plan.recordRevision();
    expect(plan.state.value.revisionCount['p1']).toBe(1);
    const v1ref = sha256('# Plan\n\n- v1');
    expect(Buffer.from(await env.blobs.get(v1ref)).toString('utf8')).toBe('# Plan\n\n- v1');

    env.storage.files.set(path, '# Plan\n\n- v2');
    await plan.recordRevision();
    expect(plan.state.value.revisionCount['p1']).toBe(2);
    expect(Buffer.from(await env.blobs.get(sha256('# Plan\n\n- v2'))).toString('utf8')).toBe(
      '# Plan\n\n- v2',
    );
    expect(await env.blobs.has(v1ref)).toBe(true);

    await plan.exit();
    expect(await plan.status()).toBeNull();

    await plan.enter('p2');
    await env.remount();
    const restored = env.main.resolve(PlanRef);
    expect(await restored.status()).toEqual({
      id: 'p2',
      content: '',
      path: env.storage.pathFor(MAIN_AGENT_ID, 'p2'),
    });
    expect(restored.state.value.revisionCount['p1']).toBe(2);

    await env.dispose();
  });

  it('registers the defaultPlanMode config section with default false', async () => {
    const env = await startPlanTest({ withConfig: true });
    expect(env.app.resolve(ConfigRef).get('defaultPlanMode')).toBe(false);
    await env.dispose();
  });

  it('enters plan mode through the EnterPlanMode tool and rejects re-entry', async () => {
    const env = await startPlanTest();
    queue = [{ toolCall: { name: 'EnterPlanMode', arguments: '{}' } }, { text: 'planning' }];
    await env.runTurn();

    const entered = toolResultTexts(env.stores).at(-1) ?? '';
    expect(entered).toContain('Plan mode is now active. Your workflow:');
    expect(entered).toContain(`Plan file: agents/${MAIN_AGENT_ID}/plans/`);
    expect(toolResultIsErrors(env.stores).at(-1)).toBe(false);
    const plan = env.main.resolve(PlanRef);
    expect(plan.state.value.active).toBe(true);

    queue = [{ toolCall: { name: 'EnterPlanMode', arguments: '{}' } }, { text: 'still planning' }];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe(
      'Plan mode is already active. Use ExitPlanMode when the plan is ready.',
    );
    expect(toolResultIsErrors(env.stores).at(-1)).toBe(true);

    await env.dispose();
  });

  it('guards tool calls while plan mode is active and abstains otherwise', async () => {
    const env = await startPlanTest();
    const plan = env.main.resolve(PlanRef);
    await plan.enter('p-guard');
    const planPath = env.storage.pathFor(MAIN_AGENT_ID, 'p-guard');
    const lastResult = (): string => toolResultTexts(env.stores).at(-1) ?? '';

    queue = [
      { toolCall: { name: 'Write', arguments: JSON.stringify({ file_path: planPath, content: '# P' }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(lastResult()).toBe('Write ok');

    queue = [
      { toolCall: { name: 'Edit', arguments: JSON.stringify({ path: planPath, old_string: 'a', new_string: 'b' }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(lastResult()).toBe('Edit ok');

    queue = [
      { toolCall: { name: 'Write', arguments: JSON.stringify({ file_path: '/tmp/other.ts', content: 'x' }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(lastResult()).toBe(
      `Plan mode is active. You may only write to the current plan file: ${planPath}. ` +
        'Call ExitPlanMode to exit plan mode before editing other files.',
    );

    queue = [
      { toolCall: { name: 'Edit', arguments: JSON.stringify({ file_path: '/tmp/other.ts' }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(lastResult()).toContain(
      'Call ExitPlanMode to exit plan mode before editing other files.',
    );

    queue = [{ toolCall: { name: 'TaskStop', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe(
      'TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode before stopping a background task.',
    );

    for (const name of ['CronCreate', 'CronDelete']) {
      queue = [{ toolCall: { name, arguments: '{}' } }, { text: 'done' }];
      await env.runTurn();
      expect(lastResult()).toBe(
        `${name} is not available in plan mode because it would mutate scheduled work that runs after plan exit. Call ExitPlanMode first.`,
      );
    }

    queue = [
      { toolCall: { name: 'Bash', arguments: '{"command":"ls"}' } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(lastResult()).toBe('Bash ok');

    await plan.exit();
    queue = [
      { toolCall: { name: 'Write', arguments: JSON.stringify({ file_path: '/tmp/other.ts', content: 'x' }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(lastResult()).toBe('Write ok');

    await env.dispose();
  });

  it('runs ExitPlanMode approval through interaction with all outcome branches', async () => {
    const env = await startPlanTest();
    const plan = env.main.resolve(PlanRef);
    const interactions = env.session.resolve(InteractionRef);
    const captured: Interaction[] = [];
    let response: PlanApprovalResponse = { decision: 'approved' };
    env.session.on(interaction, 'interaction.requested', (event) => {
      captured.push(event.interaction);
      interactions.respond(event.interaction.id, response);
    });
    const lastResult = (): string => toolResultTexts(env.stores).at(-1) ?? '';
    const enterWithContent = async (id: string, content: string): Promise<string> => {
      await plan.enter(id);
      const path = env.storage.pathFor(MAIN_AGENT_ID, id);
      env.storage.files.set(path, content);
      return path;
    };

    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe(
      'ExitPlanMode can only be called while plan mode is active. Use EnterPlanMode (or /plan) first.',
    );
    expect(captured).toHaveLength(0);

    response = { decision: 'approved' };
    const approvePath = await enterWithContent('p-approve', '# Plan\n\n- Step 1');
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('approval');
    expect(captured[0]?.payload).toMatchObject({
      plan: '# Plan\n\n- Step 1',
      path: approvePath,
    });
    expect(lastResult()).toBe(
      `Exited plan mode. Plan mode deactivated. All tools are now available.\n` +
        `Plan saved to: ${approvePath}\n\n## Approved Plan:\n# Plan\n\n- Step 1`,
    );
    expect(await plan.status()).toBeNull();
    expect(plan.state.value.revisionCount['p-approve']).toBe(1);

    response = { decision: 'approved', selectedLabel: 'Approach B' };
    await enterWithContent('p-options', '# Plan Options');
    queue = [
      {
        toolCall: {
          name: 'ExitPlanMode',
          arguments: JSON.stringify({
            options: [
              { label: 'Approach A', description: 'Small.' },
              { label: 'Approach B', description: 'Large.' },
            ],
          }),
        },
      },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(captured).toHaveLength(2);
    expect(captured[1]?.payload).toMatchObject({
      options: [{ label: 'Approach A' }, { label: 'Approach B' }],
    });
    expect(lastResult()).toContain(
      'Selected approach: Approach B\nExecute ONLY the selected approach. Do not execute any unselected alternatives.',
    );
    expect(await plan.status()).toBeNull();

    response = { decision: 'cancelled' };
    await enterWithContent('p-cancel', '# Plan Cancel');
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe('Plan approval dismissed. Plan mode remains active.');
    expect((await plan.status())?.id).toBe('p-cancel');

    response = { decision: 'rejected', selectedLabel: 'Revise', feedback: 'Tighten it.' };
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe('User rejected the plan. Feedback:\n\nTighten it.');
    expect((await plan.status())?.id).toBe('p-cancel');

    response = { decision: 'rejected', selectedLabel: 'Reject and Exit' };
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe('Plan rejected by user. Plan mode deactivated.');
    expect(queue).toHaveLength(1);
    expect(await plan.status()).toBeNull();

    response = { decision: 'rejected' };
    await enterWithContent('p-reject', '# Plan Reject');
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe('Plan rejected by user. Plan mode remains active.');
    expect(queue).toHaveLength(1);
    expect((await plan.status())?.id).toBe('p-reject');

    queue = [
      {
        toolCall: {
          name: 'ExitPlanMode',
          arguments: JSON.stringify({ options: [{ label: 'Reject', description: 'reserved' }] }),
        },
      },
      { text: 'done' },
    ];
    const beforeInvalid = captured.length;
    await env.runTurn();
    expect(lastResult()).toBe('Option labels must not use reserved approval labels.');
    expect(captured).toHaveLength(beforeInvalid);
    await plan.exit();

    await enterWithContent('p-empty', '   ');
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(lastResult()).toBe(
      `No plan file found. Write your plan to ${env.storage.pathFor(MAIN_AGENT_ID, 'p-empty')} first, then call ExitPlanMode.`,
    );
    expect(captured).toHaveLength(beforeInvalid);

    await env.dispose();
  });

  it('injects plan reminders with the full and sparse cadence and refreshes on user messages', async () => {
    const env = await startPlanTest();
    const plan = env.main.resolve(PlanRef);
    await plan.enter('p-remind');
    const planPath = env.storage.pathFor(MAIN_AGENT_ID, 'p-remind');

    queue = [
      { toolCall: { name: 'Read', arguments: '{}' } },
      { toolCall: { name: 'Read', arguments: '{}' } },
      { toolCall: { name: 'Read', arguments: '{}' } },
      { toolCall: { name: 'Read', arguments: '{}' } },
      { toolCall: { name: 'Read', arguments: '{}' } },
      { toolCall: { name: 'Read', arguments: '{}' } },
      { text: 'planned' },
    ];
    await env.runTurn('plan it');

    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'continue' }];
    await env.runTurn('again');

    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'wrap' }];
    await env.runTurn('wrap it up');

    const reminders = planReminders(env.stores);
    expect(reminders).toHaveLength(5);
    expect(reminders[0]).toContain('Plan mode is active.');
    expect(reminders[0]).toContain(`Plan file: ${planPath}`);
    expect(reminders[1]).toContain('Plan mode still active');
    expect(reminders[1]).toContain(`Plan file: ${planPath}`);
    expect(reminders[2]).toContain('Plan mode still active');
    expect(reminders[3]).toContain('Plan mode still active');
    expect(reminders[4]).toContain('Plan mode is active.');
    expect(reminders[4]).not.toContain('Plan mode still active');
    expect(reminders[4]).toContain(`Plan file: ${planPath}`);

    await env.dispose();
  });

  it('injects reentry and exit reminders once and keeps them across remount', async () => {
    const env = await startPlanTest();
    const reentryPath = env.storage.pathFor(MAIN_AGENT_ID, 'p-reentry');
    env.storage.files.set(reentryPath, '# Existing Plan\n\n- Keep');
    await env.main.resolve(PlanRef).enter('p-reentry');

    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'ok' }];
    await env.runTurn();
    expect(planReminders(env.stores)).toHaveLength(1);
    expect(planReminders(env.stores)[0]).toContain('Re-entering Plan Mode');
    expect(planReminders(env.stores)[0]).toContain(`Plan file: ${reentryPath}`);

    await env.main.resolve(PlanRef).exit();
    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(planReminders(env.stores)).toHaveLength(2);
    expect(planReminders(env.stores)[1]).toContain('Plan mode is no longer active.');

    await env.remount();
    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(planReminders(env.stores)).toHaveLength(2);

    await env.dispose();
  });

  it('skips ExitPlanMode approval interaction in auto permission mode and records the revision', async () => {
    const env = await startPlanTest({ withPermission: true });
    const plan = env.main.resolve(PlanRef);
    const permission = env.main.resolve(PermissionRef);
    const interactions = env.session.resolve(InteractionRef);
    const captured: Interaction[] = [];
    env.session.on(interaction, 'interaction.requested', (event) => {
      captured.push(event.interaction);
      interactions.respond(event.interaction.id, { decision: 'approved' });
    });

    await permission.setMode('auto');
    await plan.enter('p-auto');
    const path = env.storage.pathFor(MAIN_AGENT_ID, 'p-auto');
    env.storage.files.set(path, '# Plan\n\n- Auto step');
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();

    expect(captured).toHaveLength(0);
    expect(toolResultTexts(env.stores).at(-1)).toBe(
      `Exited plan mode. Plan mode deactivated. All tools are now available.\n` +
        'Note: this plan was auto-approved without user review — the user has NOT explicitly approved it. Follow the user\'s original instructions on whether to proceed with execution; if they asked you to stop, wait, or only summarize after planning, do not start executing.\n' +
        `Plan saved to: ${path}\n\n## Plan (auto-approved, not user-reviewed):\n# Plan\n\n- Auto step`,
    );
    expect(await plan.status()).toBeNull();
    expect(plan.state.value.revisionCount['p-auto']).toBe(1);

    await env.dispose();
  });

  it('keeps the ExitPlanMode approval interaction in manual mode with permission mounted', async () => {
    const env = await startPlanTest({ withPermission: true });
    const plan = env.main.resolve(PlanRef);
    const interactions = env.session.resolve(InteractionRef);
    const captured: Interaction[] = [];
    env.session.on(interaction, 'interaction.requested', (event) => {
      captured.push(event.interaction);
      interactions.respond(event.interaction.id, { decision: 'approved' });
    });

    await plan.enter('p-manual');
    const path = env.storage.pathFor(MAIN_AGENT_ID, 'p-manual');
    env.storage.files.set(path, '# Plan\n\n- Manual step');
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('approval');
    expect(toolResultTexts(env.stores).at(-1)).toBe(
      `Exited plan mode. Plan mode deactivated. All tools are now available.\n` +
        `Plan saved to: ${path}\n\n## Approved Plan:\n# Plan\n\n- Manual step`,
    );
    expect(await plan.status()).toBeNull();

    await env.dispose();
  });
});
