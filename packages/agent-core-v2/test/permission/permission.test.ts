import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import type { ApprovalResponse } from '#/approval/approval';
import { IApprovalService } from '#/approval/approval';
import { IExternalHooksService } from '#/externalHooks';
import type { LLM } from '#/loop/llm';
import type { ResolvedToolExecutionHookContext } from '#/loop';
import { IPermissionService, PermissionService } from '#/permission';
import type { PermissionServiceOptions } from '#/permission';
import { IPermissionModeService } from '#/permissionMode';
import type { PermissionMode, PermissionPolicyEvaluation } from '#/permissionPolicy';
import { IPermissionPolicyService } from '#/permissionPolicy';
import type { PermissionRule } from '#/permissionRules';
import { IPermissionRulesService } from '#/permissionRules';
import { ITelemetryService } from '#/telemetry/telemetry';
import type { ToolCall } from '@moonshot-ai/kosong';

import {
  stubApprovalService,
  stubPermissionModeService,
  stubPermissionPolicyService,
  stubPermissionRulesService,
} from './stubs';

function makeContext(toolName: string): ResolvedToolExecutionHookContext {
  const toolCall: ToolCall = {
    type: 'function',
    id: `call-${toolName}`,
    name: toolName,
    arguments: '{}',
  };
  return {
    turnId: '1',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as LLM,
    toolCall,
    toolCalls: [toolCall],
    args: {},
    execution: {
      approvalRule: `${toolName}(*)`,
      execute: () => Promise.resolve({ output: '' }),
    },
  };
}

describe('PermissionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let rules: readonly PermissionRule[];
  let policyResult: PermissionPolicyEvaluation | undefined;
  let approvalResponse: ApprovalResponse;

  beforeEach(() => {
    disposables = new DisposableStore();
    mode = 'auto';
    rules = [];
    policyResult = undefined;
    approvalResponse = { decision: 'approved' };
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IPermissionModeService, stubPermissionModeService(() => mode));
        reg.defineInstance(IPermissionRulesService, stubPermissionRulesService(() => rules));
        reg.defineInstance(
          IPermissionPolicyService,
          stubPermissionPolicyService(() => policyResult),
        );
        reg.definePartialInstance(IExternalHooksService, {
          triggerPermissionRequest: () => {},
          triggerPermissionResult: () => {},
        });
        reg.definePartialInstance(ITelemetryService, { track: () => {} });
        reg.defineInstance(IApprovalService, stubApprovalService(() => approvalResponse));
      },
    });
  });
  afterEach(() => disposables.dispose());

  // NOTE: PermissionService is built via createInstance (not get) because its
  // first constructor parameter, `options`, is a static argument the container
  // cannot bake into a singleton. See di-testing.md "Exceptions".
  function make(options: PermissionServiceOptions = {}): IPermissionService {
    return ix.createInstance(PermissionService, options);
  }

  it('returns undefined when no policy evaluates', async () => {
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toBeUndefined();
  });

  it('maps an approve decision to undefined', async () => {
    policyResult = { policyName: 'p', result: { kind: 'approve' } };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toBeUndefined();
  });

  it('passes executionMetadata through on approve', async () => {
    const executionMetadata = { marker: true };
    policyResult = {
      policyName: 'p',
      result: { kind: 'approve', executionMetadata },
    };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toEqual({ executionMetadata });
  });

  it('maps a deny decision to a block with the policy message', async () => {
    policyResult = { policyName: 'p', result: { kind: 'deny', message: 'nope' } };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toEqual({
      block: true,
      reason: 'nope',
    });
  });

  it('uses a default reason when a deny has no message', async () => {
    policyResult = { policyName: 'p', result: { kind: 'deny' } };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toEqual({
      block: true,
      reason: 'Tool "bash" was denied by permission policy.',
    });
  });

  it('maps an approved ask to undefined', async () => {
    policyResult = { policyName: 'p', result: { kind: 'ask' } };
    approvalResponse = { decision: 'approved' };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toBeUndefined();
  });

  it('maps a rejected ask to a block', async () => {
    policyResult = { policyName: 'p', result: { kind: 'ask' } };
    approvalResponse = { decision: 'rejected' };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toEqual({
      block: true,
      reason: 'Tool "bash" was not run because the user rejected the approval request.',
    });
  });

  it('data() reflects the mode and rules services', () => {
    mode = 'yolo';
    rules = [{ decision: 'allow', scope: 'user', pattern: 'Bash(*)' }];
    const svc = make();
    expect(svc.data()).toEqual({ mode: 'yolo', rules });
  });
});
