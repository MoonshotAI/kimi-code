/**
 * Approval adapter unit tests (W8.1 / Chain 5).
 */

import { describe, expect, it } from 'vitest';

import type { ApprovalRequest as InProcessApprovalRequest } from '../../src';

import {
  approvalToAgentCoreResponse as toAgentCoreResponse,
  approvalToBrokerRequest as toBrokerRequest,
} from '../../src/services';

describe('approval-adapter · toBrokerRequest (in-process → protocol)', () => {
  const inProc: InProcessApprovalRequest = {
    turnId: 7,
    toolCallId: 'tc_abc',
    toolName: 'shell.run',
    action: 'Run `rm -rf foo/`',
    display: { kind: 'command', command: 'rm -rf foo/', summary: 'rm' } as never,
  };

  it('maps camelCase → snake_case', () => {
    const protoReq = toBrokerRequest(inProc, {
      approvalId: '01J_APPROVAL',
      sessionId: 'sess_x',
      createdAt: '2026-06-04T10:30:00.000Z',
      expiresAt: '2026-06-04T10:31:00.000Z',
    });

    expect(protoReq).toEqual({
      approval_id: '01J_APPROVAL',
      session_id: 'sess_x',
      turn_id: 7,
      tool_call_id: 'tc_abc',
      tool_name: 'shell.run',
      action: 'Run `rm -rf foo/`',
      tool_input_display: { kind: 'command', command: 'rm -rf foo/', summary: 'rm' },
      created_at: '2026-06-04T10:30:00.000Z',
      expires_at: '2026-06-04T10:31:00.000Z',
    });
  });

  it('preserves tool_input_display verbatim (12-arm passthrough)', () => {
    const exotic = { kind: 'plan_review', plan: '...', options: [{ label: 'ok' }] } as never;
    const protoReq = toBrokerRequest(
      { ...inProc, display: exotic },
      {
        approvalId: 'a',
        sessionId: 's',
        createdAt: '2026-06-04T10:30:00.000Z',
        expiresAt: '2026-06-04T10:31:00.000Z',
      },
    );
    expect(protoReq.tool_input_display).toBe(exotic);
  });

  it('omits turn_id when undefined', () => {
    const noTurn = { ...inProc };
    delete (noTurn as { turnId?: number }).turnId;
    const protoReq = toBrokerRequest(noTurn, {
      approvalId: 'a',
      sessionId: 's',
      createdAt: '2026-06-04T10:30:00.000Z',
      expiresAt: '2026-06-04T10:31:00.000Z',
    });
    expect(protoReq.turn_id).toBeUndefined();
  });
});

describe('approval-adapter · toAgentCoreResponse (protocol → in-process)', () => {
  it('maps snake_case selected_label → camelCase selectedLabel', () => {
    const inProcResp = toAgentCoreResponse({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
      selected_label: 'Run command',
    });
    expect(inProcResp).toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
      selectedLabel: 'Run command',
    });
  });

  it('omits optional fields when absent', () => {
    const inProcResp = toAgentCoreResponse({ decision: 'rejected' });
    expect(inProcResp).toEqual({
      decision: 'rejected',
      scope: undefined,
      feedback: undefined,
      selectedLabel: undefined,
    });
  });

  it('round-trips a cancelled decision', () => {
    const inProcResp = toAgentCoreResponse({ decision: 'cancelled', feedback: 'user closed' });
    expect(inProcResp.decision).toBe('cancelled');
    expect(inProcResp.feedback).toBe('user closed');
  });
});
