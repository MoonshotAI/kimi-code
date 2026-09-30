import { describe, expect, it } from 'vitest';

import {
  adaptApprovalPayload,
  adaptPanelResponse,
  type PermissionApprovalPayload,
  type PlanReviewPayload,
} from '#/tui/reverse-rpc/approval/adapter';

function permissionPayload(detail: unknown): PermissionApprovalPayload {
  return {
    id: 'approval_1',
    sessionId: 'ses-1',
    agentId: 'main',
    toolCallId: 'tc-1',
    toolName: 'Bash',
    action: 'Approve Bash',
    display: { kind: 'generic', summary: 'Approve Bash', detail },
  };
}

describe('approval adapter', () => {
  it('adapts command args into shell blocks with approval choices', () => {
    const adapted = adaptApprovalPayload(
      'interaction-1',
      permissionPayload({
        command: 'sudo rm -rf /tmp/cache',
        cwd: '/tmp',
      }),
    );

    expect(adapted).toMatchObject({
      id: 'interaction-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      display: [
        {
          type: 'shell',
          language: 'bash',
          command: 'sudo rm -rf /tmp/cache',
          cwd: '/tmp',
          danger: 'recursive delete',
        },
      ],
    });
    expect(adapted.choices.map((choice) => choice.label)).toEqual([
      'Approve once',
      'Approve for this session',
      'Reject',
      'Reject with feedback',
    ]);
  });

  it('emits only a diff block for Edit — no separate file_op title row', () => {
    const adapted = adaptApprovalPayload(
      'interaction-2',
      permissionPayload({
        file_path: 'src/foo.ts',
        old_string: 'a\nb\nc',
        new_string: 'a\nB\nc',
      }),
    );

    expect(adapted.display).toEqual([
      { type: 'diff', path: 'src/foo.ts', old_text: 'a\nb\nc', new_text: 'a\nB\nc' },
    ]);
  });

  it('emits a file_content block for Write so the new file previews as code, not diff', () => {
    const adapted = adaptApprovalPayload(
      'interaction-3',
      permissionPayload({
        file_path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      }),
    );

    expect(adapted.display).toEqual([
      {
        type: 'file_content',
        path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
    ]);
  });

  it('keeps a path-only file_op block for Read', () => {
    const adapted = adaptApprovalPayload(
      'interaction-4',
      { ...permissionPayload({ file_path: 'src/foo.ts' }), toolName: 'Read' },
    );

    expect(adapted.display).toEqual([
      { type: 'file_op', operation: 'read', path: 'src/foo.ts' },
    ]);
  });

  it('adapts a plan review into approve/reject-and-exit/revise choices', () => {
    const payload: PlanReviewPayload = {
      plan: '# Plan\n\n- Inspect\n- Change\n- Verify',
      path: '/tmp/kimi-plan.md',
    };
    const adapted = adaptApprovalPayload('interaction-5', payload);

    expect(adapted.tool_name).toBe('ExitPlanMode');
    expect(adapted.display).toEqual([
      { type: 'file_content', path: '/tmp/kimi-plan.md', content: payload.plan },
    ]);
    expect(adapted.choices).toEqual([
      { label: 'Approve', response: 'approved', selected_label: 'Approve' },
      { label: 'Reject and Exit', response: 'rejected', selected_label: 'Reject and Exit' },
      {
        label: 'Revise',
        response: 'rejected',
        selected_label: 'Revise',
        requires_feedback: true,
      },
    ]);
  });

  it('renders multi-option plan review choices ahead of reject controls', () => {
    const payload: PlanReviewPayload = {
      plan: '# Plan',
      path: '/tmp/kimi-plan.md',
      options: [
        { label: 'Approach A', description: 'Small refactor' },
        { label: 'Approach B', description: 'Full refactor' },
      ],
    };
    const adapted = adaptApprovalPayload('interaction-6', payload);

    expect(adapted.choices).toEqual([
      { label: 'Approach A', response: 'approved', selected_label: 'Approach A' },
      { label: 'Approach B', response: 'approved', selected_label: 'Approach B' },
      { label: 'Reject and Exit', response: 'rejected', selected_label: 'Reject and Exit' },
      {
        label: 'Revise',
        response: 'rejected',
        selected_label: 'Revise',
        requires_feedback: true,
      },
    ]);
  });

  it('maps an approved_for_session panel response to a session-scoped approval', () => {
    expect(
      adaptPanelResponse({ response: 'approved_for_session' }),
    ).toEqual({ decision: 'approved', scope: 'session', feedback: undefined, selectedLabel: undefined });
    expect(adaptPanelResponse({ response: 'rejected', feedback: 'no' })).toEqual({
      decision: 'rejected',
      feedback: 'no',
      selectedLabel: undefined,
    });
  });
});
