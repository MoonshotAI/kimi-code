import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { type ToolCall } from '#/app/llmProtocol/message';
import { emptyUsage } from '#/app/llmProtocol/usage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { ExecutableTool, ExecutableToolContext, ExecutableToolResult, ToolExecution, ToolResult } from '#/tool/toolContract';
import type { ToolDidExecuteContext, ToolBeforeExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolDedupeService, type ToolDedupeResult } from '#/agent/toolDedupe/toolDedupe';
import { AgentToolDedupeService, __testing as toolDedupeTesting } from '#/agent/toolDedupe/toolDedupeService';
import { IAgentToolExecutorService, type ToolExecutionResult } from '#/agent/toolExecutor/toolExecutor';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { IAgentWireService } from '#/wire/tokens';
import { WireService } from '#/wire/wireServiceImpl';
import { stubWireRecord } from '../contextMemory/stubs';
import { registerLogServices } from '../../_base/log/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubLoopWithHooks } from '../loop/stubs';
import { registerToolResultTruncationServices } from '../toolResultTruncation/stubs';

const { REMINDER_TEXT_1, REMINDER_TEXT_3, makeReminderText2 } = toolDedupeTesting;
const ZERO_USAGE = emptyUsage();

let disposables: DisposableStore;
let telemetryEvents: TelemetryRecord[];

const noopEventBus: IEventBus = {
  _serviceBrand: undefined,
  publish: () => {},
  subscribe: () => ({ dispose: () => {} }),
};

beforeEach(() => {
  disposables = new DisposableStore();
  telemetryEvents = [];
});

afterEach(() => disposables.dispose());

interface Harness {
  readonly ix: TestInstantiationService;
  readonly loop: IAgentLoopService;
  readonly executor: IAgentToolExecutorService;
  readonly registry: IAgentToolRegistryService;
}

function createHarness(telemetry: ITelemetryService = recordingTelemetry(telemetryEvents)): Harness {
  const loop = stubLoopWithHooks();
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(ITelemetryService, telemetry);
      reg.defineInstance(IEventBus, noopEventBus);
      const homedir = '/tmp/tool-dedupe-homedir';
      reg.defineInstance(ISessionContext, {
        _serviceBrand: undefined,
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        sessionDir: homedir,
        metaScope: 'sessions/workspace-1/session-1',
        cwd: homedir,
        scope: (sub?: string): string =>
          sub ? `sessions/workspace-1/session-1/${sub}` : 'sessions/workspace-1/session-1',
      } satisfies ISessionContext);
      reg.defineInstance(IAgentScopeContext, {
        _serviceBrand: undefined,
        agentId: 'main',
        scope: (sub?: string): string => (sub ? `agents/main/${sub}` : 'agents/main'),
      } satisfies IAgentScopeContext);
      reg.defineInstance(IBootstrapService, {
        homeDir: homedir,
        agentHomedir: () => homedir,
      } as unknown as IBootstrapService);
      reg.defineInstance(IAgentLoopService, loop);
      reg.define(IAgentToolRegistryService, AgentToolRegistryService);
      reg.define(IAgentToolExecutorService, AgentToolExecutorService);
      registerToolResultTruncationServices(reg);
      reg.defineInstance(IAgentWireRecordService, stubWireRecord());
      reg.defineInstance(
        IAgentWireService,
        disposables.add(new WireService({ logScope: 'wire', logKey: 'tool-dedupe' })),
      );
      reg.define(IAgentToolDedupeService, AgentToolDedupeService);
      registerLogServices(reg);
    },
    strict: true,
  });
  ix.get(IAgentToolDedupeService);
  const executor = ix.get(IAgentToolExecutorService);
  const registry = ix.get(IAgentToolRegistryService);
  return { ix, loop, executor, registry };
}

function okResult(text: string): ToolDedupeResult {
  return { output: text };
}

function errResult(text: string): ToolDedupeResult {
  return { output: text, isError: true };
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

class EchoTool implements ExecutableTool<Record<string, unknown>> {
  readonly description = 'Echo input text.';
  readonly parameters = { type: 'object', additionalProperties: true };
  readonly calls: Array<ExecutableToolContext & { readonly args: Record<string, unknown> }> = [];

  constructor(
    readonly name = 'Echo',
    private readonly resultFor: (args: Record<string, unknown>) => ExecutableToolResult = (args) => ({
      output: typeof args['text'] === 'string' ? args['text'] : '',
    }),
  ) {}

  resolveExecution(args: Record<string, unknown>): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx) => {
        this.calls.push({ ...ctx, args });
        return this.resultFor(args);
      },
    };
  }
}

function beforeStep(
  h: Harness,
  turnId: number,
  step: number,
  signal = new AbortController().signal,
): Promise<void> {
  return h.loop.hooks.onWillBeginStep.run({ turnId, step, signal });
}

function afterStep(
  h: Harness,
  turnId: number,
  step: number,
  signal = new AbortController().signal,
): Promise<void> {
  return h.loop.hooks.onDidFinishStep.run({
    turnId,
    step,
    signal,
    usage: ZERO_USAGE,
    finishReason: 'completed',
    stopTurn: false,
  });
}

async function executeAll(
  h: Harness,
  calls: ToolCall[],
  turnId: number,
  signal = new AbortController().signal,
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];
  for await (const item of h.executor.execute(calls, { turnId, signal })) {
    results.push(item);
  }
  return results;
}

async function runStep(
  h: Harness,
  turnId: number,
  step: number,
  calls: ToolCall[],
  signal?: AbortSignal,
): Promise<ToolExecutionResult[]> {
  const sig = signal ?? new AbortController().signal;
  await beforeStep(h, turnId, step, sig);
  const results = await executeAll(h, calls, turnId, sig);
  await afterStep(h, turnId, step, sig);
  return results;
}

function dummyExecution(): ToolBeforeExecuteContext['execution'] {
  return { approvalRule: 'x', execute: async () => ({ output: '' }) };
}

function willCtx(
  id: string,
  name: string,
  args: unknown,
  turnId = 1,
  signal = new AbortController().signal,
): ToolBeforeExecuteContext {
  const tc = toolCall(id, name, args);
  return {
    turnId,
    signal,
    toolCall: tc,
    toolCalls: [tc],
    args,
    execution: dummyExecution(),
  };
}

function didCtx(
  id: string,
  name: string,
  args: unknown,
  result: ExecutableToolResult,
  turnId = 1,
  signal = new AbortController().signal,
): ToolDidExecuteContext {
  const tc = toolCall(id, name, args);
  return {
    turnId,
    signal,
    toolCall: tc,
    toolCalls: [tc],
    args,
    result,
  };
}

describe('AgentToolDedupeService', () => {
  describe('same-step dedupe', () => {
    it('returns a placeholder synchronously and resolves to the real result on finalize', async () => {
      const h = createHarness();
      await beforeStep(h, 1, 1);

      const w1 = willCtx('c1', 'Read', { path: '/a' });
      await h.executor.hooks.onBeforeExecuteTool.run(w1);
      expect(w1.decision).toBeUndefined();

      const w2 = willCtx('c2', 'Read', { path: '/a' });
      await h.executor.hooks.onBeforeExecuteTool.run(w2);
      expect(w2.decision?.syntheticResult).toEqual({ output: '' });

      const d1 = didCtx('c1', 'Read', { path: '/a' }, okResult('FILE_A'));
      await h.executor.hooks.onDidExecuteTool.run(d1);
      expect(d1.result).toEqual(okResult('FILE_A'));

      const d2 = didCtx('c2', 'Read', { path: '/a' }, w2.decision!.syntheticResult!);
      await h.executor.hooks.onDidExecuteTool.run(d2);
      expect(d2.result).toEqual(okResult('FILE_A'));
    });

    it('propagates error results to same-step dups', async () => {
      const h = createHarness();
      await beforeStep(h, 1, 1);

      const w1 = willCtx('c1', 'Bash', { cmd: 'x' });
      await h.executor.hooks.onBeforeExecuteTool.run(w1);
      const w2 = willCtx('c2', 'Bash', { cmd: 'x' });
      await h.executor.hooks.onBeforeExecuteTool.run(w2);
      expect(w2.decision?.syntheticResult).toEqual({ output: '' });

      const d1 = didCtx('c1', 'Bash', { cmd: 'x' }, errResult('boom'));
      await h.executor.hooks.onDidExecuteTool.run(d1);
      const d2 = didCtx('c2', 'Bash', { cmd: 'x' }, w2.decision!.syntheticResult!);
      await h.executor.hooks.onDidExecuteTool.run(d2);
      expect(d2.result).toEqual(errResult('boom'));
    });

    it('finalizes original before dup (provider order)', async () => {
      const h = createHarness();
      const tool = new EchoTool('Echo');
      h.registry.register(tool);

      const results = await runStep(h, 1, 1, [
        toolCall('c1', 'Echo', { text: 'A' }),
        toolCall('c2', 'Echo', { text: 'A' }),
      ]);

      expect(tool.calls).toHaveLength(1);
      expect(results.map((result) => result.result.output)).toEqual(['A', 'A']);
    });

    it('wires through ToolExecutor hooks and replaces same-step placeholders', async () => {
      const h = createHarness();
      const tool = new EchoTool();
      h.registry.register(tool);

      await beforeStep(h, 3, 1);
      const results: ToolResult[] = [];
      for await (const item of h.executor.execute(
        [
          toolCall('call_1', 'Echo', { text: 'same' }),
          toolCall('call_2', 'Echo', { text: 'same' }),
        ],
        { turnId: 3, signal: new AbortController().signal },
      )) {
        results.push(item.result);
      }

      expect(tool.calls).toHaveLength(1);
      expect(results.map((result) => result.output)).toEqual(['same', 'same']);
      expect(telemetryEvents).toContainEqual({
        event: 'tool_call_dedup_detected',
        properties: expect.objectContaining({
          turn_id: 3,
          step_no: 1,
          tool_call_id: 'call_2',
          tool_name: 'Echo',
          dup_type: 'same_step',
        }),
      });
    });
  });

  describe('cross-step streak', () => {
    function registerRead(h: Harness): EchoTool {
      const tool = new EchoTool('Read');
      h.registry.register(tool);
      return tool;
    }

    async function runStreak(h: Harness, count: number): Promise<ToolResult> {
      let last: ToolResult | undefined;
      for (let i = 0; i < count; i += 1) {
        const [result] = await runStep(h, 1, i + 1, [toolCall(`c${String(i)}`, 'Read', { p: 1 })]);
        last = result!.result;
      }
      return last!;
    }

    it('does not inject reminder below 3 consecutive', async () => {
      const h = createHarness();
      registerRead(h);
      const last = await runStreak(h, 2);
      expect(typeof last.output).toBe('string');
      expect(last.output as string).not.toContain('<system-reminder>');
    });

    it('injects reminder1 at exactly 3 consecutive', async () => {
      const h = createHarness();
      registerRead(h);
      const last = await runStreak(h, 3);
      expect(last.output as string).toContain('<system-reminder>');
      expect(last.output as string).toContain('what new information you expect');
      expect(last.output as string).not.toContain('Choose exactly one');
    });

    it('keeps injecting reminder1 at 4 consecutive', async () => {
      const h = createHarness();
      registerRead(h);
      const last = await runStreak(h, 4);
      expect(last.output as string).toContain('<system-reminder>');
      expect(last.output as string).toContain('what new information you expect');
    });

    it('injects reminder2 at exactly 5 consecutive', async () => {
      const h = createHarness();
      registerRead(h);
      const last = await runStreak(h, 5);
      expect(last.output as string).toContain('<system-reminder>');
      expect(last.output as string).toContain('issued 5 times in a row');
      expect(last.output as string).toContain('Choose exactly one of the following');
      expect(last.output as string).toContain('Falsification check');
    });

    it.each([6, 7])('keeps injecting reminder2 at %i consecutive', async (streak) => {
      const h = createHarness();
      registerRead(h);
      const last = await runStreak(h, streak);
      expect(last.output as string).toContain('<system-reminder>');
      expect(last.output as string).toContain(`issued ${String(streak)} times in a row`);
      expect(last.output as string).toContain('Choose exactly one of the following');
    });

    it('injects the dead-end reminder at exactly 8 consecutive', async () => {
      const h = createHarness();
      registerRead(h);
      const last = await runStreak(h, 8);
      expect(last.output as string).toContain('<system-reminder>');
      expect(last.output as string).toContain('without any further tool calls');
    });

    it('resets streak when a different call is interleaved', async () => {
      const h = createHarness();
      registerRead(h);
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`a${String(i)}`, 'Read', { p: 1 })]);
      }
      await runStep(h, 1, 3, [toolCall('b1', 'Read', { p: 2 })]);
      const [last] = await runStep(h, 1, 4, [toolCall('c1', 'Read', { p: 1 })]);
      expect(last!.result.output as string).not.toContain('<system-reminder>');
    });

    it('same-step dups inherit reminder1 when streak triggers on original', async () => {
      const h = createHarness();
      const tool = registerRead(h);
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`p${String(i)}`, 'Read', { p: 1 })]);
      }
      const callsBefore = tool.calls.length;
      const results = await runStep(h, 1, 3, [
        toolCall('orig', 'Read', { p: 1 }),
        toolCall('dup', 'Read', { p: 1 }),
      ]);

      expect(tool.calls.length).toBe(callsBefore + 1);
      const byId = new Map(results.map((result) => [result.toolCallId, result.result]));
      expect(byId.get('orig')!.output as string).toContain('<system-reminder>');
      expect(byId.get('orig')!.output as string).toContain('what new information you expect');
      expect(byId.get('dup')!.output as string).toContain('<system-reminder>');
      expect(byId.get('dup')!.output as string).toContain('what new information you expect');
    });

    it('same-step spam alone does not trigger reminder', async () => {
      const h = createHarness();
      registerRead(h);
      const calls = Array.from({ length: 8 }, (_, i) =>
        toolCall(i === 0 ? 'orig' : `dup${String(i)}`, 'Read', { p: 1 }),
      );
      const results = await runStep(h, 1, 1, calls);
      const original = results.find((result) => result.toolCallId === 'orig')!.result;
      expect(original.output as string).not.toContain('<system-reminder>');
    });
  });

  describe('reminder injection into ContentPart[] outputs', () => {
    it('appends reminder1 to a trailing text part at streak 3', async () => {
      const h = createHarness();
      const tool = new EchoTool('X', () => ({ output: [{ type: 'text', text: 'hello' }] }));
      h.registry.register(tool);
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`p${String(i)}`, 'X', {})]);
      }
      const [final] = await runStep(h, 1, 3, [toolCall('final', 'X', {})]);
      expect(final!.result.output).toBe('hello' + REMINDER_TEXT_1);
    });

    it('appends reminder2 to a trailing text part at streak 5', async () => {
      const h = createHarness();
      const tool = new EchoTool('X', () => ({ output: [{ type: 'text', text: 'hello' }] }));
      h.registry.register(tool);
      for (let i = 0; i < 4; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`p${String(i)}`, 'X', { a: 1 })]);
      }
      const [final] = await runStep(h, 1, 5, [toolCall('final', 'X', { a: 1 })]);
      expect(final!.result.output).toBe('hello' + makeReminderText2(5));
    });

    it('pushes a new text part when trailing part is non-text', async () => {
      const h = createHarness();
      const tool = new EchoTool('X', () => ({
        output: [{ type: 'image_url', imageUrl: { url: 'data:foo' } }],
      }));
      h.registry.register(tool);
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`p${String(i)}`, 'X', {})]);
      }
      const [final] = await runStep(h, 1, 3, [toolCall('final', 'X', {})]);
      const arr = final!.result.output as Array<{ type: string; text?: string }>;
      expect(arr.some((part) => part.type === 'image_url')).toBe(true);
      expect(arr.at(-1)).toEqual({ type: 'text', text: REMINDER_TEXT_1 });
    });

    it('preserves isError flag when injecting reminder', async () => {
      const h = createHarness();
      const tool = new EchoTool('X', () => ({ output: 'boom', isError: true }));
      h.registry.register(tool);
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`p${String(i)}`, 'X', {})]);
      }
      const [final] = await runStep(h, 1, 3, [toolCall('final', 'X', {})]);
      expect(final!.result.isError).toBe(true);
      expect(final!.result.output as string).toContain('<system-reminder>');
    });
  });

  describe('key canonicalization', () => {
    it('treats argument objects with different key order as the same call', async () => {
      const h = createHarness();
      await beforeStep(h, 1, 1);

      const w1 = willCtx('c1', 'Read', { a: 1, b: 2 });
      await h.executor.hooks.onBeforeExecuteTool.run(w1);
      expect(w1.decision).toBeUndefined();

      const w2 = willCtx('c2', 'Read', { b: 2, a: 1 });
      await h.executor.hooks.onBeforeExecuteTool.run(w2);
      expect(w2.decision?.syntheticResult).toEqual({ output: '' });

      const d1 = didCtx('c1', 'Read', { a: 1, b: 2 }, okResult('SAME'));
      await h.executor.hooks.onDidExecuteTool.run(d1);
      const d2 = didCtx('c2', 'Read', { b: 2, a: 1 }, w2.decision!.syntheticResult!);
      await h.executor.hooks.onDidExecuteTool.run(d2);
      expect(d2.result).toEqual(okResult('SAME'));
    });
  });

  describe('arg rewrite between checkSameStep and finalize', () => {
    it('resolves the dup deferred even when the original call args are rewritten before finalize', async () => {
      const h = createHarness();
      await beforeStep(h, 1, 1);

      const w1 = willCtx('c1', 'Read', { path: '/a' });
      await h.executor.hooks.onBeforeExecuteTool.run(w1);
      expect(w1.decision).toBeUndefined();
      const w2 = willCtx('c2', 'Read', { path: '/a' });
      await h.executor.hooks.onBeforeExecuteTool.run(w2);
      expect(w2.decision?.syntheticResult).toEqual({ output: '' });

      const d1 = didCtx('c1', 'Read', { path: '/REWRITTEN' }, okResult('A'));
      await h.executor.hooks.onDidExecuteTool.run(d1);

      const d2 = didCtx('c2', 'Read', { path: '/a' }, w2.decision!.syntheticResult!);
      await Promise.race([
        h.executor.hooks.onDidExecuteTool.run(d2),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('dup finalize hung — deferred was never resolved'));
          }, 500);
        }),
      ]);
      expect(d1.result).toEqual(okResult('A'));
      expect(d2.result).toEqual(okResult('A'));
    });
  });

  describe('beginStep cleanup', () => {
    it('resolves leaked deferreds from a prior aborted step with an error result', async () => {
      const h = createHarness();
      await beforeStep(h, 1, 1);
      const w1 = willCtx('leaked', 'Read', { p: 1 });
      await h.executor.hooks.onBeforeExecuteTool.run(w1);
      expect(w1.decision).toBeUndefined();
      const w2 = willCtx('dup', 'Read', { p: 1 });
      await h.executor.hooks.onBeforeExecuteTool.run(w2);
      const placeholder = w2.decision!.syntheticResult!;
      expect(placeholder).toEqual({ output: '' });

      await beforeStep(h, 1, 2);
      const d2 = didCtx('dup', 'Read', { p: 1 }, placeholder);
      await h.executor.hooks.onDidExecuteTool.run(d2);
      expect(d2.result).toEqual(placeholder);
    });
  });

  describe('dead-end stop reminder (streak >= 8)', () => {
    function stopTurnOf(result: ToolResult): boolean | undefined {
      return result.stopTurn;
    }

    async function runStreak(h: Harness, count: number): Promise<ToolResult> {
      let last: ToolResult | undefined;
      for (let i = 0; i < count; i += 1) {
        const [result] = await runStep(h, 1, i + 1, [toolCall(`c${String(i)}`, 'Read', { p: 1 })]);
        last = result!.result;
      }
      return last!;
    }

    it('injects the dead-end reminder at exactly 8 consecutive without force-stopping', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      const last = await runStreak(h, 8);
      expect(last.output as string).toContain('<system-reminder>');
      expect(last.output as string).toContain('Write your final response now');
      expect(last.output as string).toContain('without any further tool calls');
      expect(last.isError).toBeUndefined();
      expect(stopTurnOf(last)).toBeFalsy();
    });

    it.each([8, 9, 10, 11])(
      'keeps injecting the dead-end reminder without stopping the turn at streak %i',
      async (streak) => {
        const h = createHarness();
        h.registry.register(new EchoTool('Read'));
        const last = await runStreak(h, streak);
        expect(last.output as string).toContain('Write your final response now');
        expect(last.isError).toBeUndefined();
        expect(stopTurnOf(last)).toBeFalsy();
      },
    );

    it('force-stops the turn at exactly 12 consecutive without marking the tool failed', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      const last = await runStreak(h, 12);
      expect(last.output as string).toContain('Write your final response now');
      expect(last.isError).toBeUndefined();
      expect(stopTurnOf(last)).toBe(true);
    });

    it('continues force-stopping past 12 consecutive', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      const last = await runStreak(h, 14);
      expect(last.isError).toBeUndefined();
      expect(stopTurnOf(last)).toBe(true);
    });

    it('preserves the dead-end reminder text exactly', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      const last = await runStreak(h, 8);
      expect(last.output as string).toContain(REMINDER_TEXT_3.trim());
    });

    it('keeps an error result error when force-stopping', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read', () => ({ output: 'boom', isError: true })));
      let last: ToolResult | undefined;
      for (let i = 0; i < 12; i += 1) {
        const [result] = await runStep(h, 1, i + 1, [toolCall(`c${String(i)}`, 'Read', { p: 1 })]);
        last = result!.result;
      }
      expect(last!.isError).toBe(true);
      expect(stopTurnOf(last!)).toBe(true);
      expect(last!.output as string).toContain('Write your final response now');
    });
  });

  describe('repeat telemetry', () => {
    it('emits same-step duplicate detection telemetry', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      const signal = new AbortController().signal;
      await beforeStep(h, 7, 1, signal);
      await executeAll(
        h,
        [toolCall('c1', 'Read', { path: '/a' }), toolCall('c2', 'Read', { path: '/a' })],
        7,
        signal,
      );

      expect(telemetryEvents).toContainEqual({
        event: 'tool_call_dedup_detected',
        properties: {
          turn_id: 7,
          step_no: 1,
          tool_call_id: 'c2',
          tool_name: 'Read',
          dup_type: 'same_step',
          args_hash: expect.any(String),
        },
      });
      expect(telemetryEvents).toContainEqual({
        event: 'tool_call',
        properties: expect.objectContaining({ tool_call_id: 'c1', dup_type: 'normal' }),
      });
      expect(telemetryEvents).toContainEqual({
        event: 'tool_call',
        properties: expect.objectContaining({ tool_call_id: 'c2', dup_type: 'same_step' }),
      });
    });

    it('emits cross-step duplicate detection telemetry', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      await runStep(h, 7, 1, [toolCall('c1', 'Read', { path: '/a' })]);
      telemetryEvents.length = 0;

      const signal = new AbortController().signal;
      await beforeStep(h, 7, 2, signal);
      await executeAll(h, [toolCall('c2', 'Read', { path: '/a' })], 7, signal);

      expect(telemetryEvents).toContainEqual({
        event: 'tool_call_dedup_detected',
        properties: {
          turn_id: 7,
          step_no: 2,
          tool_call_id: 'c2',
          tool_name: 'Read',
          dup_type: 'cross_step',
          args_hash: expect.any(String),
        },
      });
      expect(telemetryEvents).toContainEqual({
        event: 'tool_call',
        properties: expect.objectContaining({ tool_call_id: 'c2', dup_type: 'cross_step' }),
      });
    });

    it('does not keep interrupted cross-step history just for duplicate telemetry', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      await runStep(h, 7, 1, [toolCall('a1', 'Read', { path: '/a' })]);
      await runStep(h, 7, 2, [toolCall('b1', 'Read', { path: '/b' })]);
      telemetryEvents.length = 0;

      const [result] = await runStep(h, 7, 3, [toolCall('a2', 'Read', { path: '/a' })]);

      expect(result!.result.output as string).not.toContain('<system-reminder>');
      expect(telemetryEvents.filter((e) => e.event === 'tool_call_dedup_detected')).toHaveLength(0);
      expect(telemetryEvents.filter((e) => e.event === 'tool_call_repeat')).toHaveLength(0);
    });

    it('emits tool_call_repeat with the streak count starting at the second occurrence', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      for (let i = 0; i < 3; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`c${String(i)}`, 'Read', { p: 1 })]);
      }
      const repeats = telemetryEvents.filter((e) => e.event === 'tool_call_repeat');
      expect(repeats.map((e) => e.properties?.['repeat_count'])).toEqual([2, 3]);
      expect(repeats.every((e) => e.properties?.['tool_name'] === 'Read')).toBe(true);
    });

    it('does not emit telemetry on the first call', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      await runStep(h, 1, 1, [toolCall('c0', 'Read', { p: 1 })]);
      expect(telemetryEvents.filter((e) => e.event === 'tool_call_repeat')).toHaveLength(0);
    });

    it('labels the action as r1/r2/r3 according to the reminder tier from streak 3 through 11', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      for (let i = 0; i < 11; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`c${String(i)}`, 'Read', { p: 1 })]);
      }
      const byCount = new Map<number, string>();
      for (const e of telemetryEvents) {
        if (e.event !== 'tool_call_repeat') continue;
        byCount.set(e.properties?.['repeat_count'] as number, e.properties?.['action'] as string);
      }
      expect(byCount.get(2)).toBe('none');
      expect(byCount.get(3)).toBe('r1');
      expect(byCount.get(4)).toBe('r1');
      expect(byCount.get(5)).toBe('r2');
      expect(byCount.get(6)).toBe('r2');
      expect(byCount.get(7)).toBe('r2');
      expect(byCount.get(8)).toBe('r3');
      expect(byCount.get(9)).toBe('r3');
      expect(byCount.get(10)).toBe('r3');
      expect(byCount.get(11)).toBe('r3');
    });

    it('labels the action as "stop" at streak 12+', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      for (let i = 0; i < 13; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`c${String(i)}`, 'Read', { p: 1 })]);
      }
      const at12 = telemetryEvents.find(
        (e) => e.event === 'tool_call_repeat' && e.properties?.['repeat_count'] === 12,
      );
      const at13 = telemetryEvents.find(
        (e) => e.event === 'tool_call_repeat' && e.properties?.['repeat_count'] === 13,
      );
      expect(at12?.properties?.['action']).toBe('stop');
      expect(at13?.properties?.['action']).toBe('stop');
    });

    it('resets the count when a different call interleaves', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`a${String(i)}`, 'Read', { p: 1 })]);
      }
      await runStep(h, 1, 3, [toolCall('b1', 'Read', { p: 2 })]);
      await runStep(h, 1, 4, [toolCall('c1', 'Read', { p: 1 })]);
      const counts = telemetryEvents
        .filter((e) => e.event === 'tool_call_repeat')
        .map((e) => e.properties?.['repeat_count']);
      expect(counts).toEqual([2]);
    });

    it('resets repeat state at turn boundaries', async () => {
      const h = createHarness();
      h.registry.register(new EchoTool('Read'));
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`a${String(i)}`, 'Read', { p: 1 })]);
      }
      telemetryEvents.length = 0;

      const [firstInNewTurn] = await runStep(h, 2, 1, [toolCall('b1', 'Read', { p: 1 })]);

      expect(firstInNewTurn!.result.output as string).not.toContain('<system-reminder>');
      expect(telemetryEvents.filter((e) => e.event === 'tool_call_repeat')).toHaveLength(0);
      expect(telemetryEvents.filter((e) => e.event === 'tool_call_dedup_detected')).toHaveLength(0);
    });

    it('runs with a no-op telemetry service', async () => {
      const h = createHarness(recordingTelemetry([]));
      h.registry.register(new EchoTool('Read'));
      for (let i = 0; i < 3; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`c${String(i)}`, 'Read', { p: 1 })]);
      }
      expect(telemetryEvents.filter((e) => e.event === 'tool_call_repeat')).toHaveLength(0);
    });
  });
});
