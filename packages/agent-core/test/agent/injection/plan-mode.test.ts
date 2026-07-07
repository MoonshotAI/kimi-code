import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import { PlanModeInjector } from '../../../src/agent/injection/plan-mode';

interface PlanModeStub {
  isActive: boolean;
  planFilePath?: string | null;
}

function planAgent(stub: PlanModeStub): Agent {
  const history: unknown[] = [];
  return {
    type: 'main',
    planMode: {
      get isActive() {
        return stub.isActive;
      },
      get planFilePath() {
        return stub.planFilePath ?? null;
      },
    },
    context: {
      history,
      appendSystemReminder: (content: string) => {
        history.push({ role: 'user', content: [{ type: 'text', text: content }] });
      },
    },
  } as unknown as Agent;
}

function history(agent: Agent): Array<{ role: string; content?: ReadonlyArray<{ text?: string }> }> {
  return agent.context.history as unknown as Array<{
    role: string;
    content?: ReadonlyArray<{ text?: string }>;
  }>;
}

function lastReminder(agent: Agent): string {
  const last = history(agent).findLast((message) => message.role === 'user');
  return last?.content?.map((part) => part.text ?? '').join('') ?? '';
}

describe('PlanModeInjector content', () => {
  it('injects the full reminder with the current plan file footer', async () => {
    const agent = planAgent({ isActive: true, planFilePath: '/tmp/plan.md' });
    const injector = new PlanModeInjector(agent);

    await injector.inject();
    const text = lastReminder(agent);

    expect(text).toContain('Plan mode is active');
    expect(text).toContain('current plan file');
    expect(text).toContain('Write');
    expect(text).toContain('Edit');
    expect(text).toContain('ExitPlanMode');
    expect(text).toContain('Plan file: /tmp/plan.md');
    // TaskStop/CronCreate/CronDelete are hard-denied in plan mode
    // (plan-mode-guard-deny.ts); the reminder must name them.
    expect(text).toContain('TaskStop');
  });

  it('uses the inline reminder when no plan file path is available', async () => {
    const agent = planAgent({ isActive: true, planFilePath: null });
    const injector = new PlanModeInjector(agent);

    await injector.inject();

    const text = lastReminder(agent);
    expect(text).toContain('Plan mode is active');
    expect(text).toContain('Wait for the host to provide a plan file path');
    expect(text).not.toContain('Plan file:');
  });

  it('injects the exit reminder when plan mode turns off after being active', async () => {
    const stub: PlanModeStub = { isActive: true, planFilePath: '/tmp/plan.md' };
    const agent = planAgent(stub);
    const injector = new PlanModeInjector(agent);

    await injector.inject();
    stub.isActive = false;
    await injector.inject();

    expect(lastReminder(agent)).toContain('Plan mode is no longer active');
  });

  it('does not inject anything when plan mode is inactive from the start', async () => {
    const agent = planAgent({ isActive: false });
    const injector = new PlanModeInjector(agent);

    await injector.inject();

    expect(history(agent)).toHaveLength(0);
  });
});

describe('PlanModeInjector cadence', () => {
  it('skips reinjection before the assistant-turn threshold', async () => {
    const agent = planAgent({ isActive: true, planFilePath: '/tmp/plan.md' });
    const injector = new PlanModeInjector(agent);

    await injector.inject();
    const messages = history(agent);
    messages.push({ role: 'assistant' });
    await injector.inject();

    expect(messages).toHaveLength(2);
  });

  it('injects the sparse reminder after the short assistant-turn threshold', async () => {
    const agent = planAgent({ isActive: true, planFilePath: '/tmp/plan.md' });
    const injector = new PlanModeInjector(agent);

    await injector.inject();
    const messages = history(agent);
    messages.push({ role: 'assistant' }, { role: 'assistant' });
    await injector.inject();

    const text = lastReminder(agent);
    expect(text).toContain('Plan mode still active');
    expect(text).toContain('see full instructions earlier');
    expect(text).toContain('Plan file: /tmp/plan.md');
  });

  it('refreshes the full reminder after the long assistant-turn threshold', async () => {
    const agent = planAgent({ isActive: true, planFilePath: '/tmp/plan.md' });
    const injector = new PlanModeInjector(agent);

    await injector.inject();
    const messages = history(agent);
    for (let i = 0; i < 5; i += 1) {
      messages.push({ role: 'assistant' });
    }
    await injector.inject();

    const text = lastReminder(agent);
    expect(text).toContain('Plan mode is active');
    expect(text).not.toContain('Plan mode still active');
  });

  it('refreshes the full reminder if a user message appears after the last injection', async () => {
    const agent = planAgent({ isActive: true, planFilePath: '/tmp/plan.md' });
    const injector = new PlanModeInjector(agent);

    await injector.inject();
    history(agent).push({ role: 'user', content: [{ text: 'next task' }] });
    await injector.inject();

    const text = lastReminder(agent);
    expect(text).toContain('Plan mode is active');
    expect(text).not.toContain('Plan mode still active');
  });
});
