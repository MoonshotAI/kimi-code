/**
 * Tool-call invariants observed end-to-end.
 *
 * The loop promises that every provider tool_call produces exactly one
 * matching tool.result event/record, even on
 * the rejected/error paths (tool not found, schema rejected, LLM-marked args
 * error, execute throws). It also runs non-conflicting tool tasks in parallel
 * while dispatching terminal events in provider order.
 */

import type { ContentPart } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { ToolAccesses } from '../../src/loop';
import type { Logger } from '../../src/logging';
import type { ExecutableTool, ExecutableToolResult, LoopHooks, ToolExecution } from '../../src/loop';
import { PathSecurityError } from '../../src/tools/policies/path-access';
import {
  makeEndTurnResponse,
  makeResponse,
  makeTextParts,
  makeToolCall,
  makeToolUseResponse,
} from './fixtures/fake-llm';
import { runTurn } from './fixtures/helpers';
import {
  ContentBlocksTool,
  EchoTool,
  FailingTool,
  GatedTool,
  markReadFileAccesses,
  ProgressTool,
  StrictArgsTool,
} from './fixtures/tools';

function expectTextOutput(output: unknown): string {
  expect(typeof output).toBe('string');
  return output as string;
}

async function contentBlockOutput(output: ContentPart[]): Promise<ContentPart[]> {
  const blocks = new ContentBlocksTool({ output });
  const { context } = await runTurn({
    tools: [blocks],
    responses: [
      makeToolUseResponse([makeToolCall('blocks', {}, 'tc-1')]),
      makeEndTurnResponse('done'),
    ],
  });
  const payload = context.toolResults()[0]?.result;
  expect(Array.isArray(payload?.output)).toBe(true);
  return payload?.output as ContentPart[];
}

function waitOneMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function makeTestLogger(): {
  readonly log: Logger;
  readonly entries: Array<{ readonly level: string; readonly message: string; readonly payload: unknown }>;
} {
  const entries: Array<{ readonly level: string; readonly message: string; readonly payload: unknown }> = [];
  const log: Logger = {
    error: (message, payload) => entries.push({ level: 'error', message, payload }),
    warn: (message, payload) => entries.push({ level: 'warn', message, payload }),
    info: (message, payload) => entries.push({ level: 'info', message, payload }),
    debug: (message, payload) => entries.push({ level: 'debug', message, payload }),
    createChild: () => log,
  };
  return { log, entries };
}

describe('runTurn — tool-call behaviour', () => {
  it('routes a successful tool call through execute and emits paired events', async () => {
    const echo = new EchoTool();
    const { sink, context } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(echo.calls.length).toBe(1);
    expect(echo.calls[0]?.id).toBe('tc-1');
    // tool.call and tool.result are paired
    expect(sink.byType('tool.call').map((e) => e.toolCallId)).toEqual(['tc-1']);
    expect(sink.byType('tool.result').map((e) => e.toolCallId)).toEqual(['tc-1']);
    // appendToolResult was called with the tool's content as output
    const trs = context.toolResults();
    expect(trs.length).toBe(1);
    expect(trs[0]?.toolCallId).toBe('tc-1');
    expect(trs[0]?.result.output).toBe('hi');
    expect(trs[0]?.result.isError).toBeUndefined();
  });

  it('skips side-effecting tools when usage recording stops the turn', async () => {
    const echo = new EchoTool();
    const { result, sink, llm } = await runTurn({
      tools: [echo],
      responses: [makeToolUseResponse([makeToolCall('echo', { text: 'skip' }, 'tc-usage')])],
      recordStepUsage: () => ({ stopTurn: true }),
    });

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(1);
    expect(echo.calls).toHaveLength(0);
    expect(sink.byType('tool.call')).toHaveLength(0);
    expect(sink.byType('tool.result')).toHaveLength(0);
  });

  it('skips later tool calls after a successful stop-turn result', async () => {
    const stop = new StopSuccessTool();
    const echo = new EchoTool();
    const { result, sink, context } = await runTurn({
      tools: [stop, echo],
      responses: [
        makeToolUseResponse([
          makeToolCall('stop-success', {}, 'tc-stop'),
          makeToolCall('echo', { text: 'must not run' }, 'tc-echo'),
        ]),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(stop.calls).toHaveLength(1);
    expect(echo.calls).toHaveLength(0);
    expect(sink.byType('tool.call').map((e) => e.toolCallId)).toEqual(['tc-stop', 'tc-echo']);
    expect(sink.byType('tool.result').map((e) => e.toolCallId)).toEqual(['tc-stop', 'tc-echo']);
    expect(context.toolResults()[0]?.result).toEqual({ output: 'stopped' });
    expect(context.toolResults()[1]?.result).toMatchObject({ isError: true });
    expect(context.toolResults()[1]?.result.output).toContain('skipped');
  });

  it('passes toolCallId / turnId / args through to Tool.execute', async () => {
    const echo = new EchoTool();
    await runTurn({
      tools: [echo],
      turnId: 'turn-XYZ',
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'inputs' }, 'tc-99')]),
        makeEndTurnResponse('ok'),
      ],
    });
    expect(echo.calls[0]).toMatchObject({
      id: 'tc-99',
      turnId: 'turn-XYZ',
      args: { text: 'inputs' },
    });
  });

  it('records an error tool.result when the tool name is unknown', async () => {
    const { sink, context } = await runTurn({
      tools: [], // no tools at all
      responses: [
        makeToolUseResponse([makeToolCall('ghost', { x: 1 }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(sink.byType('tool.call').length).toBe(1);
    const results = sink.byType('tool.result');
    expect(results.length).toBe(1);
    expect(results[0]?.result.isError).toBe(true);
    expect(expectTextOutput(results[0]?.result.output).toLowerCase()).toContain('not found');
    // Rejected path also writes the tool.call and tool.result records
    const tcRow = context.toolCalls();
    const trRow = context.toolResults();
    expect(tcRow.length).toBe(1);
    expect(tcRow[0]?.args).toEqual({ x: 1 });
    expect(trRow.length).toBe(1);
    expect(trRow[0]?.result.isError).toBe(true);
  });

  it('records an error tool.result when args fail tool parameter validation', async () => {
    const strict = new StrictArgsTool();
    const { sink } = await runTurn({
      tools: [strict],
      responses: [
        makeToolUseResponse([makeToolCall('strict', { value: 'NOT_A_NUMBER' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(strict.calls.length).toBe(0); // execute was NOT called
    const results = sink.byType('tool.result');
    expect(results.length).toBe(1);
    expect(results[0]?.result.isError).toBe(true);
    expect(expectTextOutput(results[0]?.result.output).toLowerCase()).toContain('invalid args');
  });

  it('falls back to schema validation when LLM-side args parsing fails', async () => {
    const echo = new EchoTool();
    const { sink } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([
          {
            type: 'function',
            id: 'tc-1',
            name: 'echo',
            arguments: '{}{',
          },
        ]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(echo.calls.length).toBe(0);
    const results = sink.byType('tool.result');
    expect(results.length).toBe(1);
    expect(results[0]?.result.isError).toBe(true);
    const output = expectTextOutput(results[0]?.result.output);
    expect(output).toContain('Invalid args');
    expect(output).toContain("must have required property 'text'");
    expect(output).not.toContain('malformed JSON in arguments');
    expect(output).not.toContain('Expected arguments schema:');
  });

  it('does not repair malformed tool args JSON', async () => {
    const echo = new EchoTool();
    const { sink } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([
          {
            type: 'function',
            id: 'tc-1',
            name: 'echo',
            arguments: '{"text":"hi",}',
          },
        ]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(echo.calls).toHaveLength(0);

    const results = sink.byType('tool.result');
    expect(results.length).toBe(1);
    expect(results[0]?.result.isError).toBe(true);
    const output = expectTextOutput(results[0]?.result.output);
    expect(output).toContain('Invalid args');
    expect(output).toContain("must have required property 'text'");
  });

  it('captures tool execution failures as error results', async () => {
    const fail = new FailingTool('boom');
    const { sink, context } = await runTurn({
      tools: [fail],
      responses: [
        makeToolUseResponse([makeToolCall('fail', {}, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(fail.calls.length).toBe(1);
    const results = sink.byType('tool.result');
    expect(results[0]?.result.isError).toBe(true);
    expect(expectTextOutput(results[0]?.result.output).toLowerCase()).toContain('boom');
    expect(context.toolResults()[0]?.result.isError).toBe(true);
  });

  it('logs thrown tool execution failures for diagnostics', async () => {
    const fail = new FailingTool('boom');
    const { log, entries } = makeTestLogger();
    await runTurn({
      tools: [fail],
      log,
      responses: [
        makeToolUseResponse([makeToolCall('fail', {}, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'tool execution failed',
        payload: expect.objectContaining({
          toolName: 'fail',
          toolCallId: 'tc-1',
          error: expect.any(Error),
        }),
      }),
    );
  });

  it('coerces an undefined tool return into an error tool.result without breaking pairing', async () => {
    const undef: ExecutableTool = {
      name: 'undef',
      description: 'returns undefined',
      parameters: { type: 'object', additionalProperties: true },
      resolveExecution: () => ({
        approvalRule: 'undef',
        execute: async () => undefined as unknown as ExecutableToolResult,
      }),
    };
    const { sink, context } = await runTurn({
      tools: [undef],
      responses: [
        makeToolUseResponse([makeToolCall('undef', {}, 'tc-U')]),
        makeEndTurnResponse('done'),
      ],
    });
    const callIds = sink.byType('tool.call').map((e) => e.toolCallId);
    const resultIds = sink.byType('tool.result').map((e) => e.toolCallId);
    expect(resultIds).toEqual(callIds);
    const result = context.toolResults()[0]?.result;
    expect(result?.isError).toBe(true);
    expect(expectTextOutput(result?.output)).toContain('Tool "undef" returned no result');
  });

  it('coerces a tool returning an object without "output" into an error tool.result', async () => {
    const noout: ExecutableTool = {
      name: 'noout',
      description: 'returns {}',
      parameters: { type: 'object', additionalProperties: true },
      resolveExecution: () => ({
        approvalRule: 'noout',
        execute: async () => ({}) as ExecutableToolResult,
      }),
    };
    const { sink, context } = await runTurn({
      tools: [noout],
      responses: [
        makeToolUseResponse([makeToolCall('noout', {}, 'tc-N')]),
        makeEndTurnResponse('done'),
      ],
    });
    expect(sink.byType('tool.result').length).toBe(1);
    const result = context.toolResults()[0]?.result;
    expect(result?.isError).toBe(true);
    expect(expectTextOutput(result?.output)).toContain('missing or malformed "output" field');
  });

  it('keeps every tool.call paired when one parallel tool returns a corrupt result', async () => {
    const undef: ExecutableTool = {
      name: 'undef',
      description: 'returns undefined',
      parameters: { type: 'object', additionalProperties: true },
      resolveExecution: () => ({
        approvalRule: 'undef',
        execute: async () => undefined as unknown as ExecutableToolResult,
      }),
    };
    const echo = new EchoTool();
    const { sink, context } = await runTurn({
      tools: [undef, echo],
      responses: [
        makeToolUseResponse([
          makeToolCall('undef', {}, 'tc-U'),
          makeToolCall('echo', { text: 'a' }, 'tc-E1'),
          makeToolCall('echo', { text: 'b' }, 'tc-E2'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });
    const callIds = sink
      .byType('tool.call')
      .map((e) => e.toolCallId)
      .toSorted();
    const resultIds = sink
      .byType('tool.result')
      .map((e) => e.toolCallId)
      .toSorted();
    expect(callIds).toEqual(['tc-E1', 'tc-E2', 'tc-U']);
    expect(resultIds).toEqual(callIds);
    expect(context.toolResults().find((r) => r.toolCallId === 'tc-U')?.result.isError).toBe(true);
    expect(context.toolResults().find((r) => r.toolCallId === 'tc-E1')?.result.isError).not.toBe(
      true,
    );
  });

  it('coerces a corrupt finalizeToolResult hook return into an error result', async () => {
    const echo = new EchoTool();
    const hooks: LoopHooks = {
      finalizeToolResult: async () => ({}) as ExecutableToolResult,
    };
    const { sink, context } = await runTurn({
      tools: [echo],
      hooks,
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-E')]),
        makeEndTurnResponse('done'),
      ],
    });
    expect(sink.byType('tool.result').length).toBe(1);
    const result = context.toolResults()[0]?.result;
    expect(result?.isError).toBe(true);
    expect(expectTextOutput(result?.output)).toContain('missing or malformed "output" field');
  });

  it('does not duplicate prepare hook failures in the diagnostic log', async () => {
    const echo = new EchoTool();
    const { log, entries } = makeTestLogger();
    await runTurn({
      tools: [echo],
      log,
      hooks: {
        prepareToolExecution: async () => {
          throw new Error('hook exploded');
        },
      },
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(entries).not.toContainEqual(
      expect.objectContaining({ message: 'prepareToolExecution hook failed' }),
    );
  });

  it('does not log path security setup failures already covered by tool.result', async () => {
    const tool = new PathSecurityTool();
    const { log, entries } = makeTestLogger();
    const { sink } = await runTurn({
      tools: [tool],
      log,
      responses: [
        makeToolUseResponse([makeToolCall('path-secure', {}, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(sink.byType('tool.result')[0]?.result.isError).toBe(true);
    expect(entries).not.toContainEqual(
      expect.objectContaining({ message: 'tool execution setup failed' }),
    );
  });

  it('forwards onUpdate calls as tool.progress events', async () => {
    const progress = new ProgressTool([
      { kind: 'stdout', text: 'a' },
      { kind: 'progress', percent: 25 },
      { kind: 'progress', percent: 75 },
    ]);
    const { sink } = await runTurn({
      tools: [progress],
      responses: [
        makeToolUseResponse([makeToolCall('progress', {}, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });

    const progressEvents = sink.byType('tool.progress');
    expect(progressEvents.length).toBe(3);
    expect(progressEvents.every((e) => e.toolCallId === 'tc-1')).toBe(true);
    expect(progressEvents.map((e) => e.update.kind)).toEqual(['stdout', 'progress', 'progress']);
  });

  it('runs multiple tool calls in the same step (transcripts in provider order)', async () => {
    const echo = new EchoTool();
    const { sink, context } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([
          makeToolCall('echo', { text: 'a' }, 'tc-1'),
          makeToolCall('echo', { text: 'b' }, 'tc-2'),
          makeToolCall('echo', { text: 'c' }, 'tc-3'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(echo.calls.map((c) => c.id)).toEqual(['tc-1', 'tc-2', 'tc-3']);
    // tool.result is dispatched in provider order regardless of
    // execute completion order
    expect(context.toolResults().map((r) => r.toolCallId)).toEqual(['tc-1', 'tc-2', 'tc-3']);
    expect(sink.byType('tool.call').map((e) => e.toolCallId)).toEqual(['tc-1', 'tc-2', 'tc-3']);
  });

  it('executes non-conflicting tool tasks concurrently (causal order, not wall-clock)', async () => {
    // Two GatedTools start, each blocks until released. If the loop executed
    // them serially we could not have both `started` promises resolve
    // before releasing either.
    const a = markReadFileAccesses(new GatedTool('gated-a'));
    const b = markReadFileAccesses(new GatedTool('gated-b'));

    const turnPromise = runTurn({
      tools: [a, b],
      responses: [
        makeToolUseResponse([
          makeToolCall('gated-a', {}, 'tc-a'),
          makeToolCall('gated-b', {}, 'tc-b'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });

    // Both tools must enter plan execution before either releases.
    await Promise.all([a.started, b.started]);
    // Release in reverse provider order.
    b.release();
    a.release();

    const { context, sink } = await turnPromise;
    // Despite execute completing in reverse order, tool.result records
    // are written in provider order.
    expect(context.toolResults().map((r) => r.toolCallId)).toEqual(['tc-a', 'tc-b']);
    // Each tool emitted its tool.call and tool.result.
    expect(
      sink
        .byType('tool.call')
        .map((e) => e.toolCallId)
        .toSorted(),
    ).toEqual(['tc-a', 'tc-b'].toSorted());
    expect(
      sink
        .byType('tool.result')
        .map((e) => e.toolCallId)
        .toSorted(),
    ).toEqual(['tc-a', 'tc-b'].toSorted());
  });

  it('serializes tool tasks with default accesses', async () => {
    const a = new GatedTool('gated-a');
    const b = new GatedTool('gated-b');

    const turnPromise = runTurn({
      tools: [a, b],
      responses: [
        makeToolUseResponse([
          makeToolCall('gated-a', {}, 'tc-a'),
          makeToolCall('gated-b', {}, 'tc-b'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });

    await a.started;
    await expect(
      Promise.race([b.started.then(() => true), waitOneMacrotask().then(() => false)]),
    ).resolves.toBe(false);

    a.release();
    await b.started;
    b.release();

    const { context } = await turnPromise;
    expect(context.toolResults().map((r) => r.toolCallId)).toEqual(['tc-a', 'tc-b']);
  });

  it('computes resource accesses after prepareToolExecution updates args', async () => {
    const tool = new PathLockedGatedTool();
    const hooks: LoopHooks = {
      prepareToolExecution: async ({ toolCall }) =>
        toolCall.id === 'tc-b' ? { updatedArgs: { path: '/repo/a.ts' } } : undefined,
    };

    const turnPromise = runTurn({
      tools: [tool],
      hooks,
      responses: [
        makeToolUseResponse([
          makeToolCall('path-gated', { path: '/repo/a.ts' }, 'tc-a'),
          makeToolCall('path-gated', { path: '/repo/b.ts' }, 'tc-b'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });

    await tool.waitForStartedCount(1);
    await waitOneMacrotask();
    expect(tool.startedIds).toEqual(['tc-a']);

    tool.release('tc-a');
    await tool.waitForStartedCount(2);
    expect(tool.startedIds).toEqual(['tc-a', 'tc-b']);

    tool.release('tc-b');
    const { context } = await turnPromise;
    expect(context.toolResults().map((r) => r.toolCallId)).toEqual(['tc-a', 'tc-b']);
    expect(tool.calls.map((call) => call.args.path)).toEqual(['/repo/a.ts', '/repo/a.ts']);
  });

  it('starts later independent tool tasks behind an earlier queued conflict', async () => {
    const tool = new PathLockedGatedTool();

    const turnPromise = runTurn({
      tools: [tool],
      responses: [
        makeToolUseResponse([
          makeToolCall('path-gated', { path: '/repo/a.ts' }, 'tc-a-1'),
          makeToolCall('path-gated', { path: '/repo/a.ts' }, 'tc-a-2'),
          makeToolCall('path-gated', { path: '/repo/b.ts' }, 'tc-b'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });

    await tool.waitForStartedCount(2);
    await waitOneMacrotask();
    expect(tool.startedIds).toEqual(['tc-a-1', 'tc-b']);

    tool.release('tc-b');
    await waitOneMacrotask();
    expect(tool.startedIds).toEqual(['tc-a-1', 'tc-b']);

    tool.release('tc-a-1');
    await tool.waitForStartedCount(3);
    expect(tool.startedIds).toEqual(['tc-a-1', 'tc-b', 'tc-a-2']);

    tool.release('tc-a-2');
    const { context } = await turnPromise;
    expect(context.toolResults().map((r) => r.toolCallId)).toEqual(['tc-a-1', 'tc-a-2', 'tc-b']);
  });

  it('preserves structured ExecutableToolResult output on transcript and live result event', async () => {
    const blocks = new ContentBlocksTool({
      output: [
        { type: 'text', text: 'see image:' },
        {
          type: 'image_url',
          imageUrl: { url: 'data:image/png;base64,AAAA' },
        },
      ],
    });
    const { context, sink } = await runTurn({
      tools: [blocks],
      responses: [
        makeToolUseResponse([makeToolCall('blocks', {}, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const payload = context.toolResults()[0]?.result;
    expect(payload).toBeDefined();
    // Media-bearing results are kept as a content-part array, not collapsed.
    expect(Array.isArray(payload?.output)).toBe(true);
    if (Array.isArray(payload?.output)) {
      const types = payload.output.map((p) => (p as { type: string }).type);
      expect(types).toContain('text');
      expect(types).toContain('image_url');
    }
    const eventOutput = sink.byType('tool.result')[0]?.result.output;
    expect(Array.isArray(eventOutput)).toBe(true);
  });

  it('preserves media-only image output with a text companion', async () => {
    const image: ContentPart = {
      type: 'image_url',
      imageUrl: { url: 'https://example.com/image.jpg' },
    };

    const output = await contentBlockOutput([image]);

    expect(output[0]).toMatchObject({
      type: 'text',
      text: 'Tool returned non-text content.',
    });
    expect(output.some((part) => part.type === 'image_url')).toBe(true);
  });

  it('preserves a list of only image ContentParts', async () => {
    const img1: ContentPart = {
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,abc' },
    };
    const img2: ContentPart = {
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,def' },
    };

    const output = await contentBlockOutput([img1, img2]);

    expect(output.filter((part) => part.type === 'image_url').length).toBe(2);
  });

  it('preserves an audio-only output', async () => {
    const audio: ContentPart = {
      type: 'audio_url',
      audioUrl: { url: 'data:audio/mp3;base64,abc' },
    };

    const output = await contentBlockOutput([audio]);

    expect(output.some((part) => part.type === 'audio_url')).toBe(true);
  });

  it('preserves an image when the tool emits a single image and no text channel exists', async () => {
    const image: ContentPart = {
      type: 'image_url',
      imageUrl: { url: 'https://example.com/img.jpg' },
    };

    const output = await contentBlockOutput([image]);

    expect(output.find((part) => part.type === 'image_url')).toBeDefined();
  });

  it('every tool.call event has a matching tool.result event (mixed batch)', async () => {
    const echo = new EchoTool();
    const fail = new FailingTool();
    const strict = new StrictArgsTool();
    const { sink } = await runTurn({
      tools: [echo, fail, strict],
      responses: [
        makeResponse(
          makeTextParts(''),
          [
            makeToolCall('echo', { text: 'ok' }, 'tc-good'),
            makeToolCall('fail', {}, 'tc-fail'),
            makeToolCall('strict', { value: 'oops' }, 'tc-bad-args'),
            makeToolCall('ghost', {}, 'tc-missing'),
          ],
          'tool_use',
        ),
        makeEndTurnResponse('done'),
      ],
    });
    const callIds = sink
      .byType('tool.call')
      .map((e) => e.toolCallId)
      .toSorted();
    const resultIds = sink
      .byType('tool.result')
      .map((e) => e.toolCallId)
      .toSorted();
    expect(callIds).toEqual(['tc-bad-args', 'tc-fail', 'tc-good', 'tc-missing']);
    expect(resultIds).toEqual(callIds);
  });
});

interface PathLockedInput {
  readonly path: string;
}

class PathLockedGatedTool implements ExecutableTool<PathLockedInput> {
  readonly name = 'path-gated';
  readonly description = 'Waits behind a path-scoped write lock.';
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  };
  readonly calls: Array<{ readonly id: string; readonly args: PathLockedInput }> = [];
  readonly startedIds: string[] = [];

  private readonly gateResolvers = new Map<string, () => void>();
  private readonly startedWaiters: Array<{ readonly count: number; readonly resolve: () => void }> =
    [];

  resolveExecution(input: PathLockedInput): ToolExecution {
    return {
      accesses: ToolAccesses.writeFile(input.path),
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({
          id: ctx.toolCallId,
          args: input,
        });
        this.startedIds.push(ctx.toolCallId);
        this.resolveStartedWaiters();

        await new Promise<void>((resolve) => {
          this.gateResolvers.set(ctx.toolCallId, resolve);
        });
        return { output: `${input.path} done` };
      },
    };
  }

  release(toolCallId: string): void {
    this.gateResolvers.get(toolCallId)?.();
  }

  waitForStartedCount(count: number): Promise<void> {
    if (this.startedIds.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.startedWaiters.push({ count, resolve });
    });
  }

  private resolveStartedWaiters(): void {
    for (let i = this.startedWaiters.length - 1; i >= 0; i--) {
      const waiter = this.startedWaiters[i];
      if (waiter !== undefined && this.startedIds.length >= waiter.count) {
        this.startedWaiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }
}

class PathSecurityTool implements ExecutableTool<Record<string, unknown>> {
  readonly name = 'path-secure';
  readonly description = 'Fails path checks during setup.';
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    additionalProperties: true,
  };

  resolveExecution(): ToolExecution {
    throw new PathSecurityError(
      'PATH_OUTSIDE_WORKSPACE',
      '../secret',
      '/secret',
      'Path is outside workspace.',
    );
  }
}

class StopSuccessTool implements ExecutableTool<Record<string, unknown>> {
  readonly name = 'stop-success';
  readonly description = 'Returns a successful result that stops the turn.';
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    additionalProperties: true,
  };
  readonly calls: Array<{ readonly id: string }> = [];

  resolveExecution(): ToolExecution {
    return {
      stopBatchAfterThis: true,
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({ id: ctx.toolCallId });
        return { output: 'stopped', stopTurn: true };
      },
    };
  }
}
