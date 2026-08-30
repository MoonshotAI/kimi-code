import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '#/kosong/contract/message';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ExecutableTool, ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { WireRecord } from '#/wire/record';
import { registerLogServices } from '../../_base/log/stubs';
import { recordingTelemetry } from '../../app/telemetry/stubs';
import { registerTestAgentWireServices, recordingWireLog } from '../../wire/stubs';

class TestTool implements ExecutableTool<Record<string, unknown>> {
  readonly description = 'Test tool.';
  readonly parameters: Record<string, unknown> = { type: 'object', additionalProperties: true };

  constructor(
    readonly name: string,
    private readonly result: ExecutableToolResult,
  ) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => this.result,
    };
  }
}

function toolCall(id: string, name: string): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

let disposables: DisposableStore;
let ix: TestInstantiationService;
let executor: IAgentToolExecutorService;
let registry: IAgentToolRegistryService;
let blobs: IBlobStore;
let liveEvents: Event2[];
let wireRecords: WireRecord[];

beforeEach(() => {
  disposables = new DisposableStore();
  liveEvents = [];
  wireRecords = [];
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      registerTestAgentWireServices(reg, 'wire/file-edit-snapshot-events');
      reg.defineInstance(IAppendLogStore, recordingWireLog(wireRecords));
      reg.defineInstance(IEventBus, {
        _serviceBrand: undefined,
        publish: (event: Event2) => {
          liveEvents.push(event);
        },
        subscribe: () => ({ dispose: () => {} }),
      } as unknown as IEventBus);
      reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
      reg.defineInstance(ITelemetryService, recordingTelemetry([]));
      reg.defineInstance(IAgentToolResultTruncationService, {
        _serviceBrand: undefined,
        truncateForModel: async (input) => input.result,
        isSpillFilePath: () => false,
      });
      reg.defineInstance(IFileSystemStorageService, new InMemoryStorageService());
      reg.define(IBlobStore, BlobStoreService);
      reg.define(IAgentToolRegistryService, AgentToolRegistryService);
      reg.define(IAgentToolExecutorService, AgentToolExecutorService);
      registerLogServices(reg);
    },
    strict: true,
  });
  executor = ix.get(IAgentToolExecutorService);
  registry = ix.get(IAgentToolRegistryService);
  blobs = ix.get(IBlobStore);
});

afterEach(() => disposables.dispose());

async function runToCompletion(call: ToolCall): Promise<void> {
  for await (const _item of executor.execute([call], {
    turnId: 0,
    signal: new AbortController().signal,
  })) {
    void _item;
  }
}

async function waitForRecordedSnapshot(): Promise<WireRecord> {
  return vi.waitFor(() => {
    const record = wireRecords.find((r) => r['type'] === 'file.edit_snapshot.recorded');
    if (record === undefined) throw new Error('not recorded yet');
    return record;
  });
}

describe('file edit snapshot events', () => {
  it('dispatches a live full-text event and a durable blob-backed event for a fileSnapshot result', async () => {
    registry.register(
      new TestTool('Edit', {
        output: 'ok',
        fileSnapshot: { path: '/tmp/a.ts', before: 'old', after: 'new' },
      }),
    );

    await runToCompletion(toolCall('call_1', 'Edit'));

    const live = liveEvents.find((e) => e.type === 'file.edit_snapshot');
    expect(live).toMatchObject({
      type: 'file.edit_snapshot',
      toolCallId: 'call_1',
      path: '/tmp/a.ts',
      before: 'old',
      after: 'new',
    });
    expect(liveEvents.some((e) => e.type === 'file.edit_snapshot.recorded')).toBe(false);

    const recorded = await waitForRecordedSnapshot();
    expect(recorded['toolCallId']).toBe('call_1');
    expect(recorded['path']).toBe('/tmp/a.ts');
    const beforeRef = recorded['before'] as { key: string; bytes: number };
    const afterRef = recorded['after'] as { key: string; bytes: number };
    expect(typeof beforeRef.key).toBe('string');
    expect(typeof afterRef.key).toBe('string');

    const scope = ix.get(IAgentScopeContext).scope();
    expect(Buffer.from((await blobs.get(scope, beforeRef.key))!).toString('utf8')).toBe('old');
    expect(Buffer.from((await blobs.get(scope, afterRef.key))!).toString('utf8')).toBe('new');
  });

  it('still dispatches the live event but skips the durable one when no blob store is registered', async () => {
    const noBlobDisposables = new DisposableStore();
    const noBlobWireRecords: WireRecord[] = [];
    const noBlobLiveEvents: Event2[] = [];
    const noBlobIx = createServices(noBlobDisposables, {
      additionalServices: (reg) => {
        registerTestAgentWireServices(reg, 'wire/file-edit-snapshot-events-no-blob');
        reg.defineInstance(IAppendLogStore, recordingWireLog(noBlobWireRecords));
        reg.defineInstance(IEventBus, {
          _serviceBrand: undefined,
          publish: (event: Event2) => {
            noBlobLiveEvents.push(event);
          },
          subscribe: () => ({ dispose: () => {} }),
        } as unknown as IEventBus);
        reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.defineInstance(IAgentToolResultTruncationService, {
          _serviceBrand: undefined,
          truncateForModel: async (input) => input.result,
          isSpillFilePath: () => false,
        });
        reg.define(IAgentToolRegistryService, AgentToolRegistryService);
        reg.define(IAgentToolExecutorService, AgentToolExecutorService);
        registerLogServices(reg);
      },
    });
    const noBlobExecutor = noBlobIx.get(IAgentToolExecutorService);
    const noBlobRegistry = noBlobIx.get(IAgentToolRegistryService);
    noBlobRegistry.register(
      new TestTool('Edit', {
        output: 'ok',
        fileSnapshot: { path: '/tmp/no-blob.ts', before: 'old', after: 'new' },
      }),
    );

    for await (const _item of noBlobExecutor.execute([toolCall('call_no_blob', 'Edit')], {
      turnId: 0,
      signal: new AbortController().signal,
    })) {
      void _item;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(noBlobLiveEvents.some((e) => e.type === 'file.edit_snapshot')).toBe(true);
    expect(noBlobWireRecords.some((r) => r['type'] === 'file.edit_snapshot.recorded')).toBe(false);

    noBlobDisposables.dispose();
  });

  it('does not dispatch either event when the tool result has no fileSnapshot', async () => {
    registry.register(new TestTool('Read', { output: 'contents' }));

    await runToCompletion(toolCall('call_read', 'Read'));

    expect(liveEvents.some((e) => e.type === 'file.edit_snapshot')).toBe(false);
    expect(wireRecords.some((r) => r['type'] === 'file.edit_snapshot.recorded')).toBe(false);
  });

  it('skips both the live and durable dispatch for a deduplicated call', async () => {
    registry.register(
      new TestTool('Edit', {
        output: 'ok',
        fileSnapshot: { path: '/tmp/dup.ts', before: 'old', after: 'new' },
      }),
    );
    executor.onBeforeExecuteTool((event) => {
      if (event.toolCall.id === 'call_dup') executor.recordDupType('call_dup', 'same_step');
    });

    await runToCompletion(toolCall('call_dup', 'Edit'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(liveEvents.some((e) => e.type === 'file.edit_snapshot')).toBe(false);
    expect(wireRecords.some((r) => r['type'] === 'file.edit_snapshot.recorded')).toBe(false);
  });
});
