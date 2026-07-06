import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import {
  createServices,
  type TestInstantiationService,
} from '#/_base/di/test';
import { Event } from '#/_base/event';
import { emptyUsage } from '#/app/llmProtocol';
import { IAgentContextMemoryService, type ContextMessage } from '#/agent/contextMemory';
import { IAgentTaskService } from '#/agent/task';
import {
  AgentExternalHooksService,
  IAgentExternalHooksService,
} from '#/agent/externalHooks';
import { HookEngine } from '#/agent/externalHooks/engine';
import {
  HookDefSchema,
  hooksFromToml,
  hooksToToml,
} from '#/agent/externalHooks/configSection';
import { IAgentFullCompactionService } from '#/agent/fullCompaction';
import { IAgentLoopService, type TurnAfterStepContext } from '#/agent/loop';
import { IAgentPermissionGate } from '#/agent/permissionGate';
import { IAgentPromptService } from '#/agent/prompt';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { IAgentTurnService, type Turn } from '#/agent/turn';
import { IBootstrapService } from '#/app/bootstrap';
import { IConfigService } from '#/app/config';
import { IPluginService } from '#/app/plugin';
import { createHooks } from '#/hooks';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubLoopWithHooks, stubToolExecutor, stubTurnWithHooks } from '../turn/stubs';

function nodeCommand(source: string): string {
  return `node -e ${JSON.stringify(source.replace(/\s*\n\s*/g, ' '))}`;
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

function makeTurn(id: number): Turn {
  return {
    id,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve({ reason: 'completed' }),
  };
}

function makeAfterStep(signal: AbortSignal): TurnAfterStepContext {
  return {
    turnId: 0,
    step: 1,
    signal,
    usage: emptyUsage(),
    stopReason: 'completed',
    continue: false,
  };
}

function stubContextMemory(): IAgentContextMemoryService & {
  readonly messages: readonly ContextMessage[];
} {
  const messages: ContextMessage[] = [];
  return {
    _serviceBrand: undefined,
    get: () => [...messages],
    splice: (start, deleteCount, inserted) => {
      messages.splice(start, deleteCount, ...inserted);
    },
    hooks: createHooks(['onSpliced']) as IAgentContextMemoryService['hooks'],
    messages,
  };
}

describe('HookEngine integration', () => {
  it('blocks a dangerous Bash command and allows a safe one via a PreToolUse script hook', async () => {
    const engine = new HookEngine([
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
    const engine = new HookEngine([
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
      const turnService = stubTurnWithHooks();
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
          reg.definePartialInstance(IConfigService, {});
          reg.definePartialInstance(IPluginService, {});
          reg.defineInstance(IAgentContextMemoryService, context);
          reg.defineInstance(IAgentLoopService, loop);
          reg.definePartialInstance(IAgentPromptService, {
            hooks: createHooks(['onWillSubmitPrompt']),
          });
          reg.defineInstance(IAgentTurnService, turnService);
          reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
          reg.definePartialInstance(IAgentPermissionGate, {
            hooks: createHooks(['onDidRequestApproval', 'onDidResolveApproval']),
          });
          reg.definePartialInstance(IAgentFullCompactionService, {
            hooks: createHooks(['onWillCompact', 'onDidCompact']),
          });
          reg.definePartialInstance(IAgentTaskService, {
            hooks: createHooks(['onDidNotify']),
          });
        },
      });
      ix.set(
        IAgentExternalHooksService,
        new SyncDescriptor(AgentExternalHooksService, [{ hookEngine }]),
      );
      ix.get(IAgentExternalHooksService);

      const signal = new AbortController().signal;
      const filtered: TurnAfterStepContext = {
        ...makeAfterStep(signal),
        stopReason: 'filtered',
      };
      await loop.hooks.afterStep.run(filtered);
      expect(filtered.continue).toBe(false);
      expect(stopInputs).toEqual([]);
      expect(context.messages).toEqual([]);

      const first = makeAfterStep(signal);
      await loop.hooks.afterStep.run(first);
      expect(first.continue).toBe(true);
      expect(context.messages.at(-1)).toEqual(
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'continue 1' }],
          origin: { kind: 'system_trigger', name: 'stop_hook' },
        }),
      );

      const second = makeAfterStep(signal);
      await loop.hooks.afterStep.run(second);
      expect(second.continue).toBe(false);
      expect(stopInputs).toEqual([{ stopHookActive: false }]);

      await turnService.hooks.onEnded.run({
        turn: makeTurn(0),
        result: { reason: 'completed' },
      });

      const nextTurn = makeAfterStep(signal);
      await loop.hooks.afterStep.run(nextTurn);
      expect(nextTurn.continue).toBe(true);
      expect(context.messages.at(-1)).toEqual(
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'continue 2' }],
          origin: { kind: 'system_trigger', name: 'stop_hook' },
        }),
      );
      expect(stopInputs).toEqual([{ stopHookActive: false }, { stopHookActive: false }]);
    } finally {
      ix?.dispose();
      disposables.dispose();
    }
  });

  it('fires a Notification hook only when its matcher equals the notification matcher value', async () => {
    const engine = new HookEngine([
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
    const engine = new HookEngine([
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

  it('exposes a summary map of event name to registered hook count', () => {
    const engine = new HookEngine([
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo 1' },
      { event: 'PreToolUse', matcher: 'Write', command: 'echo 2' },
      { event: 'Stop', command: 'echo 3' },
    ]);

    expect(engine.summary).toEqual({ PreToolUse: 2, Stop: 1 });
  });

  it('feeds the SessionStart source field through stdin and filters by the startup matcher', async () => {
    const engine = new HookEngine([
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
    const engine = new HookEngine([
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
    const engine = new HookEngine([
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
    const engine = new HookEngine([
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
    const engine = new HookEngine([
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

  it('fires a SubagentStart hook with the agent_name payload field', async () => {
    const engine = new HookEngine([
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
    const engine = new HookEngine([
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
    const engine = new HookEngine([
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

  it('invokes onTriggered with (event,target,count) and onResolved with (event,target,action)', async () => {
    const triggered: Array<[string, string, number]> = [];
    const resolved: Array<[string, string, string]> = [];
    const engine = new HookEngine(
      [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          command: nodeCommand('process.exit(0);'),
          timeout: 5,
        },
      ],
      {
        onTriggered: (event, target, count) => triggered.push([event, target, count]),
        onResolved: (event, target, action) => resolved.push([event, target, action]),
      },
    );

    await engine.trigger('PreToolUse', { matcherValue: 'Bash', inputData: {} });

    expect(triggered).toEqual([['PreToolUse', 'Bash', 1]]);
    expect(resolved).toEqual([['PreToolUse', 'Bash', 'allow']]);
  });

  it('dispatches SubagentStart and SubagentStop hooks with the agent matcher and payload', async () => {
    const engine = new HookEngine([
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
