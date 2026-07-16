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

  it('handles very long action text', () => {
    const longAction = 'A'.repeat(10_000);
    const protoReq = toBrokerRequest(
      { ...inProc, action: longAction },
      {
        approvalId: 'a',
        sessionId: 's',
        createdAt: '2026-06-04T10:30:00.000Z',
        expiresAt: '2026-06-04T10:31:00.000Z',
      },
    );
    expect(protoReq.action).toBe(longAction);
    expect(protoReq.action.length).toBe(10_000);
  });

  it('handles empty action text', () => {
    const protoReq = toBrokerRequest(
      { ...inProc, action: '' },
      {
        approvalId: 'a',
        sessionId: 's',
        createdAt: '2026-06-04T10:30:00.000Z',
        expiresAt: '2026-06-04T10:31:00.000Z',
      },
    );
    expect(protoReq.action).toBe('');
  });

  it('handles special characters in action and feedback', () => {
    const protoReq = toBrokerRequest(
      { ...inProc, action: 'rm -rf /tmp/ \"test\" && echo $HOME' },
      {
        approvalId: 'a',
        sessionId: 's',
        createdAt: '2026-06-04T10:30:00.000Z',
        expiresAt: '2026-06-04T10:31:00.000Z',
      },
    );
    expect(protoReq.action).toContain('rm -rf');
    expect(protoReq.action).toContain('$HOME');

    const inProcResp = toAgentCoreResponse({ decision: 'rejected', feedback: 'N/A: <script>alert(1)</script>' });
    expect(inProcResp.feedback).toBe('N/A: <script>alert(1)</script>');
  });

  it('handles a very long approvalId', () => {
    const longId = 'app_' + 'x'.repeat(100);
    const protoReq = toBrokerRequest(inProc, {
      approvalId: longId,
      sessionId: 's',
      createdAt: '2026-06-04T10:30:00.000Z',
      expiresAt: '2026-06-04T10:31:00.000Z',
    });
    expect(protoReq.approval_id).toBe(longId);
  });

  it('handles a null display value', () => {
    const protoReq = toBrokerRequest(
      { ...inProc, display: null as unknown as typeof inProc.display },
      {
        approvalId: 'a',
        sessionId: 's',
        createdAt: '2026-06-04T10:30:00.000Z',
        expiresAt: '2026-06-04T10:31:00.000Z',
      },
    );
    expect(protoReq.tool_input_display).toBeNull();
  });

  it('handles all decision values', () => {
    for (const decision of ['approved', 'rejected', 'cancelled', 'error'] as const) {
      const inProcResp = toAgentCoreResponse({ decision });
      expect(inProcResp.decision).toBe(decision);
    }
  });
});
