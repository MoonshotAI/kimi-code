import { describe, expect, it } from 'vitest';

import {
  APPROVE_ALWAYS_OPTION_ID,
  APPROVE_ONCE_OPTION_ID,
  approvalRequestToPermissionOptions,
  attachSelectedLabel,
  buildPermissionToolCallUpdate,
  permissionResponseToApprovalResponse,
  PLAN_APPROVE_OPTION_ID,
  PLAN_REJECT_AND_EXIT_OPTION_ID,
  PLAN_REVISE_OPTION_ID,
  REJECT_OPTION_ID,
} from '../src/approval';

import type { PermissionOption, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { SessionApprovalRequest } from '@moonshot-ai/agent-core-v2';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } };
}

const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

const commandDisplay: ToolInputDisplay = {
  kind: 'command',
  command: 'echo hi',
} as unknown as ToolInputDisplay;

function makeRequest(display: ToolInputDisplay, turnId?: number): SessionApprovalRequest {
  return {
    toolName: 'Bash',
    action: 'run `echo hi`',
    toolCallId: 'call_1',
    display,
    turnId,
  };
}

describe('approvalRequestToPermissionOptions', () => {
  it('returns the canonical 3 options for a non-plan_review request', () => {
    const options = approvalRequestToPermissionOptions(makeRequest(commandDisplay));
    expect(options.map((o) => o.optionId)).toEqual([
      APPROVE_ONCE_OPTION_ID,
      APPROVE_ALWAYS_OPTION_ID,
      REJECT_OPTION_ID,
    ]);
  });

  it('expands plan_review into per-option allows plus revise/reject-and-exit', () => {
    const display: ToolInputDisplay = {
      kind: 'plan_review',
      plan: 'do the thing',
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    } as unknown as ToolInputDisplay;
    const options = approvalRequestToPermissionOptions(makeRequest(display));
    expect(options.map((o) => o.optionId)).toEqual([
      'plan_opt_0',
      'plan_opt_1',
      'plan_opt_2',
      PLAN_REVISE_OPTION_ID,
      PLAN_REJECT_AND_EXIT_OPTION_ID,
    ]);
    expect(options[0]).toMatchObject({ name: 'A', kind: 'allow_once' });
  });

  it('falls back to a single plan_approve when fewer than 2 options', () => {
    const display: ToolInputDisplay = {
      kind: 'plan_review',
      plan: 'do the thing',
    } as unknown as ToolInputDisplay;
    const options = approvalRequestToPermissionOptions(makeRequest(display));
    expect(options[0]?.optionId).toBe(PLAN_APPROVE_OPTION_ID);
  });
});

describe('permissionResponseToApprovalResponse', () => {
  it('maps cancelled to decision cancelled', () => {
    expect(permissionResponseToApprovalResponse(makeRequest(commandDisplay), cancelled)).toEqual({
      decision: 'cancelled',
    });
  });

  it('maps approve_once to approved with no scope', () => {
    expect(
      permissionResponseToApprovalResponse(
        makeRequest(commandDisplay),
        selected(APPROVE_ONCE_OPTION_ID),
      ),
    ).toEqual({ decision: 'approved' });
  });

  it('maps approve_always to approved with session scope', () => {
    expect(
      permissionResponseToApprovalResponse(
        makeRequest(commandDisplay),
        selected(APPROVE_ALWAYS_OPTION_ID),
      ),
    ).toEqual({ decision: 'approved', scope: 'session' });
  });

  it('maps reject to rejected', () => {
    expect(
      permissionResponseToApprovalResponse(makeRequest(commandDisplay), selected(REJECT_OPTION_ID)),
    ).toEqual({ decision: 'rejected' });
  });

  it('maps an unknown optionId to rejected (defensive)', () => {
    expect(
      permissionResponseToApprovalResponse(makeRequest(commandDisplay), selected('mystery')),
    ).toEqual({ decision: 'rejected' });
  });

  it('maps plan_opt_<i> to approved with the option label as selectedLabel', () => {
    const display: ToolInputDisplay = {
      kind: 'plan_review',
      plan: 'p',
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
    } as unknown as ToolInputDisplay;
    expect(permissionResponseToApprovalResponse(makeRequest(display), selected('plan_opt_1'))).toEqual({
      decision: 'approved',
      selectedLabel: 'Beta',
    });
  });

  it('maps plan_revise / plan_reject_and_exit to rejected with labels', () => {
    const display: ToolInputDisplay = {
      kind: 'plan_review',
      plan: 'p',
      options: [{ label: 'A' }, { label: 'B' }],
    } as unknown as ToolInputDisplay;
    expect(
      permissionResponseToApprovalResponse(makeRequest(display), selected(PLAN_REVISE_OPTION_ID)),
    ).toEqual({ decision: 'rejected', selectedLabel: 'Revise' });
    expect(
      permissionResponseToApprovalResponse(
        makeRequest(display),
        selected(PLAN_REJECT_AND_EXIT_OPTION_ID),
      ),
    ).toEqual({ decision: 'rejected', selectedLabel: 'Reject and Exit' });
  });
});

describe('buildPermissionToolCallUpdate', () => {
  it('prefixes the toolCallId with the turnId when present', () => {
    const update = buildPermissionToolCallUpdate(makeRequest(commandDisplay, 7));
    expect(update.toolCallId).toBe('7:call_1');
    expect(update.title).toBe('Bash');
  });

  it('falls back to the raw id when turnId is absent', () => {
    const update = buildPermissionToolCallUpdate(makeRequest(commandDisplay));
    expect(update.toolCallId).toBe('call_1');
  });

  it('always appends an action-summary content entry', () => {
    const update = buildPermissionToolCallUpdate(makeRequest(commandDisplay, 1));
    const last = update.content?.at(-1);
    expect(last).toMatchObject({
      type: 'content',
      content: { type: 'text', text: 'Requesting approval to run `echo hi`' },
    });
  });
});

describe('attachSelectedLabel', () => {
  const options: readonly PermissionOption[] = [
    { optionId: APPROVE_ONCE_OPTION_ID, name: 'Approve once', kind: 'allow_once' },
  ];

  it('attaches the matched option name as selectedLabel', () => {
    const result = attachSelectedLabel(
      selected(APPROVE_ONCE_OPTION_ID),
      { decision: 'approved' },
      options,
    );
    expect(result).toEqual({ decision: 'approved', selectedLabel: 'Approve once' });
  });

  it('is a no-op for cancelled outcomes', () => {
    const result = attachSelectedLabel(cancelled, { decision: 'cancelled' }, options);
    expect(result).toEqual({ decision: 'cancelled' });
  });
});
