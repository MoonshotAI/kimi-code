import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { ToolCall } from '#/kosong/contract/message';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
} from '#/agent/toolExecutor/toolHooks';
import { ToolAccesses } from '#/tool/toolContract';
import { IFlagService } from '#/app/flag/flag';
import { DYNAMIC_WORKFLOWS_FLAG_ID } from '#/app/workflow/flag';
import { WORKFLOW_TOOL_NAME } from '#/app/workflow/workflow.types';

import {
  IAgentWorkflowReviewService,
  WORKFLOW_REVIEW_ORIGIN,
} from '#/agent/workflow/agentWorkflowReview';
import { AgentWorkflowReviewService } from '#/agent/workflow/agentWorkflowReviewService';

function makeEvent(toolName: string): BeforeToolExecuteEvent & {
  waitUntilFactories: (() => Promise<BeforeExecuteDecision | undefined>)[];
} {
  const toolCall: ToolCall = {
    type: 'function',
    id: `call_${toolName}`,
    name: toolName,
    arguments: '{}',
  };
  const waitUntilFactories: (() => Promise<BeforeExecuteDecision | undefined>)[] = [];
  const event = {
    turnId: 1,
    signal: new AbortController().signal,
    toolCall,
    toolCalls: [toolCall],
    args: {},
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: () => Promise.resolve({ output: '' }),
    },
    waitUntilFactories,
    veto: () => {},
    allow: () => {},
    pass: () => {},
    waitUntil: (factory: () => Promise<BeforeExecuteDecision | undefined>) => {
      waitUntilFactories.push(factory);
    },
  };
  return event as unknown as BeforeToolExecuteEvent & { waitUntilFactories: typeof waitUntilFactories };
}

describe('AgentWorkflowReviewService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let flagEnabled: boolean;
  let listener: ((event: BeforeToolExecuteEvent) => void) | undefined;
  let approvalCalls: { origin: string; kind: string }[];
  let approvalDecision: BeforeExecuteDecision | undefined;

  beforeEach(() => {
    disposables = new DisposableStore();
    flagEnabled = true;
    listener = undefined;
    approvalCalls = [];
    approvalDecision = undefined;
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentToolExecutorService, {
          onBeforeExecuteTool: (handler: (event: BeforeToolExecuteEvent) => void) => {
            listener = handler;
            return { dispose: () => {} };
          },
        });
        reg.definePartialInstance(IAgentToolApprovalService, {
          requestToolApproval: (_context: unknown, result: { kind: string }, origin: string) => {
            approvalCalls.push({ origin, kind: result.kind });
            return Promise.resolve(approvalDecision);
          },
        });
        reg.definePartialInstance(IFlagService, { enabled: () => flagEnabled });
        reg.define(IAgentWorkflowReviewService, AgentWorkflowReviewService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('registers an onBeforeExecuteTool listener on construction', () => {
    ix.get(IAgentWorkflowReviewService);
    expect(listener).toBeDefined();
  });

  it('asks for approval on every Workflow call when the flag is on', async () => {
    ix.get(IAgentWorkflowReviewService);
    const event = makeEvent(WORKFLOW_TOOL_NAME);
    listener!(event);

    expect(event.waitUntilFactories).toHaveLength(1);
    const decision = await event.waitUntilFactories[0]!();
    expect(decision).toBeUndefined();
    expect(approvalCalls).toEqual([{ origin: WORKFLOW_REVIEW_ORIGIN, kind: 'ask' }]);
  });

  it('vetoes the call when the approval round-trip rejects', async () => {
    approvalDecision = { veto: { output: 'denied', isError: true } };
    ix.get(IAgentWorkflowReviewService);
    const event = makeEvent(WORKFLOW_TOOL_NAME);
    listener!(event);

    const decision = await event.waitUntilFactories[0]!();
    expect(decision).toEqual({ veto: { output: 'denied', isError: true } });
  });

  it('ignores other tools', () => {
    ix.get(IAgentWorkflowReviewService);
    const event = makeEvent('Bash');
    listener!(event);

    expect(event.waitUntilFactories).toEqual([]);
    expect(approvalCalls).toEqual([]);
  });

  it('does not review when the dynamic-workflows flag is off', () => {
    flagEnabled = false;
    ix.get(IAgentWorkflowReviewService);
    const event = makeEvent(WORKFLOW_TOOL_NAME);
    listener!(event);

    expect(event.waitUntilFactories).toEqual([]);
    expect(approvalCalls).toEqual([]);
  });
});
