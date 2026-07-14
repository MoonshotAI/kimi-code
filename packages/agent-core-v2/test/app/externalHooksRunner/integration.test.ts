import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import {
  createServices,
  type TestInstantiationService,
} from '#/_base/di/test';
import { Emitter, Event } from '#/_base/event';
import { emptyUsage } from '#/app/llmProtocol/usage';
import { buildContextCompactionShape } from '#/agent/contextMemory/compactionHandoff';
import {
  IAgentContextMemoryService,
  type ContextCompactionInput,
  type ContextCompactionResult,
} from '#/agent/contextMemory/contextMemory';
import { computeUndoCut } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  HookDefSchema,
  HOOKS_SECTION,
  hooksFromToml,
  hooksToToml,
} from '#/agent/externalHooks/configSection';
import { IAgentExternalHooksService } from '#/agent/externalHooks/externalHooks';
import { AgentExternalHooksService } from '#/agent/externalHooks/externalHooksService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type AfterStepContext } from '#/agent/loop/loop';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunner';
import { ExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunnerService';
import { makeHookRunner } from '../../agent/externalHooks/runner-stub';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IPluginService } from '#/app/plugin/plugin';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import {
  ISessionLifecycleService,
  type SessionLifecycleHooks,
} from '#/app/sessionLifecycle/sessionLifecycle';
import { createHooks } from '#/hooks';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionExternalHooksService } from '#/session/externalHooks/externalHooks';
import { SessionExternalHooksService } from '#/session/externalHooks/externalHooksService';
import { IAgentWireService } from '#/wire/tokens';
import { WireService } from '#/wire/wireServiceImpl';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubLoopWithHooks, stubToolExecutor } from '../../agent/loop/stubs';

function nodeCommand(source: string): string {
  return `node -e ${JSON.stringify(source.replaceAll(/\s*\n\s*/g, ' '))}`;
}

function stdinScript(body: string): string {
  return nodeCommand([
    'let input = "";',
    'process.stdin.on("data", (chunk) => { input += chunk; });',
    'process.stdin.on("end", () => {',
    '  const parsed = input.length === 0 ? {} : JSON.parse(input);',
    body,
    '});',
  ].join('\n'));
}

function makeAfterStep(signal: AbortSignal): AfterStepContext {
  return {
    turnId: 0,
    step: 1,
    signal,
    usage: emptyUsage(),
    finishReason: 'completed',
    stopTurn: false,
  };
}

function stubContextMemory(): IAgentContextMemoryService & {
  readonly messages: readonly ContextMessage[];
} {
  const messages: ContextMessage[] = [];
  return {
    _serviceBrand: undefined,
    get: () => [...messages],
    append: (...inserted) => {
      messages.push(...inserted);
    },
    appendLoopEvent: () => {},
    clear: () => {
      messages.splice(0);
    },
    undo: (count) => {
      const cut = computeUndoCut(messages, count);
      if (cut.cutIndex >= 0 && cut.removedCount >= count) {
        messages.splice(cut.cutIndex, messages.length - cut.cutIndex);
      }
      return cut;
    },
    applyCompaction: (input: ContextCompactionInput): ContextCompactionResult => {
      const shape = buildContextCompactionShape(messages, input);
      messages.splice(0, messages.length, ...shape.messages);
      const { messages: _messages, ...result } = shape;
      void _messages;
      return result;
    },
    messages,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function stubHookRunner(partial: unknown): IExternalHooksRunnerService {
  const p = partial as Pick<
    IExternalHooksRunnerService,
    'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'
  >;
  return {
    _serviceBrand: undefined,
    ...p,
  };
}

function hookLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'session-external-hooks-')), 'events.jsonl');
}

function appendHookLogCommand(path: string): string {
  return stdinScript([
    'const fs = require("node:fs");',
    'fs.appendFileSync(',
    `  ${JSON.stringify(path)},`,
    '  JSON.stringify({',
    '    event: parsed.hook_event_name,',
    '    source: parsed.source,',
    '    reason: parsed.reason,',
    '    sessionId: parsed.session_id,',
    '    cwd: parsed.cwd,',
    '  }) + "\\n",',
    ');',
  ].join('\n'));
}

function readHookLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stubSessionContext(): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    sessionDir: '/tmp/session-1',
    metaScope: 'sessions/workspace-1/session-1',
    cwd: '/tmp',
    scope: (subKey?: string) =>
      subKey === undefined || subKey === ''
        ? 'sessions/workspace-1/session-1'
        : `sessions/workspace-1/session-1/${subKey}`,
  };
}

function stubSessionLifecycle(): ISessionLifecycleService {
  return {
    _serviceBrand: undefined,
    hooks: createHooks<SessionLifecycleHooks, keyof SessionLifecycleHooks>([
      'onDidCreateSession',
      'onWillCloseSession',
    ]),
    onDidCreateSession: Event.None as ISessionLifecycleService['onDidCreateSession'],
    onDidCloseSession: Event.None as ISessionLifecycleService['onDidCloseSession'],
    onDidArchiveSession: Event.None as ISessionLifecycleService['onDidArchiveSession'],
    onDidForkSession: Event.None as ISessionLifecycleService['onDidForkSession'],
    create: async () => {
      throw new Error('not implemented');
    },
    get: () => undefined,
    list: () => [],
    resume: async () => undefined,
    close: async () => {},
    archive: async () => {},
    restore: async () => undefined,
    fork: async () => {
      throw new Error('not implemented');
    },
    createChild: async () => {
      throw new Error('not implemented');
    },
  };
}

describe('IExternalHooksRunnerService integration', () => {
  it('blocks a dangerous Bash command and allows a safe one via a PreToolUse script hook', async () => {
    const engine = makeHookRunner([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: stdinScript([
          'const command = parsed.tool_input?.command ?? "";',
          'if (String(command).includes("rm -rf")) {',
          '  process.stderr.write("Blocked: rm -rf");',
          '  process.exit(2);',
          '}',
        ].join('\n')),
        timeout: 5,
      },
    ]);

    const safe = await engine.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash', toolInput: { command: 'ls -la' } },
    });
    expect(safe.every((result) => result.action === 'allow')).toBe(true);

    const dangerous = await engine.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash', toolInput: { command: 'rm -rf /' } },
    });
    expect(dangerous.some((result) => result.action === 'block')).toBe(true);
    expect(dangerous[0]?.reason).toContain('rm -rf');
  });

  it('honors a Stop hook returning permissionDecision=deny by producing a block result with reason', async () => {
    const engine = makeHookRunner([
      {
        event: 'Stop',
        command: nodeCommand(
          'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "tests not written" } }));',
        ),
        timeout: 5,
      },
    ]);

    const results = await engine.trigger('Stop', { inputData: { stopHookActive: false } });

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('block');
    expect(results[0]?.reason).toContain('tests not written');
  });

  it('limits external Stop hook continuations to once per active turn', async () => {
    const disposables = new DisposableStore();
    let ix: TestInstantiationService | undefined;
    try {
      const loop = stubLoopWithHooks();
      const context = stubContextMemory();
      const stopInputs: unknown[] = [];
      const hookEngine = {
        trigger: async () => [],
        fireAndForgetTrigger: async () => [],
        triggerBlock: async (_event: string, args: { inputData?: unknown }) => {
          stopInputs.push(args.inputData);
          return { block: true, reason: `continue ${stopInputs.length}` };
        },
      };

      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          reg.defineInstance(IBootstrapService, stubBootstrap());
          reg.defineInstance(ISessionContext, stubSessionContext());
          reg.definePartialInstance(IConfigService, {});
          reg.definePartialInstance(IPluginService, {});
          reg.defineInstance(IAgentContextMemoryService, context);
          reg.defineInstance(IAgentLoopService, loop);
          reg.define(IEventBus, EventBusService);
          reg.definePartialInstance(IAgentPromptService, {
            hooks: createHooks(['onBeforeSubmitPrompt']),
          });
          reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
          reg.definePartialInstance(IAgentPermissionGate, {});
          reg.definePartialInstance(IAgentFullCompactionService, {
            hooks: createHooks(['onWillCompact']),
          });
          reg.definePartialInstance(IAgentTaskService, {});
          reg.defineInstance(
            IAgentWireService,
            disposables.add(new WireService({ logScope: 'wire', logKey: 'external-hooks' })),
          );
        },
      });
      ix.set(IExternalHooksRunnerService, stubHookRunner(hookEngine));
      ix.set(IAgentExternalHooksService, new SyncDescriptor(AgentExternalHooksService));
      ix.get(IAgentExternalHooksService);
      const eventBus = ix.get(IEventBus);

      const signal = new AbortController().signal;
      const filtered: AfterStepContext = {
        ...makeAfterStep(signal),
        finishReason: 'filtered',
      };
      await loop.hooks.onDidFinishStep.run(filtered);
      expect(loop.hasPendingRequests()).toBe(false);
      expect(stopInputs).toEqual([]);
      expect(context.messages).toEqual([]);

      const first = makeAfterStep(signal);
      await loop.hooks.onDidFinishStep.run(first);
      expect(loop.hasPendingRequests()).toBe(true);
      expect(context.messages.at(-1)).toEqual(
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'continue 1' }],
          origin: { kind: 'system_trigger', name: 'stop_hook' },
        }),
      );
      expect(loop.drainNextBatch(context)).toBeDefined();

      const second = makeAfterStep(signal);
      await loop.hooks.onDidFinishStep.run(second);
      expect(loop.hasPendingRequests()).toBe(false);
      expect(stopInputs).toEqual([{ stopHookActive: false }]);

      eventBus.publish({
        type: 'turn.ended',
        turnId: 0,
        reason: 'completed',
        durationMs: 0,
      });

      const nextTurn = makeAfterStep(signal);
      await loop.hooks.onDidFinishStep.run(nextTurn);
      expect(loop.hasPendingRequests()).toBe(true);
      expect(context.messages.at(-1)).toEqual(
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'continue 2' }],
          origin: { kind: 'system_trigger', name: 'stop_hook' },
        }),
      );
      expect(loop.drainNextBatch(context)).toBeDefined();
      expect(stopInputs).toEqual([{ stopHookActive: false }, { stopHookActive: false }]);
    } finally {
      ix?.dispose();
      disposables.dispose();
    }
  });

  it('passes permission approval contexts through to PermissionRequest and PermissionResult hooks', async () => {
    const disposables = new DisposableStore();
    let ix: TestInstantiationService | undefined;
    try {
      const fired: Array<{
        event: string;
        matcherValue?: unknown;
        inputData?: unknown;
      }> = [];
      const hookEngine = {
        trigger: async () => [],
        triggerBlock: async () => undefined,
        fireAndForgetTrigger: async (
          event: string,
          args: { matcherValue?: unknown; inputData?: unknown },
        ) => {
          fired.push({
            event,
            matcherValue: args.matcherValue,
            inputData: args.inputData,
          });
        },
      };

      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          reg.defineInstance(IBootstrapService, stubBootstrap());
          reg.defineInstance(ISessionContext, stubSessionContext());
          reg.definePartialInstance(IConfigService, {});
          reg.definePartialInstance(IPluginService, {});
          reg.defineInstance(IAgentContextMemoryService, stubContextMemory());
          reg.defineInstance(IAgentLoopService, stubLoopWithHooks());
          reg.define(IEventBus, EventBusService);
          reg.definePartialInstance(IAgentPromptService, {
            hooks: createHooks(['onBeforeSubmitPrompt']),
          });
          reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
          reg.definePartialInstance(IAgentPermissionGate, {});
          reg.definePartialInstance(IAgentFullCompactionService, {
            hooks: createHooks(['onWillCompact']),
          });
          reg.definePartialInstance(IAgentTaskService, {});
        },
      });
      ix.set(IExternalHooksRunnerService, stubHookRunner(hookEngine));
      ix.set(IAgentExternalHooksService, new SyncDescriptor(AgentExternalHooksService));
      ix.get(IAgentExternalHooksService);
      const eventBus = ix.get(IEventBus);

      const requestContext = {
        sessionId: 'session-1',
        agentId: 'main',
        turnId: 7,
        toolCallId: 'call-bash',
        toolName: 'Bash',
        action: 'Run command',
        toolInput: { command: 'pwd' },
        display: { kind: 'command' as const, command: 'pwd' },
      };
      eventBus.publish({
        type: 'permission.approval.requested',
        ...requestContext,
      });
      eventBus.publish({
        type: 'permission.approval.resolved',
        ...requestContext,
        decision: 'approved',
        selectedLabel: 'Approve once',
      });
      await flushMicrotasks();

      expect(fired).toEqual([
        {
          event: 'PermissionRequest',
          matcherValue: 'Bash',
          inputData: requestContext,
        },
        {
          event: 'PermissionResult',
          matcherValue: 'Bash',
          inputData: {
            ...requestContext,
            decision: 'approved',
            selectedLabel: 'Approve once',
          },
        },
      ]);
    } finally {
      ix?.dispose();
      disposables.dispose();
    }
  });

  it('observes the agent-run hook slots to fire SubagentStart and SubagentStop', async () => {
    const disposables = new DisposableStore();
    let ix: TestInstantiationService | undefined;
    try {
      const fired: Array<{
        event: string;
        matcherValue?: unknown;
        inputData?: unknown;
      }> = [];
      const triggered: Array<{
        event: string;
        matcherValue?: unknown;
        inputData?: unknown;
        signal?: unknown;
      }> = [];
      const hookEngine = {
        trigger: async (
          event: string,
          args: { matcherValue?: unknown; inputData?: unknown; signal?: unknown },
        ) => {
          triggered.push({
            event,
            matcherValue: args.matcherValue,
            inputData: args.inputData,
            signal: args.signal,
          });
          return [];
        },
        triggerBlock: async () => undefined,
        fireAndForgetTrigger: async (
          event: string,
          args: { matcherValue?: unknown; inputData?: unknown },
        ) => {
          fired.push({
            event,
            matcherValue: args.matcherValue,
            inputData: args.inputData,
          });
          return [];
        },
      };

      const stopAgentTask = disposables.add(new Emitter<AgentTaskStopHookContext>());

      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          reg.defineInstance(ISessionContext, {
            _serviceBrand: undefined,
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            sessionDir: '/tmp/session-1',
            metaScope: 'sessions/workspace-1/session-1',
            cwd: '/tmp',
            scope: (subKey?: string) =>
              subKey === undefined || subKey === ''
                ? 'sessions/workspace-1/session-1'
                : `sessions/workspace-1/session-1/${subKey}`,
          });
          reg.defineInstance(ISessionLifecycleService, stubSessionLifecycle());
          reg.definePartialInstance(IAgentLifecycleService, {
            hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
            onDidStopAgentTask: stopAgentTask.event,
          });
        },
      });
      ix.set(IExternalHooksRunnerService, stubHookRunner(hookEngine));
      ix.set(ISessionExternalHooksService, new SyncDescriptor(SessionExternalHooksService));

      ix.get(ISessionExternalHooksService);
      const agentLifecycle = ix.get(IAgentLifecycleService);

      await agentLifecycle.hooks.onWillStartAgentTask.run({
        agentName: 'coder',
        prompt: 'Fix the bug',
        signal: new AbortController().signal,
      });
      stopAgentTask.fire({
        agentName: 'coder',
        response: 'Bug fixed',
      });

      expect(triggered).toEqual([
        {
          event: 'SubagentStart',
          matcherValue: 'coder',
          inputData: { agentName: 'coder', prompt: 'Fix the bug' },
          signal: expect.any(AbortSignal),
        },
      ]);

      await flushMicrotasks();
      await flushMicrotasks();
      expect(fired).toEqual([
        {
          event: 'SubagentStop',
          matcherValue: 'coder',
          inputData: { agentName: 'coder', response: 'Bug fixed' },
        },
      ]);
    } finally {
      ix?.dispose();
      disposables.dispose();
    }
  });

  it('waits for dynamic hooks to load before running the first blocking hook', async () => {
    const disposables = new DisposableStore();
    let ix: TestInstantiationService | undefined;
    try {
      const loop = stubLoopWithHooks();
      const context = stubContextMemory();
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });

      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          reg.defineInstance(IBootstrapService, stubBootstrap());
          reg.defineInstance(ISessionContext, stubSessionContext());
          reg.definePartialInstance(IConfigService, {
            ready,
            get: <T = unknown>(domain: string): T =>
              (domain === HOOKS_SECTION
                ? [
                  {
                    event: 'Stop' as const,
                    command: nodeCommand('process.stderr.write("loaded stop hook"); process.exit(2);'),
                    timeout: 5,
                  },
                ]
                : undefined) as T,
          });
          reg.definePartialInstance(IPluginService, {
            enabledHooks: async () => [],
            onDidReload: Event.None as IPluginService['onDidReload'],
          });
          reg.defineInstance(IAgentContextMemoryService, context);
          reg.defineInstance(IAgentLoopService, loop);
          reg.define(IEventBus, EventBusService);
          reg.definePartialInstance(IAgentPromptService, {
            hooks: createHooks(['onBeforeSubmitPrompt']),
          });
          reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
          reg.definePartialInstance(IAgentPermissionGate, {});
          reg.definePartialInstance(IAgentFullCompactionService, {
            hooks: createHooks(['onWillCompact']),
          });
          reg.definePartialInstance(IAgentTaskService, {});
          reg.defineInstance(
            IAgentWireService,
            disposables.add(new WireService({ logScope: 'wire', logKey: 'external-hooks' })),
          );
          reg.define(IHostProcessService, HostProcessService);
        },
      });
      ix.set(IExternalHooksRunnerService, new SyncDescriptor(ExternalHooksRunnerService));
      ix.set(IAgentExternalHooksService, new SyncDescriptor(AgentExternalHooksService));
      ix.get(IAgentExternalHooksService);

      const afterStep = makeAfterStep(new AbortController().signal);
      let completed = false;
      const pending = loop.hooks.onDidFinishStep.run(afterStep).then(() => {
        completed = true;
      });
      await flushMicrotasks();
      expect(completed).toBe(false);

      resolveReady();
      await pending;

      expect(loop.hasPendingRequests()).toBe(true);
      expect(context.messages.at(-1)).toEqual(
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'loaded stop hook' }],
          origin: { kind: 'system_trigger', name: 'stop_hook' },
        }),
      );
    } finally {
      ix?.dispose();
      disposables.dispose();
    }
  });

  it('fires a Notification hook only when its matcher equals the notification matcher value', async () => {
    const engine = makeHookRunner([
      {
        event: 'Notification',
        matcher: 'task_completed',
        command: nodeCommand('process.stdout.write("notified");'),
        timeout: 5,
      },
      {
        event: 'Notification',
        matcher: 'other_type',
        command: nodeCommand('process.stdout.write("other");'),
        timeout: 5,
      },
    ]);

    const results = await engine.trigger('Notification', {
      matcherValue: 'task_completed',
      inputData: { notificationType: 'task_completed', title: 'Done' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.stdout?.trim()).toBe('notified');
  });

  it('runs multiple hooks for the same event in parallel and collects every result', async () => {
    const engine = makeHookRunner([
      {
        event: 'PostToolUse',
        matcher: 'Write',
        command: nodeCommand('process.stdout.write("hook1");'),
        timeout: 5,
      },
      {
        event: 'PostToolUse',
        matcher: 'Write',
        command: nodeCommand('process.stdout.write("hook2");'),
        timeout: 5,
      },
    ]);

    const results = await engine.trigger('PostToolUse', {
      matcherValue: 'Write',
      inputData: { toolName: 'Write' },
    });

    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.stdout?.trim()))).toEqual(
      new Set(['hook1', 'hook2']),
    );
  });

  it('round-trips hook definitions through the externalHooks config transforms', () => {
    const raw = [
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo ok' },
      {
        event: 'Notification',
        matcher: 'permission_prompt',
        command: 'notify-send Kimi',
        timeout: 5,
      },
    ];

    const parsed = (hooksFromToml(raw) as unknown[]).map((hook) => HookDefSchema.parse(hook));

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ event: 'PreToolUse', matcher: 'Bash' });
    expect(parsed[1]).toMatchObject({ event: 'Notification', timeout: 5 });
    expect(hooksToToml(parsed, undefined)).toEqual(raw);
  });

  it('exposes a summary map of event name to registered hook count', async () => {
    const engine = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo 1' },
      { event: 'PreToolUse', matcher: 'Write', command: 'echo 2' },
      { event: 'Stop', command: 'echo 3' },
    ]);

    await engine.ready;
    expect(engine.summary).toEqual({ PreToolUse: 2, Stop: 1 });
  });

  it('feeds the SessionStart source field through stdin and filters by the startup matcher', async () => {
    const engine = makeHookRunner([
      {
        event: 'SessionStart',
        matcher: 'startup',
        command: stdinScript('process.stdout.write(String(parsed.source ?? ""));'),
        timeout: 5,
      },
    ]);

    const matched = await engine.trigger('SessionStart', {
      matcherValue: 'startup',
      inputData: { sessionId: 'test-123', cwd: '/tmp', source: 'startup' },
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.stdout?.trim()).toBe('startup');

    const unmatched = await engine.trigger('SessionStart', {
      matcherValue: 'resume',
      inputData: { sessionId: 'test-123', cwd: '/tmp', source: 'resume' },
    });
    expect(unmatched).toHaveLength(0);
  });

  it('fires a PostToolUseFailure hook with the tool error in the payload', async () => {
    const engine = makeHookRunner([
      {
        event: 'PostToolUseFailure',
        matcher: 'Bash',
        command: nodeCommand('process.stdout.write("failure_caught");'),
        timeout: 5,
      },
    ]);

    const results = await engine.trigger('PostToolUseFailure', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash', toolInput: {}, error: 'command not found' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('allow');
    expect(results[0]?.stdout).toContain('failure_caught');
  });

  it('blocks a UserPromptSubmit prompt when the hook exits 2 and returns the reason to the user', async () => {
    const engine = makeHookRunner([
      {
        event: 'UserPromptSubmit',
        command: nodeCommand('process.stderr.write("no profanity"); process.exit(2);'),
        timeout: 5,
      },
    ]);

    const results = await engine.trigger('UserPromptSubmit', {
      inputData: { prompt: 'bad words here' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('block');
    expect(results[0]?.reason).toContain('no profanity');
  });

  it('fires a StopFailure hook on chat provider errors with the error_type field present', async () => {
    const engine = makeHookRunner([
      {
        event: 'StopFailure',
        command: nodeCommand('process.stdout.write("error_logged");'),
        timeout: 5,
      },
    ]);

    const results = await engine.trigger('StopFailure', {
      inputData: { errorType: 'ChatProviderError', errorMessage: 'rate limited' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.stdout).toContain('error_logged');
  });

  it('fires a SessionEnd hook only for the matching reason matcher', async () => {
    const engine = makeHookRunner([
      {
        event: 'SessionEnd',
        matcher: 'exit',
        command: nodeCommand('process.stdout.write("goodbye");'),
        timeout: 5,
      },
    ]);

    const matched = await engine.trigger('SessionEnd', {
      matcherValue: 'exit',
      inputData: { sessionId: 's1', reason: 'exit' },
    });
    expect(matched).toHaveLength(1);

    const unmatched = await engine.trigger('SessionEnd', {
      matcherValue: 'clear',
      inputData: { sessionId: 's1', reason: 'clear' },
    });
    expect(unmatched).toHaveLength(0);
  });

  it('runs session external hooks from lifecycle callbacks', async () => {
    const disposables = new DisposableStore();
    let ix: TestInstantiationService | undefined;
    try {
      const lifecycle = stubSessionLifecycle();
      const path = hookLogPath();
      const command = appendHookLogCommand(path);
      const cwd = mkdtempSync(join(tmpdir(), 'session-external-hooks-cwd-'));
      const handle = {} as ISessionScopeHandle;

      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          reg.defineInstance(ISessionContext, {
            _serviceBrand: undefined,
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            sessionDir: '/tmp/session-1',
            metaScope: 'sessions/workspace-1/session-1',
            cwd,
            scope: (subKey?: string) =>
              subKey === undefined || subKey === ''
                ? 'sessions/workspace-1/session-1'
                : `sessions/workspace-1/session-1/${subKey}`,
          });
          reg.defineInstance(ISessionLifecycleService, lifecycle);
          reg.definePartialInstance(IAgentLifecycleService, {
            hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
            onDidStopAgentTask: Event.None as Event<AgentTaskStopHookContext>,
          });
          reg.definePartialInstance(IConfigService, {
            ready: Promise.resolve(),
            get: <T = unknown>(domain: string): T =>
              (domain === HOOKS_SECTION
                ? [
                  { event: 'SessionStart' as const, command, timeout: 5 },
                  { event: 'SessionEnd' as const, command, timeout: 5 },
                ]
                : undefined) as T,
          });
          reg.definePartialInstance(IPluginService, {
            enabledHooks: async () => [],
            onDidReload: Event.None as IPluginService['onDidReload'],
          });
          reg.defineInstance(IBootstrapService, stubBootstrap());
          reg.define(IHostProcessService, HostProcessService);
        },
      });
      ix.set(IExternalHooksRunnerService, new SyncDescriptor(ExternalHooksRunnerService));
      ix.set(ISessionExternalHooksService, new SyncDescriptor(SessionExternalHooksService));
      ix.get(ISessionExternalHooksService);

      await lifecycle.hooks.onDidCreateSession.run({
        sessionId: 'session-1',
        handle,
        source: 'startup',
      });
      await lifecycle.hooks.onDidCreateSession.run({
        sessionId: 'session-1',
        handle,
        source: 'resume',
      });
      await lifecycle.hooks.onDidCreateSession.run({
        sessionId: 'session-1',
        handle,
        source: 'fork',
      });
      await lifecycle.hooks.onDidCreateSession.run({
        sessionId: 'other-session',
        handle,
        source: 'startup',
      });
      await lifecycle.hooks.onWillCloseSession.run({
        sessionId: 'session-1',
        handle,
        reason: 'exit',
      });

      expect(readHookLog(path)).toEqual([
        {
          event: 'SessionStart',
          source: 'startup',
          sessionId: 'session-1',
          cwd,
        },
        {
          event: 'SessionStart',
          source: 'resume',
          sessionId: 'session-1',
          cwd,
        },
        {
          event: 'SessionEnd',
          reason: 'exit',
          sessionId: 'session-1',
          cwd,
        },
      ]);
    } finally {
      ix?.dispose();
      disposables.dispose();
    }
  });

  it('fires a SubagentStart hook with the agent_name payload field', async () => {
    const engine = makeHookRunner([
      {
        event: 'SubagentStart',
        matcher: 'coder',
        command: nodeCommand('process.stdout.write("agent_starting");'),
        timeout: 5,
      },
    ]);

    const results = await engine.trigger('SubagentStart', {
      matcherValue: 'coder',
      inputData: { agentName: 'coder', prompt: 'Fix the bug' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.stdout).toContain('agent_starting');
  });

  it('fires a SubagentStop hook on subagent completion', async () => {
    const engine = makeHookRunner([
      {
        event: 'SubagentStop',
        matcher: 'coder',
        command: nodeCommand('process.stdout.write("agent_done");'),
        timeout: 5,
      },
    ]);

    const results = await engine.trigger('SubagentStop', {
      matcherValue: 'coder',
      inputData: { agentName: 'coder', response: 'Bug fixed' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.stdout).toContain('agent_done');
  });

  it('fires PreCompact and PostCompact hooks around compaction with trigger and token payloads', async () => {
    const engine = makeHookRunner([
      {
        event: 'PreCompact',
        matcher: 'auto',
        command: nodeCommand('process.stdout.write("pre_compact");'),
        timeout: 5,
      },
      {
        event: 'PostCompact',
        matcher: 'auto',
        command: nodeCommand('process.stdout.write("post_compact");'),
        timeout: 5,
      },
    ]);

    const pre = await engine.trigger('PreCompact', {
      matcherValue: 'auto',
      inputData: { trigger: 'auto', tokenCount: 150000 },
    });
    expect(pre).toHaveLength(1);
    expect(pre[0]?.stdout).toContain('pre_compact');

    const post = await engine.trigger('PostCompact', {
      matcherValue: 'auto',
      inputData: { trigger: 'auto', estimatedTokenCount: 50000 },
    });
    expect(post).toHaveLength(1);
    expect(post[0]?.stdout).toContain('post_compact');
  });

  it('dispatches SubagentStart and SubagentStop hooks with the agent matcher and payload', async () => {
    const engine = makeHookRunner([
      {
        event: 'SubagentStart',
        matcher: 'explore',
        command: stdinScript(
          "process.stdout.write('start:' + parsed.agent_name + ':' + parsed.prompt);",
        ),
        timeout: 5,
      },
      {
        event: 'SubagentStop',
        matcher: 'explore',
        command: stdinScript(
          "process.stdout.write('stop:' + parsed.agent_name + ':' + parsed.response);",
        ),
        timeout: 5,
      },
    ]);

    const start = await engine.trigger('SubagentStart', {
      matcherValue: 'explore',
      inputData: { agentName: 'explore', prompt: 'find files' },
    });
    expect(start).toHaveLength(1);
    expect(start[0]?.stdout).toContain('start:explore:find files');

    const stop = await engine.trigger('SubagentStop', {
      matcherValue: 'explore',
      inputData: { agentName: 'explore', response: 'done' },
    });
    expect(stop).toHaveLength(1);
    expect(stop[0]?.stdout).toContain('stop:explore:done');
  });
});
