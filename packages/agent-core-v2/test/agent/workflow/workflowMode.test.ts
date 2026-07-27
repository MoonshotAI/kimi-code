import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IWorkflowModeService } from '#/agent/workflow/workflowMode';
import { WorkflowModeService } from '#/agent/workflow/workflowModeService';
import { WorkflowModel } from '#/agent/workflow/workflowModeOps';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { stubContextMemory } from '../contextMemory/stubs';
import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

describe('WorkflowModeService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    registerTestAgentWire(ix, testWireScope('wire', 'workflow-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    ix.set(IAgentStateService, new AgentStateService());
    ix.stub(IAgentContextInjectorService, {
      register: () => ({ dispose: () => {} }),
      injectAfterCompaction: async () => {},
    });
    ix.set(IWorkflowModeService, new SyncDescriptor(WorkflowModeService));
  });

  afterEach(() => disposables.dispose());

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const workflow = ix.get(IWorkflowModeService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    expect(workflow.isActive).toBe(false);
    workflow.enter('manual');
    expect(workflow.isActive).toBe(true);
    workflow.exit();
    expect(workflow.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', workflowMode: true },
      { type: 'agent.status.updated', workflowMode: false },
      { type: 'context.spliced', start: 0, deleteCount: 1, messages: [] },
    ]);
  });

  it('enter is a no-op when already active', () => {
    const workflow = ix.get(IWorkflowModeService);
    workflow.enter('manual');
    expect(workflow.isActive).toBe(true);

    // Second enter should be a no-op
    workflow.enter('command');
    expect(workflow.isActive).toBe(true);
  });

  it('exit is a no-op when not active', () => {
    const workflow = ix.get(IWorkflowModeService);
    expect(() => workflow.exit()).not.toThrow();
    expect(workflow.isActive).toBe(false);
  });

  it('dispatch persists enter/exit records and replay rebuilds the trigger', async () => {
    const workflow = ix.get(IWorkflowModeService);
    workflow.enter('manual');

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'workflow-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      { type: 'workflow_mode.enter', trigger: 'manual', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const fresh = registerTestAgentWire(ix2, testWireScope('wire', 'workflow-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    await restoreTestAgentWire(
      fresh,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'workflow-replay'),
      records,
    );
    expect(fresh.getModel(WorkflowModel)).toBe('manual');
  });
});
