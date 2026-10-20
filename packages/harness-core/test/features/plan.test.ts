import { describe, expect, it } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type ToolMeta } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import type { Agent, Session } from '@moonshot-ai/agent-core/session/index';

import { createConfig, ConfigRef, type ConfigStore } from '#/features/config/index';
import {
  interaction,
  InteractionRef,
  type Interaction,
  type Interactions,
} from '#/features/interaction/index';
import {
  createMemoryPlanStorage,
  createPlan,
  PLAN_REMIND_KEY,
  PlanRef,
  type MemoryPlanStorage,
  type PlanApprovalResponse,
  type PlanFace,
} from '#/features/plan/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
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

const TEST_TOOL_NAMES = ['Write', 'Edit', 'Bash', 'Read', 'TaskStop', 'CronCreate', 'CronDelete'];

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

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function capturePlan(): { feature: Feature; face: () => PlanFace | undefined } {
  let exposed: Readonly<ShallowRef<PlanFace | undefined>> | undefined;
  const feature = createFeature('plan-probe', {
    agent: () => {
      exposed = useInject(PlanRef);
    },
  });
  return { feature, face: () => exposed?.value };
}

function captureInteractions(): { feature: Feature; face: () => Interactions | undefined } {
  let exposed: Readonly<ShallowRef<Interactions | undefined>> | undefined;
  const feature = createFeature('interaction-probe', {
    session: () => {
      exposed = useInject(InteractionRef);
    },
  });
  return { feature, face: () => exposed?.value };
}

function captureConfig(): { feature: Feature; face: () => ConfigStore | undefined } {
  let exposed: Readonly<ShallowRef<ConfigStore | undefined>> | undefined;
  const feature = createFeature('config-probe', {
    app: () => {
      exposed = useInject(ConfigRef);
    },
  });
  return { feature, face: () => exposed?.value };
}

interface PlanTestEnv {
  readonly harness: Harness;
  readonly storage: MemoryPlanStorage;
  readonly probe: { face: () => PlanFace | undefined };
  readonly interactionsProbe: { face: () => Interactions | undefined };
  readonly blobs: Session['blobs'];
  readonly puts: { bytes: Uint8Array; ref: string }[];
  readonly agent: () => Agent;
  runTurn(text?: string): Promise<void>;
  remount(): Promise<void>;
}

async function startPlanTest(options?: {
  withConfig?: boolean;
  withInteraction?: boolean;
  permissionMode?: () => string | undefined;
}): Promise<PlanTestEnv> {
  const harness = createHarness({ space: memoryHarnessSpace() });
  const storage = createMemoryPlanStorage();
  if (options?.withConfig === true) await harness.app.features.add(createConfig({}));
  if (options?.withInteraction !== false) await harness.app.features.add(interaction);
  const probe = capturePlan();
  const interactionsProbe = captureInteractions();
  await harness.app.features.add(createPlan({ storage, permissionMode: options?.permissionMode }));
  await harness.app.features.add(probe.feature);
  await harness.app.features.add(interactionsProbe.feature);
  await harness.app.features.add(bindTestTools());
  const session = await harness.app.create({ sessionId: 's1' });
  const puts: { bytes: Uint8Array; ref: string }[] = [];
  const basePut = session.blobs.put.bind(session.blobs);
  session.blobs.put = async (content) => {
    const result = await basePut(content);
    puts.push({ bytes: content.bytes, ref: result.ref });
    return result;
  };
  let agent = await harness.ensureAgent(session, 'main', { systemPrompt: 'HOST' });
  setRequester(harness, 's1', 'main', createMockRequester());
  await tick();
  return {
    harness,
    storage,
    probe,
    interactionsProbe,
    blobs: session.blobs,
    puts,
    agent: () => agent,
    runTurn: async (text = 'go') => {
      const outcome = await agent.loop.runTurn(user(text));
      expect(outcome.type).toBe('done');
      await agent.flush();
    },
    remount: async () => {
      await session.close('main');
      await tick();
      agent = await harness.ensureAgent(session, 'main', { systemPrompt: 'HOST' });
      setRequester(harness, 's1', 'main', createMockRequester());
      await tick();
    },
  };
}

function planOf(env: PlanTestEnv): PlanFace {
  const face = env.probe.face();
  if (face === undefined) throw new Error('plan facade is not exposed');
  return face;
}

function history(env: PlanTestEnv) {
  return env.agent().view.getState().messages;
}

function toolResultTexts(env: PlanTestEnv): string[] {
  return history(env)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(env: PlanTestEnv): boolean[] {
  return history(env)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function planReminders(env: PlanTestEnv): string[] {
  return history(env)
    .filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === PLAN_REMIND_KEY)
    .map((entry) => extractText(entry.message));
}

describe('plan feature', () => {
  it('tracks plan state through enter, clear, revisions, exit, and remount', async () => {
    const env = await startPlanTest();
    const plan = planOf(env);
    expect(await plan.status()).toBeNull();

    await plan.enter('p1');
    const path = env.storage.pathFor('main', 'p1');
    expect(await plan.status()).toEqual({ id: 'p1', content: '', path });
    await expect(plan.enter('other')).rejects.toThrow('Already in plan mode');

    env.storage.files.set(path, '# Plan\n\n- Draft');
    expect((await plan.status())?.content).toBe('# Plan\n\n- Draft');
    await plan.clear();
    expect((await plan.status())?.content).toBe('');

    env.storage.files.set(path, '# Plan\n\n- v1');
    await plan.recordRevision();
    expect(plan.state.value.revisionCount['p1']).toBe(1);
    expect(env.puts).toHaveLength(1);
    expect(Buffer.from(env.puts[0]!.bytes).toString('utf8')).toBe('# Plan\n\n- v1');
    const v1ref = env.puts[0]!.ref;

    env.storage.files.set(path, '# Plan\n\n- v2');
    await plan.recordRevision();
    expect(plan.state.value.revisionCount['p1']).toBe(2);
    expect(env.puts).toHaveLength(2);
    expect(Buffer.from(env.puts[1]!.bytes).toString('utf8')).toBe('# Plan\n\n- v2');
    const v1blob = await env.blobs.get(v1ref);
    expect(Buffer.from(v1blob!.bytes).toString('utf8')).toBe('# Plan\n\n- v1');

    await plan.exit();
    expect(await plan.status()).toBeNull();

    await plan.enter('p2');
    await env.remount();
    const restored = planOf(env);
    expect(await restored.status()).toEqual({
      id: 'p2',
      content: '',
      path: env.storage.pathFor('main', 'p2'),
    });
    expect(restored.state.value.revisionCount['p1']).toBe(2);

    await env.harness.close();
  });

  it('registers the defaultPlanMode config section and fails agent setup without the interaction feature', async () => {
    const configProbe = captureConfig();
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(createConfig({}));
    await harness.app.features.add(configProbe.feature);
    await harness.app.features.add(interaction);
    await harness.app.features.add(createPlan({ storage: createMemoryPlanStorage() }));
    await tick();
    expect(configProbe.face()?.get('defaultPlanMode')).toBe(false);
    await harness.close();

    const errors: unknown[] = [];
    const broken = createHarness({ space: memoryHarnessSpace() });
    broken.app.on('unit.error', (event) => {
      errors.push((event as { error?: unknown }).error);
    });
    await broken.app.features.add(createPlan({ storage: createMemoryPlanStorage() }));
    const session = await broken.app.create({ sessionId: 's1' });
    await broken.ensureAgent(session, 'main');
    await tick();
    expect(
      errors.some(
        (error) => error instanceof Error && error.message === 'plan feature requires the interaction feature',
      ),
    ).toBe(true);
    await broken.close();
  });

  it('enters plan mode through the EnterPlanMode tool and rejects re-entry', async () => {
    const env = await startPlanTest();
    queue = [{ toolCall: { name: 'EnterPlanMode', arguments: '{}' } }, { text: 'planning' }];
    await env.runTurn();

    const entered = toolResultTexts(env).at(-1) ?? '';
    expect(entered).toContain('Plan mode is now active. Your workflow:');
    expect(entered).toContain('Plan file: agents/main/plans/');
    expect(toolResultIsErrors(env).at(-1)).toBe(false);
    expect(planOf(env).state.value.active).toBe(true);

    queue = [{ toolCall: { name: 'EnterPlanMode', arguments: '{}' } }, { text: 'still planning' }];
    await env.runTurn();
    expect(toolResultTexts(env).at(-1)).toBe(
      'Plan mode is already active. Use ExitPlanMode when the plan is ready.',
    );
    expect(toolResultIsErrors(env).at(-1)).toBe(true);

    await env.harness.close();
  });

  it('guards tool calls while plan mode is active and abstains otherwise', async () => {
    const env = await startPlanTest();
    const plan = planOf(env);
    await plan.enter('p-guard');
    const planPath = env.storage.pathFor('main', 'p-guard');
    const lastResult = (): string => toolResultTexts(env).at(-1) ?? '';

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

    await env.harness.close();
  });

  it('runs ExitPlanMode approval through interaction with all outcome branches', async () => {
    const env = await startPlanTest();
    const plan = planOf(env);
    const interactions = env.interactionsProbe.face();
    if (interactions === undefined) throw new Error('interactions facade is not exposed');
    const captured: Interaction[] = [];
    let response: PlanApprovalResponse = { decision: 'approved' };
    env.harness.app.on(interaction, 'interaction.requested', (event) => {
      captured.push(event.interaction);
      interactions.respond(event.interaction.id, response);
    });
    const lastResult = (): string => toolResultTexts(env).at(-1) ?? '';
    const enterWithContent = async (id: string, content: string): Promise<string> => {
      await plan.enter(id);
      const path = env.storage.pathFor('main', id);
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
      `No plan file found. Write your plan to ${env.storage.pathFor('main', 'p-empty')} first, then call ExitPlanMode.`,
    );
    expect(captured).toHaveLength(beforeInvalid);

    await env.harness.close();
  });

  it('injects plan reminders with the full and sparse cadence and refreshes on user messages', async () => {
    const env = await startPlanTest();
    const plan = planOf(env);
    await plan.enter('p-remind');
    const planPath = env.storage.pathFor('main', 'p-remind');

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

    const reminders = planReminders(env);
    expect(reminders).toHaveLength(6);
    expect(reminders[0]).toContain('Plan mode is active.');
    expect(reminders[0]).toContain(`Plan file: ${planPath}`);
    expect(reminders[1]).toContain('Plan mode still active');
    expect(reminders[1]).toContain(`Plan file: ${planPath}`);
    expect(reminders[2]).toContain('Plan mode still active');
    expect(reminders[3]).toContain('Plan mode still active');
    expect(reminders[4]).toContain('Plan mode is active.');
    expect(reminders[4]).not.toContain('Plan mode still active');
    expect(reminders[4]).toContain(`Plan file: ${planPath}`);
    expect(reminders[5]).toContain('Plan mode is active.');
    expect(reminders[5]).not.toContain('Plan mode still active');
    expect(reminders[5]).toContain(`Plan file: ${planPath}`);

    await env.harness.close();
  });

  it('injects reentry and exit reminders once and keeps them across remount', async () => {
    const env = await startPlanTest();
    const reentryPath = env.storage.pathFor('main', 'p-reentry');
    env.storage.files.set(reentryPath, '# Existing Plan\n\n- Keep');
    await planOf(env).enter('p-reentry');

    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'ok' }];
    await env.runTurn();
    expect(planReminders(env)).toHaveLength(1);
    expect(planReminders(env)[0]).toContain('Re-entering Plan Mode');
    expect(planReminders(env)[0]).toContain(`Plan file: ${reentryPath}`);

    await planOf(env).exit();
    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(planReminders(env)).toHaveLength(2);
    expect(planReminders(env)[1]).toContain('Plan mode is no longer active.');

    await env.remount();
    queue = [{ toolCall: { name: 'Read', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(planReminders(env)).toHaveLength(2);

    await env.harness.close();
  });

  it('skips ExitPlanMode approval interaction in auto permission mode and records the revision', async () => {
    const env = await startPlanTest({ permissionMode: () => 'auto' });
    const plan = planOf(env);
    const captured: Interaction[] = [];
    env.harness.app.on(interaction, 'interaction.requested', (event) => {
      captured.push(event.interaction);
    });

    await plan.enter('p-auto');
    const path = env.storage.pathFor('main', 'p-auto');
    env.storage.files.set(path, '# Plan\n\n- Auto step');
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();

    expect(captured).toHaveLength(0);
    expect(toolResultTexts(env).at(-1)).toBe(
      `Exited plan mode. Plan mode deactivated. All tools are now available.\n` +
        'Note: this plan was auto-approved without user review — the user has NOT explicitly approved it. Follow the user\'s original instructions on whether to proceed with execution; if they asked you to stop, wait, or only summarize after planning, do not start executing.\n' +
        `Plan saved to: ${path}\n\n## Plan (auto-approved, not user-reviewed):\n# Plan\n\n- Auto step`,
    );
    expect(await plan.status()).toBeNull();
    expect(plan.state.value.revisionCount['p-auto']).toBe(1);

    await env.harness.close();
  });

  it('keeps the ExitPlanMode approval interaction in manual mode with permission mounted', async () => {
    const env = await startPlanTest({ permissionMode: () => 'manual' });
    const plan = planOf(env);
    const interactions = env.interactionsProbe.face();
    if (interactions === undefined) throw new Error('interactions facade is not exposed');
    const captured: Interaction[] = [];
    env.harness.app.on(interaction, 'interaction.requested', (event) => {
      captured.push(event.interaction);
      interactions.respond(event.interaction.id, { decision: 'approved' });
    });

    await plan.enter('p-manual');
    const path = env.storage.pathFor('main', 'p-manual');
    env.storage.files.set(path, '# Plan\n\n- Manual step');
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('approval');
    expect(toolResultTexts(env).at(-1)).toBe(
      `Exited plan mode. Plan mode deactivated. All tools are now available.\n` +
        `Plan saved to: ${path}\n\n## Approved Plan:\n# Plan\n\n- Manual step`,
    );
    expect(await plan.status()).toBeNull();

    await env.harness.close();
  });
});
