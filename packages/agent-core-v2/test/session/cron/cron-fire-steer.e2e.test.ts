/**
 * Cron fire steer-turn context e2e: when a scheduled cron task fires and
 * steers a NEW turn on the idle main agent, the provider request must carry
 * the full conversation context — in particular the earlier CronCreate tool
 * result (which holds the `id: <ULID>` line the model was told about).
 *
 * Wiring: testAgent harness with a scripted provider. The harness builds the
 * Session scope with a stub `IAgentLifecycleService` (no `create`), so this
 * test overrides it with a registry stub that resolves `main` to the harness
 * agent and fires `onDidCreate` the way production does — that is what binds
 * `SessionCronServiceImpl` to the main agent (cron tools + wire restore
 * hook). The cron clock is file-driven (`clock: file:...`) and ticking is
 * manual (`manualTick: true`) so the fire is deterministic.
 *
 * Run: ../../node_modules/.bin/vitest run test/session/cron/cron-fire-steer.e2e.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { CronConfig } from '#/app/cron/configSection';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionCronService } from '#/session/cron/sessionCronService';

import { createTestAgent, sessionService, type TestAgentContext } from '../../harness';

function textOf(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('cron-fired steer turn context', () => {
  let ctx: TestAgentContext;
  let clockFile: string;
  let onDidCreate: Emitter<IAgentScopeHandle>;
  let mainHandle: IAgentScopeHandle | undefined;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-steer-'));
    clockFile = join(dir, 'clock.txt');
    writeFileSync(clockFile, String(Date.now()));

    onDidCreate = new Emitter<IAgentScopeHandle>();
    const lifecycleStub: IAgentLifecycleService = {
      _serviceBrand: undefined,
      onDidCreate: onDidCreate.event,
      onDidDispose: Event.None as Event<string>,
      create: () => Promise.reject(new Error('not supported in this test')),
      fork: () => Promise.reject(new Error('not supported in this test')),
      get: (agentId) => (agentId === 'main' ? mainHandle : undefined),
      list: () => (mainHandle === undefined ? [] : [mainHandle]),
      broadcastPermissionMode: () => {},
      remove: () => Promise.resolve(),
    };
    ctx = createTestAgent(sessionService(IAgentLifecycleService, lifecycleStub));

    const accessor = {
      get: <T,>(id: ServiceIdentifier<T>): T => ctx.get(id),
    };
    mainHandle = { id: 'main', kind: LifecycleScope.Agent, accessor, dispose: () => {} };
    onDidCreate.fire(mainHandle);

    const cronConfig: CronConfig = {
      debug: false,
      noJitter: true,
      noStale: false,
      disabled: false,
      manualTick: true,
      clock: `file:${clockFile}`,
    };
    ctx.kimiConfig = { ...ctx.kimiConfig, cron: cronConfig };
    await ctx.restorePersisted();

    await ctx.rpc.setPermission({ mode: 'yolo' });
  });

  afterEach(async () => {
    onDidCreate.dispose();
    await ctx.dispose();
  });

  it('carries earlier tool results into the cron-fired steer turn request', async () => {
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_cron_1',
      name: 'CronCreate',
      arguments: JSON.stringify({ cron: '* * * * *', prompt: 'fire me', recurring: true }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'scheduled' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'remind me every minute' }] });
    await ctx.untilTurnEnd();

    const toolMessages = ctx.contextData().history.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const jobId = textOf(toolMessages[0]!).match(/^id: (\S+)$/m)?.[1];
    expect(jobId).toBeDefined();

    ctx.mockNextResponse({ type: 'text', text: 'cron turn done' });
    writeFileSync(clockFile, String(Date.now() + 120_000));
    await ctx.get(ISessionCronService).tick();
    await ctx.get(IAgentLoopService).settled();

    expect(ctx.llmCalls.length).toBe(3);
    const fireRequest = ctx.llmCalls.at(-1)!;

    const lastUser = fireRequest.history.filter((m) => m.role === 'user').at(-1);
    const lastUserText = lastUser?.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('') ?? '';
    expect(lastUserText).toContain('fire me');

    const requestToolTexts = fireRequest.history
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content)
      .map((part) => (part.type === 'text' ? part.text : ''));
    expect(requestToolTexts.some((text) => text.includes(`id: ${jobId!}`))).toBe(true);
  });
});
