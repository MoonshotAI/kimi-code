import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  NOTIFY_USER_TOOL_NAME,
  NotifyUserInputSchema,
} from '#/features/notify/tools/notify-user/notify-user';
import {
  NOTIFY_USER_DELIVERED_OUTPUT,
  NOTIFY_USER_EMPTY_MESSAGE,
  NOTIFY_USER_SUPPRESSED_OUTPUT,
} from '#/features/notify/tools/notify-user/notifyUserTool';
import { executeTool } from '../../../tools/fixtures/execute-tool';

import { createTestAgent, type TestAgentContext } from '../../../harness';

const signal = new AbortController().signal;

describe('NotifyUserTool', () => {
  let ctx: TestAgentContext;

  beforeEach(async () => {
    ctx = createTestAgent();
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
    expect(NotifyUserInputSchema.safeParse({ message: 'Reading the parser first.' }).success).toBe(
      true,
    );
    expect(NotifyUserInputSchema.safeParse({ message: '' }).success).toBe(false);
    expect(NotifyUserInputSchema.safeParse({}).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        message: { type: 'string' },
      },
    });
  });

  it('is an experimental, off-by-default flag that the default profile allows', () => {
    expect(ctx.get(IAgentToolPolicyService).isToolActive(NOTIFY_USER_TOOL_NAME)).toBe(true);
    expect(notifyUserFlag.id).toBe(NOTIFY_USER_FLAG_ID);
    expect(notifyUserFlag.env).toBe(NOTIFY_USER_FLAG_ENV);
    expect(notifyUserFlag.default).toBe(false);
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
      message: 'Login module is clean; the bug is in session expiry.',
    });

    expect(execution).toMatchObject({
      description: 'Notifying the user',
      approvalRule: NOTIFY_USER_TOOL_NAME,
      accesses: [],
    });

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { message: 'Login module is clean; the bug is in session expiry.' },
      signal,
    });

    expect(result).toEqual({ isError: false, output: NOTIFY_USER_DELIVERED_OUTPUT });
  });

  it('rejects a whitespace-only message before execution', async () => {
    const tool = ctx.get(INotifyUserTool);

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { message: '   \n' },
      signal,
    });

    expect(result).toEqual({ isError: true, output: NOTIFY_USER_EMPTY_MESSAGE });
  });

  it('acknowledges without displaying after the feature is disabled', async () => {
    const tool = ctx.get(INotifyUserTool);
    const execution = tool.resolveExecution({ message: 'Starting the checks.' });
    ctx.get(IFlagService).setConfigOverrides({ notify_user: false });
    const disabled = tool.resolveExecution({ message: 'Should not appear.' });
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
    const execution = ctx.get(INotifyUserTool).resolveExecution({ message: 'Should not appear.' });
    if (!('execute' in execution)) throw new Error('Expected executable tool');
    expect(await execution.execute({ signal } as never)).toEqual({
      isError: false,
      output: NOTIFY_USER_SUPPRESSED_OUTPUT,
    });
  });
});
