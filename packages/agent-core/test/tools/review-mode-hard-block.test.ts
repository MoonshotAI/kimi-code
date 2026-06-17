import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import {
  PermissionManager,
  type PermissionMode,
  type PermissionPolicyContext,
} from '../../src/agent/permission';
import type { ReviewAgentFacade } from '../../src/review';
import { ToolAccesses } from '../../src/loop';
import { createFakeKaos } from './fixtures/fake-kaos';

describe('review mode permission guard', () => {
  it.each(['auto', 'yolo'] satisfies PermissionMode[])(
    'blocks mutation and orchestration tools in %s mode',
    async (mode) => {
      const manager = makeReviewPermissionManager(mode);

      for (const toolName of [
        'Write',
        'Edit',
        'Bash',
        'Agent',
        'AgentSwarm',
        'AskUserQuestion',
        'CronCreate',
        'CronDelete',
        'TaskStop',
        'CustomTool',
      ]) {
        await expect(
          manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName })),
        ).resolves.toMatchObject({
          block: true,
          reason: expect.stringContaining('not available to review workers'),
        });
      }
    },
  );

  it.each(['auto', 'yolo'] satisfies PermissionMode[])(
    'allows review-scoped tools and search in %s mode',
    async (mode) => {
      const manager = makeReviewPermissionManager(mode);

      for (const toolName of ['GetAssignment', 'ReadDiff', 'AddComment', 'UpdateProgress', 'Grep', 'Glob']) {
        await expect(
          manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName })),
        ).resolves.toBeUndefined();
      }
    },
  );

  it('auto-approves review-scoped tools in manual mode', async () => {
    const requestApproval = vi.fn(async () => ({ decision: 'approved' as const }));
    const manager = makeReviewPermissionManager('manual', requestApproval);

    for (const toolName of [
      'GetAssignment',
      'GetChangedFiles',
      'ReadDiff',
      'ReadFileVersion',
      'UpdateProgress',
      'AddComment',
      'GetComments',
      'GetCommentEvidence',
      'MergeComments',
      'DismissComment',
    ]) {
      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName })),
      ).resolves.toBeUndefined();
    }

    expect(requestApproval).not.toHaveBeenCalled();
  });
});

function makeReviewPermissionManager(
  mode: PermissionMode,
  requestApproval?: NonNullable<Agent['rpc']>['requestApproval'],
): PermissionManager {
  let manager!: PermissionManager;
  const agent = {
    type: 'sub',
    review: { assignmentId: 'assignment-1' } as ReviewAgentFacade,
    config: { cwd: '/workspace' },
    kaos: createFakeKaos(),
    emitStatusUpdated: vi.fn(),
    rpc: requestApproval === undefined ? undefined : { requestApproval },
    records: { logRecord: vi.fn() },
    replayBuilder: { push: vi.fn() },
    telemetry: { track: vi.fn() },
    planMode: {
      get isActive() {
        return false;
      },
      get planFilePath() {
        return null;
      },
    },
    swarmMode: {
      get isActive() {
        return false;
      },
    },
  } as unknown as Agent;
  manager = new PermissionManager(agent);
  Object.assign(agent, { permission: manager });
  manager.mode = mode;
  return manager;
}

function hookContext(input: {
  readonly id: string;
  readonly toolName: string;
}): PermissionPolicyContext {
  const args = {};
  const toolCall: ToolCall = {
    type: 'function',
    id: input.id,
    name: input.toolName,
    arguments: JSON.stringify(args),
  };
  return {
    turnId: '0',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as PermissionPolicyContext['llm'],
    toolCall,
    toolCalls: [toolCall],
    args,
    execution: {
      description: `Calling ${input.toolName}`,
      display: { kind: 'generic', summary: `Call ${input.toolName}`, detail: args },
      accesses: ToolAccesses.none(),
      approvalRule: input.toolName,
      execute: async () => ({ output: '' }),
    },
  };
}
