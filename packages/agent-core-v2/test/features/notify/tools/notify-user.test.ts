import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ILogService } from '#/_base/log/log';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { type HostUiCapability, IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { NOTIFY_USER_FLAG_ENV, NOTIFY_USER_FLAG_ID, notifyUserFlag } from '#/features/notify/flag';
import {
  NOTIFY_USER_UI_CAPABILITY,
  notifyUserAvailable,
} from '#/features/notify/notifyUserAvailability';
import {
  INotifyUserTool,
  NOTIFY_USER_DELIVERED_OUTPUT,
  NOTIFY_USER_EMPTY_MESSAGE,
  NOTIFY_USER_EMPTY_TITLE,
  NOTIFY_USER_SUPPRESSED_OUTPUT,
  NOTIFY_USER_TOOL_NAME,
  NotifyUserInputSchema,
} from '#/features/notify/tools/notify-user/notify-user';
import { NotifyUserTool } from '#/features/notify/tools/notify-user/notifyUserTool';
import { NOTIFY_USER_NUDGE_VARIANT } from '#/features/notify/notifyUserNudge';
import { SubagentUpdate } from '#/features/notify/subagentUpdate';
import type { Event2 } from '#/app/event/event2';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { recordingTelemetry, type TelemetryRecord } from '../../../app/telemetry/stubs';
import { executeTool } from '../../../tools/fixtures/execute-tool';

import { createTestAgent, type TestAgentContext } from '../../../harness';

const signal = new AbortController().signal;

describe('NotifyUserTool', () => {
  let ctx: TestAgentContext;
  let telemetry: TelemetryRecord[];

  beforeEach(async () => {
    telemetry = [];
    ctx = createTestAgent({ telemetry: recordingTelemetry(telemetry) });
    ctx.get(IFlagService).setConfigOverrides({ notify_user: true });
    Object.assign(ctx.get(IBootstrapService).args, { uiCapabilities: [NOTIFY_USER_UI_CAPABILITY] });
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('has name, description, and parameters from the current schema', () => {
    const tool = ctx.get(INotifyUserTool);

    expect(NOTIFY_USER_TOOL_NAME).toBe('NotifyUser');
    expect(tool.name).toBe(NOTIFY_USER_TOOL_NAME);
    expect(tool.description).toContain('When to use');
    expect(
      NotifyUserInputSchema.safeParse({
        title: 'Reading the parser first',
        message: 'The tokenizer is the likely culprit.',
      }).success,
    ).toBe(true);
    expect(NotifyUserInputSchema.safeParse({ message: 'Reading the parser first.' }).success).toBe(
      false,
    );
    expect(NotifyUserInputSchema.safeParse({ title: 'Reading', message: '' }).success).toBe(false);
    expect(NotifyUserInputSchema.safeParse({ title: '', message: 'Reading' }).success).toBe(false);
    expect(NotifyUserInputSchema.safeParse({}).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['title', 'message'],
      properties: {
        title: { type: 'string' },
        message: { type: 'string' },
      },
    });
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual([
      'title',
      'message',
    ]);
  });

  it('is on by default, can still be turned off, and the default profile allows it', () => {
    expect(ctx.get(IAgentToolPolicyService).isToolActive(NOTIFY_USER_TOOL_NAME)).toBe(true);
    expect(notifyUserFlag.id).toBe(NOTIFY_USER_FLAG_ID);
    expect(notifyUserFlag.env).toBe(NOTIFY_USER_FLAG_ENV);
    expect(notifyUserFlag.default).toBe(true);

    const flags = ctx.get(IFlagService);
    flags.setConfigOverrides({});
    expect(flags.enabled(NOTIFY_USER_FLAG_ID)).toBe(true);
    flags.setConfigOverrides({ notify_user: false });
    expect(flags.enabled(NOTIFY_USER_FLAG_ID)).toBe(false);
  });

  it('is offered only when the flag is on and the host renders the update panel', () => {
    const flags = (enabled: boolean) => ({ enabled: () => enabled }) as unknown as IFlagService;
    const host = (uiCapabilities?: readonly HostUiCapability[]) =>
      ({ args: { requestHeaders: {}, uiCapabilities } }) as unknown as IBootstrapService;

    expect(notifyUserAvailable(flags(true), host([NOTIFY_USER_UI_CAPABILITY]))).toBe(true);
    expect(notifyUserAvailable(flags(true), host([]))).toBe(false);
    expect(notifyUserAvailable(flags(true), host(undefined))).toBe(false);
    expect(notifyUserAvailable(flags(false), host([NOTIFY_USER_UI_CAPABILITY]))).toBe(false);
  });

  it('acknowledges the update without touching any resource', async () => {
    const tool = ctx.get(INotifyUserTool);
    const execution = tool.resolveExecution({
      title: 'Login module is clean',
      message: 'The bug is in session expiry.',
    });

    expect(execution).toMatchObject({
      description: 'Notifying the user',
      approvalRule: NOTIFY_USER_TOOL_NAME,
      accesses: [],
    });

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { title: 'Login module is clean', message: 'The bug is in session expiry.' },
      signal,
    });

    expect(result).toEqual({ isError: false, output: NOTIFY_USER_DELIVERED_OUTPUT });
  });

  it('tracks each update with the silent stretch that preceded it', async () => {
    const context = ctx.get(IAgentContextMemoryService);
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'do the thing' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    context.append({
      role: 'assistant',
      content: [],
      toolCalls: [
        { type: 'function', id: 'call_a', name: 'Bash', arguments: '{}' },
        { type: 'function', id: 'call_b', name: 'Read', arguments: '{}' },
      ],
    });
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'nudge' }],
      toolCalls: [],
      origin: { kind: 'injection', variant: NOTIFY_USER_NUDGE_VARIANT },
    });
    context.append({
      role: 'assistant',
      content: [],
      toolCalls: [{ type: 'function', id: 'call_notify', name: NOTIFY_USER_TOOL_NAME, arguments: '{}' }],
    });

    await executeTool(ctx.get(INotifyUserTool), {
      turnId: 3,
      toolCallId: 'call_notify',
      args: { title: 'Parser checked', message: 'No issues in the tokenizer.' },
      signal,
    });

    const sent = telemetry.filter((record) => record.event === 'notify_user_sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.properties).toMatchObject({
      turn_id: 3,
      rounds_since_notify: 1,
      after_nudge: true,
      title_chars: 'Parser checked'.length,
      message_chars: 'No issues in the tokenizer.'.length,
      displayed: true,
    });
  });

  it('rejects a whitespace-only message before execution', async () => {
    const tool = ctx.get(INotifyUserTool);

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { title: 'Checking', message: '   \n' },
      signal,
    });

    expect(result).toEqual({ isError: true, output: NOTIFY_USER_EMPTY_MESSAGE });
  });

  it('rejects a whitespace-only title before execution', async () => {
    const tool = ctx.get(INotifyUserTool);

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { title: ' \n ', message: 'The parser is fine.' },
      signal,
    });

    expect(result).toEqual({ isError: true, output: NOTIFY_USER_EMPTY_TITLE });
    expect(telemetry.filter((record) => record.event === 'notify_user_sent')).toHaveLength(0);
  });

  it('acknowledges without displaying after the feature is disabled', async () => {
    const tool = ctx.get(INotifyUserTool);
    const execution = tool.resolveExecution({ title: 'Starting', message: 'Starting the checks.' });
    ctx.get(IFlagService).setConfigOverrides({ notify_user: false });
    const disabled = tool.resolveExecution({ title: 'Hidden', message: 'Should not appear.' });
    if (!('execute' in disabled)) throw new Error('Expected executable tool');
    expect(await disabled.execute({ signal } as never)).toEqual({
      isError: false,
      output: NOTIFY_USER_SUPPRESSED_OUTPUT,
    });
    if (!('execute' in execution)) throw new Error('Expected executable tool');
    expect(await execution.execute({ signal } as never)).toEqual({
      isError: false,
      output: NOTIFY_USER_SUPPRESSED_OUTPUT,
    });
  });

  it('acknowledges without displaying in a host without the panel', async () => {
    Object.assign(ctx.get(IBootstrapService).args, { uiCapabilities: [] });
    const execution = ctx
      .get(INotifyUserTool)
      .resolveExecution({ title: 'Hidden', message: 'Should not appear.' });
    if (!('execute' in execution)) throw new Error('Expected executable tool');
    expect(await execution.execute({ signal } as never)).toEqual({
      isError: false,
      output: NOTIFY_USER_SUPPRESSED_OUTPUT,
    });
    expect(telemetry.find((record) => record.event === 'notify_user_sent')?.properties).toMatchObject({
      displayed: false,
    });
  });
  describe('forwarding subagent updates to the parent agent', () => {
    interface Forwarding {
      readonly tool: NotifyUserTool;
      readonly dispatched: Event2[];
      readonly warnings: string[];
    }

    function forwardingTool(
      agentId: string,
      readMeta: () => Promise<Partial<SessionMeta>>,
    ): Forwarding {
      const dispatched: Event2[] = [];
      const warnings: string[] = [];
      const dispatcher = {
        dispatch: (event: Event2) => {
          dispatched.push(event);
          return Promise.resolve();
        },
      } as unknown as IEventDispatcher;
      const parent = {
        id: 'main',
        accessor: { get: (id: unknown) => (id === IEventDispatcher ? dispatcher : undefined) },
      } as unknown as IAgentScopeHandle;
      const agents = {
        handleOf: (id: string) => (id === 'main' ? parent : undefined),
      } as unknown as IAgentLifecycleService;
      const metadata = { read: readMeta } as unknown as ISessionMetadata;
      const scope = { agentId } as unknown as IAgentScopeContext;
      const log = {
        warn: (message: string) => {
          warnings.push(message);
        },
      } as unknown as ILogService;
      const tool = new NotifyUserTool(
        ctx.get(IFlagService),
        ctx.get(IBootstrapService),
        ctx.get(IAgentContextMemoryService),
        recordingTelemetry([]),
        scope,
        metadata,
        agents,
        log,
      );
      return { tool, dispatched, warnings };
    }

    const subagentMeta = (): Promise<Partial<SessionMeta>> =>
      Promise.resolve({
        agents: { 'agent-1': { type: 'sub', labels: { parentAgentId: 'main' } } },
      });

    it('dispatches the update on the parent agent once it is shown', async () => {
      const { tool, dispatched } = forwardingTool('agent-1', subagentMeta);

      const result = await executeTool(tool, {
        turnId: 1,
        toolCallId: 'call_1',
        args: { title: '  Found two refresh paths  ', message: 'Interceptor and visibility.' },
        signal,
      });

      expect(result).toEqual({ isError: false, output: NOTIFY_USER_DELIVERED_OUTPUT });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toBeInstanceOf(SubagentUpdate);
      expect(dispatched[0]).toMatchObject({
        type: 'subagent.update',
        subagentId: 'agent-1',
        title: 'Found two refresh paths',
        message: 'Interceptor and visibility.',
      });
    });

    it('does not forward the main agent updates', async () => {
      const { tool, dispatched } = forwardingTool('main', () =>
        Promise.resolve({ agents: { main: { type: 'main' } } }),
      );

      await executeTool(tool, {
        turnId: 1,
        toolCallId: 'call_1',
        args: { title: 'Plan ready', message: 'Three steps.' },
        signal,
      });

      expect(dispatched).toHaveLength(0);
    });

    it('does not forward an update that was not shown', async () => {
      Object.assign(ctx.get(IBootstrapService).args, { uiCapabilities: [] });
      const { tool, dispatched } = forwardingTool('agent-1', subagentMeta);

      const result = await executeTool(tool, {
        turnId: 1,
        toolCallId: 'call_1',
        args: { title: 'Hidden', message: 'Should not appear.' },
        signal,
      });

      expect(result).toEqual({ isError: false, output: NOTIFY_USER_SUPPRESSED_OUTPUT });
      expect(dispatched).toHaveLength(0);
    });

    it('still reports the update as shown when the parent cannot be resolved', async () => {
      const { tool, dispatched, warnings } = forwardingTool('agent-1', () =>
        Promise.reject(new Error('metadata unavailable')),
      );

      const result = await executeTool(tool, {
        turnId: 1,
        toolCallId: 'call_1',
        args: { title: 'Still shown', message: 'The subagent transcript keeps it.' },
        signal,
      });

      expect(result).toEqual({ isError: false, output: NOTIFY_USER_DELIVERED_OUTPUT });
      expect(dispatched).toHaveLength(0);
      expect(warnings).toHaveLength(1);
    });
  });
});
