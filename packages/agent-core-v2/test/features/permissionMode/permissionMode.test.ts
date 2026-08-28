import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LoopControl } from '#/features/loop/internal/loop';
import { getLoopControl } from '#/features/loop/internal/access';
import {
  AgentContextMemory,
  type ContextMemoryRuntime,
} from '#/features/contextMemory/contextMemoryAgentRuntime';
import type { ContextMessage } from '#/features/contextMemory/types';
import {
  AgentPermissionMode,
  type PermissionModeRuntime,
} from '#/features/permissionMode/permissionModeAgentRuntime';
import { ISessionPermissionModeService } from '#/session/permissionMode/sessionPermissionMode';
import { IWireService } from '#/wire/wire';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  telemetryServices,
  type TestAgentContext,
} from '../../harness';
import { runWillBeginStepHooks } from '../../agent/loop/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

function permissionRecords(persistence: InMemoryWireRecordPersistence) {
  return persistence.records.filter((record) => record.type === 'permission.set_mode');
}

function permissionModeReminders(context: ContextMemoryRuntime): readonly ContextMessage[] {
  return context
    .get()
    .filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'permission_mode',
    );
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('Agent permissionMode (AgentPermissionMode)', () => {
  let ctx: TestAgentContext;
  let permissionMode: PermissionModeRuntime;

  beforeEach(async () => {
    ctx = createTestAgent();
    permissionMode = ctx.resolve(AgentPermissionMode);
    await ctx.restoreRuntimes();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('starts in default mode and maps every wire mode onto the contract vocabulary', async () => {
    expect(permissionMode.mode()).toBe('default');
    expect(permissionMode.configured()).toBe(false);

    await permissionMode.changeMode('auto');
    expect(permissionMode.mode()).toBe('auto');
    expect(permissionMode.configured()).toBe(true);

    await permissionMode.changeMode('dangerous');
    expect(permissionMode.mode()).toBe('dangerous');

    await permissionMode.changeMode('default');
    expect(permissionMode.mode()).toBe('default');
  });

  it('persists wire-vocabulary records and skips redundant dispatches once configured', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    try {
      const runtime = live.resolve(AgentPermissionMode);
      await live.restoreRuntimes();

      await runtime.changeMode('default');
      await live.get(IWireService).flush();
      expect(permissionRecords(persistence)).toEqual([
        {
          type: 'permission.set_mode',
          agentId: 'main',
          mode: 'manual',
          time: expect.any(Number),
        },
      ]);

      await runtime.changeMode('default');
      await live.get(IWireService).flush();
      expect(permissionRecords(persistence)).toHaveLength(1);

      await runtime.changeMode('auto');
      await runtime.changeMode('auto');
      await runtime.changeMode('dangerous');
      await live.get(IWireService).flush();
      expect(permissionRecords(persistence)).toEqual([
        {
          type: 'permission.set_mode',
          agentId: 'main',
          mode: 'manual',
          time: expect.any(Number),
        },
        {
          type: 'permission.set_mode',
          agentId: 'main',
          mode: 'auto',
          time: expect.any(Number),
        },
        {
          type: 'permission.set_mode',
          agentId: 'main',
          mode: 'yolo',
          time: expect.any(Number),
        },
      ]);
      expect(permissionRecords(persistence).every((record) => !('payload' in record))).toBe(true);
    } finally {
      await live.dispose();
    }
  });

  it('notifies observers with contract-vocabulary change events', async () => {
    const changes: { previous: string; current: string }[] = [];
    permissionMode.onDidChange((event) => {
      changes.push({ previous: event.previous, current: event.current });
    });

    await permissionMode.changeMode('default');
    expect(changes).toEqual([]);

    await permissionMode.changeMode('auto');
    expect(changes).toEqual([{ previous: 'default', current: 'auto' }]);

    await permissionMode.changeMode('auto');
    expect(changes).toHaveLength(1);

    await permissionMode.changeMode('dangerous');
    expect(changes).toEqual([
      { previous: 'default', current: 'auto' },
      { previous: 'auto', current: 'dangerous' },
    ]);
  });

  it('rejects changeMode(plan) as not yet mapped to a wire mode', async () => {
    await expect(permissionMode.changeMode('plan')).rejects.toThrow(/'plan'/);
    expect(permissionMode.mode()).toBe('default');
  });

  it('replay rebuilds mode and configured from persisted records without appending', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    try {
      await live.restoreRuntimes();
      await live.resolve(AgentPermissionMode).changeMode('dangerous');
      await live.get(IWireService).flush();
    } finally {
      await live.dispose();
    }
    const written = permissionRecords(persistence);

    const resumed = createTestAgent({ persistence, autoConfigure: false });
    try {
      await resumed.restorePersisted();
      const runtime = resumed.resolve(AgentPermissionMode);

      expect(runtime.mode()).toBe('dangerous');
      expect(runtime.configured()).toBe(true);
      expect(permissionRecords(persistence)).toEqual(written);
    } finally {
      await resumed.dispose();
    }
  });

  it('replays a pre-migration permission.set_mode journal', async () => {
    const persistence = new InMemoryWireRecordPersistence([
      {
        type: 'permission.set_mode',
        agentId: 'main',
        mode: 'yolo',
        time: 1750000000000,
      },
    ]);
    const replayed = createTestAgent({ persistence, autoConfigure: false });
    try {
      await replayed.restorePersisted();

      const runtime = replayed.resolve(AgentPermissionMode);
      expect(runtime.mode()).toBe('dangerous');
      expect(runtime.configured()).toBe(true);
    } finally {
      await replayed.dispose();
    }
  });
});

describe('Agent permissionMode session bridge', () => {
  let ctx: TestAgentContext;
  let records: TelemetryRecord[];

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('applies setModeAndBroadcast to the agent and tracks the afk toggle', async () => {
    records = [];
    ctx = createTestAgent(telemetryServices(recordingTelemetry(records)));
    await ctx.restoreRuntimes();

    await ctx.rpc.setPermission({ mode: 'auto' });

    expect(ctx.get(ISessionPermissionModeService).mode(ctx.agentContext)).toBe('auto');
    expect(records).toContainEqual({
      event: 'afk_toggle',
      properties: { agent_id: 'main', enabled: true },
    });
  });

  it('tracks the yolo toggle on enter and exit', async () => {
    records = [];
    ctx = createTestAgent(telemetryServices(recordingTelemetry(records)));
    await ctx.restoreRuntimes();

    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.rpc.setPermission({ mode: 'manual' });

    expect(ctx.get(ISessionPermissionModeService).mode(ctx.agentContext)).toBe('manual');
    expect(records).toContainEqual({
      event: 'yolo_toggle',
      properties: { agent_id: 'main', enabled: true },
    });
    expect(records).toContainEqual({
      event: 'yolo_toggle',
      properties: { agent_id: 'main', enabled: false },
    });
  });

  it('round-trips the wire vocabulary through setMode and mode', async () => {
    ctx = createTestAgent();
    await ctx.restoreRuntimes();
    const bridge = ctx.get(ISessionPermissionModeService);

    expect(bridge.mode(ctx.agentContext)).toBe('manual');
    expect(bridge.configured(ctx.agentContext)).toBe(false);

    bridge.setMode(ctx.agentContext, 'yolo');
    await ctx.wire.flush();

    expect(bridge.mode(ctx.agentContext)).toBe('yolo');
    expect(bridge.configured(ctx.agentContext)).toBe(true);
    expect(ctx.resolve(AgentPermissionMode).mode()).toBe('dangerous');
  });
});

describe('Agent permissionMode reminder effect', () => {
  let ctx: TestAgentContext;
  let context: ContextMemoryRuntime;
  let loop: LoopControl;
  let permissionMode: PermissionModeRuntime;

  beforeEach(async () => {
    ctx = createTestAgent();
    context = ctx.resolve(AgentContextMemory);
    loop = getLoopControl(ctx.agentContext);
    permissionMode = ctx.resolve(AgentPermissionMode);
    await ctx.restoreRuntimes();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('injects the auto-mode reminder on enter and the exit reminder on leave', async () => {
    await runWillBeginStepHooks(loop);
    expect(permissionModeReminders(context)).toHaveLength(0);

    await permissionMode.changeMode('auto');
    await runWillBeginStepHooks(loop);

    let reminders = permissionModeReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0]!)).toContain('Auto permission mode is active');
    expect(reminders[0]?.origin).toMatchObject({ kind: 'injection', variant: 'permission_mode' });

    await runWillBeginStepHooks(loop);
    expect(permissionModeReminders(context)).toHaveLength(1);

    await permissionMode.changeMode('default');
    await runWillBeginStepHooks(loop);

    reminders = permissionModeReminders(context);
    expect(reminders).toHaveLength(2);
    expect(messageText(reminders[1]!)).toContain('Auto permission mode is no longer active');
  });

  it('re-announces auto mode after undo removes the live reminder', async () => {
    await permissionMode.changeMode('auto');
    void context.append({
      role: 'user',
      content: [{ type: 'text', text: 'first turn' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    await runWillBeginStepHooks(loop);
    expect(permissionModeReminders(context)).toHaveLength(1);

    await expect(context.undo(1)).resolves.toBe(true);
    expect(permissionModeReminders(context)).toHaveLength(0);
    void context.append({
      role: 'user',
      content: [{ type: 'text', text: 'replacement turn' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    await runWillBeginStepHooks(loop);

    const reminders = permissionModeReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0]!)).toContain('Auto permission mode is active');
  });

  it('re-announces auto mode on the first step after a restore', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    try {
      const liveContext = live.resolve(AgentContextMemory);
      const liveLoop = getLoopControl(live.agentContext);
      await live.restoreRuntimes();
      await live.resolve(AgentPermissionMode).changeMode('auto');
      await runWillBeginStepHooks(liveLoop);
      expect(permissionModeReminders(liveContext)).toHaveLength(1);
      await live.get(IWireService).flush();
    } finally {
      await live.dispose();
    }

    const resumed = createTestAgent({ persistence, autoConfigure: false });
    try {
      const resumedContext = resumed.resolve(AgentContextMemory);
      const resumedLoop = getLoopControl(resumed.agentContext);
      await resumed.restorePersisted();
      expect(permissionModeReminders(resumedContext)).toHaveLength(1);

      await runWillBeginStepHooks(resumedLoop);

      const reminders = permissionModeReminders(resumedContext);
      expect(reminders).toHaveLength(2);
      expect(messageText(reminders[1]!)).toContain('Auto permission mode is active');
    } finally {
      await resumed.dispose();
    }
  });
});
