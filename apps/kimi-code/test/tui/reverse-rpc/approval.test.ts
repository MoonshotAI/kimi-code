import type { ApprovalRequest } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { createApprovalRequestHandler } from '#/tui/reverse-rpc/approval/handler';

function approvalEvent(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolCallId: 'tc-1',
    toolName: 'Bash',
    action: 'run command',
    display: {
      kind: 'generic',
      summary: 'run command',
      detail: {
        command: 'rm -rf /tmp/cache',
        cwd: '/tmp',
      },
    },
    ...overrides,
  };
}

describe('approval reverse-rpc', () => {
  it('auto-approves queued requests with the same action when the current is approved for session', async () => {
    const controller = new ApprovalController();
    const panel = (id: string, action: string) => ({
      id,
      tool_call_id: id,
      tool_name: 'Bash',
      action,
      description: '',
      display: [],
      choices: [],
    });

    const first = controller.show(panel('tc-1', 'run command: ls'));
    const second = controller.show(panel('tc-2', 'run command: ls'));
    const third = controller.show(panel('tc-3', 'edit src/x.ts'));
    const fourth = controller.show(panel('tc-4', 'run command: ls'));

    controller.respond({ decision: 'approved', scope: 'session', feedback: 'ok' });

    await expect(first).resolves.toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'ok',
    });
    // Queued same-action requests inherit a session-scoped approval without
    // surfacing another panel. The user's feedback is not carried over —
    // it described the first request only.
    await expect(second).resolves.toEqual({ decision: 'approved', scope: 'session' });
    await expect(fourth).resolves.toEqual({ decision: 'approved', scope: 'session' });
    // A different-action request still waits for an explicit decision.
    expect(controller.hasPending()).toBe(true);

    controller.respond({ decision: 'rejected' });
    await expect(third).resolves.toEqual({ decision: 'rejected' });
  });

  it('does not auto-approve queued requests when only approved-once is chosen', async () => {
    const controller = new ApprovalController();
    const panel = (id: string) => ({
      id,
      tool_call_id: id,
      tool_name: 'Bash',
      action: 'run command: ls',
      description: '',
      display: [],
      choices: [],
    });

    const first = controller.show(panel('tc-1'));
    const second = controller.show(panel('tc-2'));

    controller.respond({ decision: 'approved' });

    await expect(first).resolves.toEqual({ decision: 'approved' });
    // The second same-action request must NOT be auto-resolved — approve-once
    // is a one-shot decision, not a session rule.
    expect(controller.hasPending()).toBe(true);
    controller.respond({ decision: 'approved' });
    await expect(second).resolves.toEqual({ decision: 'approved' });
  });

  it('ApprovalController cancels pending requests with a cancelled response', async () => {
    const controller = new ApprovalController();
    const pending = controller.show({
      id: 'req-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });

    controller.cancelAll('closed');

    await expect(pending).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'closed',
    });
  });

  it('adapts approval payloads through the handler and falls back on failure', async () => {
    const controller = new ApprovalController();
    const show = vi.spyOn(controller, 'show').mockResolvedValue({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
    });
    const handler = createApprovalRequestHandler(controller);

    await expect(handler(approvalEvent())).resolves.toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
    });
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tc-1',
        tool_call_id: 'tc-1',
        tool_name: 'Bash',
        display: [
          expect.objectContaining({
            type: 'shell',
            command: 'rm -rf /tmp/cache',
            cwd: '/tmp',
            danger: 'recursive delete',
          }),
        ],
      }),
    );

    show.mockRejectedValueOnce(new Error('boom'));
    await expect(handler(approvalEvent())).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'approval handler failed',
    });
  });
});
