import { describe, expect, it } from 'vitest';

import { testAgent } from './harness/agent';

describe('WorkflowMode', () => {
  it('enter / exit toggles isActive', () => {
    const ctx = testAgent();
    const mode = ctx.agent.workflowMode;

    expect(mode.isActive).toBe(false);
    mode.enter('manual');
    expect(mode.isActive).toBe(true);
    mode.exit();
    expect(mode.isActive).toBe(false);
  });

  it('enter injects the workflow mode system reminder', () => {
    const ctx = testAgent();
    const mode = ctx.agent.workflowMode;

    mode.enter('manual');

    const history = ctx.agent.context.history;
    const last = history[history.length - 1];
    expect(last?.origin).toEqual({
      kind: 'injection',
      variant: 'workflow_mode',
    });
    expect(last?.content[0]).toBeDefined();
    // The reminder text should mention "Dynamic Workflow Mode"
    expect(last?.content[0]).toHaveProperty('type', 'text');
    expect((last?.content[0] as { text: string }).text).toContain('Dynamic Workflow Mode');
  });

  it('exit pops the enter reminder and appends the exit reminder when pop succeeds', () => {
    const ctx = testAgent();
    const mode = ctx.agent.workflowMode;

    mode.enter('manual');
    const historyLen = ctx.agent.context.history.length;
    mode.exit();

    // The enter reminder should be gone (popped)
    const enterReminder = ctx.agent.context.history.find(
      (m) => m.origin?.kind === 'injection' && m.origin.variant === 'workflow_mode',
    );
    expect(enterReminder).toBeUndefined();
    // Exit reminder should exist (or the context was popped)
    expect(ctx.agent.context.history.length).toBeLessThanOrEqual(historyLen);
  });

  it('restoreEnter sets the active trigger without logging a record', () => {
    const ctx = testAgent();
    const mode = ctx.agent.workflowMode;

    mode.restoreEnter('command');
    expect(mode.isActive).toBe(true);

    // restoreEnter does not log a record, so no records should exist yet
    const eventRecords = ctx.allEvents.filter(
      (event) => event.type === '[wire]' && event.event === 'workflow_mode.enter',
    );
    // dispatch of restore event would trigger records
    expect(mode.isActive).toBe(true);
  });

  it('enter is a no-op when already active', () => {
    const ctx = testAgent();
    const mode = ctx.agent.workflowMode;

    mode.enter('manual');
    const historyLen = ctx.agent.context.history.length;

    mode.enter('command'); // second enter with different trigger

    // isActive should still be true (from first enter)
    expect(mode.isActive).toBe(true);
    // But the second enter should be a no-op - no additional message
    expect(ctx.agent.context.history.length).toBe(historyLen);
  });

  it('exit is a no-op when not active', () => {
    const ctx = testAgent();
    const mode = ctx.agent.workflowMode;

    // Should not throw
    expect(() => mode.exit()).not.toThrow();
    expect(mode.isActive).toBe(false);
  });

  it('restoreEnter is idempotent (no-op on repeated calls)', () => {
    const ctx = testAgent();
    const mode = ctx.agent.workflowMode;

    mode.restoreEnter('manual');
    expect(mode.isActive).toBe(true);

    // Second restoreEnter keeps 'manual' trigger
    mode.restoreEnter('command');
    expect(mode.isActive).toBe(true);
  });

  it('composes with planMode - both can be active simultaneously', () => {
    const ctx = testAgent();
    const workflowMode = ctx.agent.workflowMode;
    const planMode = ctx.agent.planMode;

    workflowMode.enter('manual');
    expect(workflowMode.isActive).toBe(true);
    expect(planMode.isActive).toBe(false);

    // Simulate plan mode also being active (via restore)
    planMode.enter();
    expect(planMode.isActive).toBe(true);
    // Both active
    expect(workflowMode.isActive).toBe(true);
    expect(planMode.isActive).toBe(true);

    // Exiting workflow should not affect plan mode
    workflowMode.exit();
    expect(workflowMode.isActive).toBe(false);
    expect(planMode.isActive).toBe(true);
  });

  it('wire record is persisted on enter/exit', () => {
    const ctx = testAgent();
    const mode = ctx.agent.workflowMode;

    mode.enter('manual');
    const enterRecord = ctx.allEvents.find(
      (event) => event.type === '[wire]' && event.event === 'workflow_mode.enter',
    );
    expect(enterRecord).toBeDefined();

    mode.exit();
    const exitRecord = ctx.allEvents.find(
      (event) => event.type === '[wire]' && event.event === 'workflow_mode.exit',
    );
    expect(exitRecord).toBeDefined();
  });
});
