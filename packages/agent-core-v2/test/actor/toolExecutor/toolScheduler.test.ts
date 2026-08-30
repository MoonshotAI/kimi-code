import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { registerLoopControl } from '#/actor/loop/internal/access';
import type { ToolCall } from '#/kosong/contract/message';
import {
  ToolAccesses,
  type ExecutableTool,
  type ExecutableToolResult,
  type ToolExecution,
  type ToolResult,
} from '#/tool/toolContract';
import type { AgentToolsRuntime } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubLoopWithHooks } from '../../agent/loop/stubs';
import {
  createMachineExecutorHarness,
  registerMachineExecutorTestServices,
  type MachineExecutorHarness,
} from './stubs';

let disposables: DisposableStore;
let ix: TestInstantiationService;
let harness: MachineExecutorHarness;
let executor: AgentToolsRuntime;
let telemetryEvents: TelemetryRecord[];
let started: string[];

beforeEach(() => {
  disposables = new DisposableStore();
  telemetryEvents = [];
  started = [];
  const agentScope = makeAgentScopeContext({ agentId: 'main', agentScope: '', generation: 1 });
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      registerMachineExecutorTestServices(reg, (id) => ix.get(id as never), agentScope, {
        telemetry: recordingTelemetry(telemetryEvents),
        wireScope: 'wire/tool-scheduling',
      });
    },
    strict: true,
  });
  registerLoopControl(agentScope.agentContext, stubLoopWithHooks(), () => ({
    nextTurnId: 0,
    cancelledTurnIds: [],
  }));
  harness = createMachineExecutorHarness({ ix, agentContext: agentScope.agentContext });
  executor = harness.executor;
});

afterEach(() => {
  harness.dispose();
  disposables.dispose();
});

interface ControlledTool {
  readonly tool: ExecutableTool;
  resolve(): void;
  fail(error: unknown): void;
}

function controlled(name: string, accesses: ToolAccesses): ControlledTool {
  let release!: () => void;
  let fail!: (error: unknown) => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const tool: ExecutableTool<Record<string, unknown>> = {
    name,
    description: 'Controlled access tool.',
    parameters: { type: 'object', additionalProperties: true },
    resolveExecution: (): ToolExecution => ({
      approvalRule: name,
      accesses,
      execute: async (): Promise<ExecutableToolResult> => {
        started.push(name);
        await gate;
        return { output: name };
      },
    }),
  };
  return { tool, resolve: release, fail };
}

function startBatch(tools: readonly ControlledTool[]): Promise<ToolResult[]> {
  const calls: ToolCall[] = tools.map(({ tool }, index) => ({
    type: 'function',
    id: `call_${index}_${tool.name}`,
    name: tool.name,
    arguments: '{}',
  }));
  for (const { tool } of tools) harness.registry.register(tool);
  return (async () => {
    const results: ToolResult[] = [];
    for await (const item of executor.execute(calls, {
      turnId: 0,
      signal: new AbortController().signal,
    })) {
      results.push(item.result);
    }
    return results;
  })();
}

async function waitOneMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('tool execution scheduling', () => {
  it('starts read accesses on the same path concurrently', async () => {
    const first = controlled('first', ToolAccesses.readFile('/repo/a.ts'));
    const second = controlled('second', ToolAccesses.readFile('/repo/a.ts'));

    const done = startBatch([first, second]);
    await waitOneMacrotask();
    expect(started).toEqual(['first', 'second']);

    second.resolve();
    first.resolve();
    await done;
  });

  it('waits when read and write accesses intersect', async () => {
    const writer = controlled('writer', ToolAccesses.writeFile('/repo/a.ts'));
    const reader = controlled('reader', ToolAccesses.readFile('/repo/a.ts'));

    const done = startBatch([writer, reader]);
    await waitOneMacrotask();
    expect(started).toEqual(['writer']);

    writer.resolve();
    await waitOneMacrotask();
    expect(started).toEqual(['writer', 'reader']);

    reader.resolve();
    await done;
  });

  it('serializes write accesses on the same path', async () => {
    const firstWriter = controlled('first-writer', ToolAccesses.writeFile('/repo/a.ts'));
    const secondWriter = controlled('second-writer', ToolAccesses.writeFile('/repo/a.ts'));

    const done = startBatch([firstWriter, secondWriter]);
    await waitOneMacrotask();
    expect(started).toEqual(['first-writer']);

    firstWriter.resolve();
    await waitOneMacrotask();
    expect(started).toEqual(['first-writer', 'second-writer']);

    secondWriter.resolve();
    await done;
  });

  it('serializes path accesses that differ only by case', async () => {
    const writer = controlled('writer', ToolAccesses.writeFile('C:\\Repo\\a.ts'));
    const reader = controlled('reader', ToolAccesses.readFile('c:/repo/A.ts'));

    const done = startBatch([writer, reader]);
    await waitOneMacrotask();
    expect(started).toEqual(['writer']);

    writer.resolve();
    await waitOneMacrotask();
    expect(started).toEqual(['writer', 'reader']);

    reader.resolve();
    await done;
  });

  it('does not block non-intersecting path accesses', async () => {
    const writer = controlled('writer', ToolAccesses.writeFile('/repo/a.ts'));
    const reader = controlled('reader', ToolAccesses.readFile('/repo/b.ts'));

    const done = startBatch([writer, reader]);
    await waitOneMacrotask();
    expect(started).toEqual(['writer', 'reader']);

    reader.resolve();
    writer.resolve();
    await done;
  });

  it('treats recursive path accesses as covering descendants', async () => {
    const treeReader = controlled('tree-reader', ToolAccesses.readTree('/repo/src'));
    const childWriter = controlled('child-writer', ToolAccesses.writeFile('/repo/src/a.ts'));

    const done = startBatch([treeReader, childWriter]);
    await waitOneMacrotask();
    expect(started).toEqual(['tree-reader']);

    treeReader.resolve();
    await waitOneMacrotask();
    expect(started).toEqual(['tree-reader', 'child-writer']);

    childWriter.resolve();
    await done;
  });

  it('releases conflicting accesses when a tool fails', async () => {
    const writer = controlled('writer', ToolAccesses.writeFile('/repo/a.ts'));
    const reader = controlled('reader', ToolAccesses.readFile('/repo/a.ts'));

    const done = startBatch([writer, reader]);
    await waitOneMacrotask();
    expect(started).toEqual(['writer']);

    writer.fail(new Error('boom'));
    await waitOneMacrotask();
    expect(started).toEqual(['writer', 'reader']);

    reader.resolve();
    const results = await done;
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ output: 'Tool "writer" failed: boom', isError: true }),
        expect.objectContaining({ output: 'reader' }),
      ]),
    );
  });

  it('starts later independent accesses while an earlier conflicting call is queued', async () => {
    const firstWriter = controlled('first-writer', ToolAccesses.writeFile('/repo/a.ts'));
    const secondWriter = controlled('second-writer', ToolAccesses.writeFile('/repo/a.ts'));
    const reader = controlled('reader', ToolAccesses.readFile('/repo/b.ts'));

    const done = startBatch([firstWriter, secondWriter, reader]);
    await waitOneMacrotask();
    expect(started).toEqual(['first-writer', 'reader']);

    reader.resolve();
    firstWriter.resolve();
    await waitOneMacrotask();
    expect(started).toEqual(['first-writer', 'reader', 'second-writer']);

    secondWriter.resolve();
    await done;
  });

  it('does not start later tasks that conflict with queued accesses', async () => {
    const writer = controlled('writer', ToolAccesses.writeFile('/repo/a.ts'));
    const exclusive = controlled('exclusive', ToolAccesses.all());
    const reader = controlled('reader', ToolAccesses.readFile('/repo/b.ts'));

    const done = startBatch([writer, exclusive, reader]);
    await waitOneMacrotask();
    expect(started).toEqual(['writer']);

    writer.resolve();
    await waitOneMacrotask();
    expect(started).toEqual(['writer', 'exclusive']);

    exclusive.resolve();
    await waitOneMacrotask();
    expect(started).toEqual(['writer', 'exclusive', 'reader']);

    reader.resolve();
    await done;
  });

  it('serializes all-resource access against file access', async () => {
    const reader = controlled('reader', ToolAccesses.readFile('/repo/a.ts'));
    const exclusive = controlled('exclusive', ToolAccesses.all());

    const done = startBatch([reader, exclusive]);
    await waitOneMacrotask();
    expect(started).toEqual(['reader']);

    reader.resolve();
    await waitOneMacrotask();
    expect(started).toEqual(['reader', 'exclusive']);

    exclusive.resolve();
    await done;
  });
});
