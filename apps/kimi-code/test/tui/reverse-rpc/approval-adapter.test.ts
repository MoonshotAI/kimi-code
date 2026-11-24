import { describe, expect, it } from 'vitest';

import { adaptApprovalRequest, adaptPanelResponse } from '#/tui/reverse-rpc/approval/adapter';

describe('approval adapter', () => {
  it('adapts generic command displays into shell blocks with approval choices', () => {
    const adapted = adaptApprovalRequest(
      {
        toolCallId: 'tc-1',
        toolName: 'EnterPlanMode',
        action: 'run',
        display: {
          kind: 'generic',
          summary: 'run',
          detail: {
            command: 'sudo rm -rf /tmp/cache',
            cwd: '/tmp',
          },
        },
      },
    );

    expect(adapted).toMatchObject({
      id: 'tc-1',
      tool_call_id: 'tc-1',
      tool_name: 'EnterPlanMode',
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

  it('does not cry recursive delete for plain forced removals', () => {
    const dangerOf = (command: string) => {
      const adapted = adaptApprovalRequest({
        toolCallId: 'tc-rm',
        toolName: 'Bash',
        action: 'run',
        display: { kind: 'generic', summary: 'run', detail: { command } },
      });
      const block = adapted.display[0];
      return block?.type === 'shell' ? block.danger : undefined;
    };

    expect(dangerOf('rm -rf /tmp/cache')).toBe('recursive delete');
    expect(dangerOf('rm -fr /tmp/cache')).toBe('recursive delete');
    expect(dangerOf('rm -f -r /tmp/cache')).toBe('recursive delete');
    expect(dangerOf('rm -f --recursive /tmp/cache')).toBe('recursive delete');
    expect(dangerOf('rm --recursive /tmp/cache')).toBe('recursive delete');
    expect(dangerOf('rm -f /tmp/cache/file.txt')).toBe('force delete');
    expect(dangerOf('rm --force /tmp/cache/file.txt')).toBe('force delete');
    expect(dangerOf('rm /tmp/cache/file.txt')).toBeUndefined();
    expect(dangerOf('echo "rm -rf /tmp/cache"')).toBeUndefined();
    expect(dangerOf('sudo rm -f /tmp/cache/file.txt')).toBe('force delete');
  });

  it('emits only a diff block for Edit — no separate file_op title row', () => {
    const adapted = adaptApprovalRequest(
      {
        toolCallId: 'tc-edit',
        toolName: 'Edit',
        action: 'edit',
        display: {
          kind: 'generic',
          summary: 'edit',
          detail: {
            file_path: 'src/foo.ts',
            old_string: 'a\nb\nc',
            new_string: 'a\nB\nc',
          },
        },
      },
    );

    expect(adapted.display).toEqual([
      { type: 'diff', path: 'src/foo.ts', old_text: 'a\nb\nc', new_text: 'a\nB\nc' },
    ]);
  });

  it('emits a file_content block for Write so the new file previews as code, not diff', () => {
    const adapted = adaptApprovalRequest(
      {
        toolCallId: 'tc-write',
        toolName: 'Write',
        action: 'write',
        display: {
          kind: 'generic',
          summary: 'write',
          detail: {
            file_path: 'src/new.ts',
            content: 'export const x = 1;\nexport const y = 2;',
          },
        },
      },
    );

    expect(adapted.display).toEqual([
      {
        type: 'file_content',
        path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
    ]);
  });

  it('emits a file_content block for file_io write with content', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-write-io',
      toolName: 'Write',
      action: 'Writing src/new.ts',
      display: {
        kind: 'file_io',
        operation: 'write',
        path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
    });

    expect(adapted.display).toEqual([
      {
        type: 'file_content',
        path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
    ]);
  });

  it('emits a diff block for file_io edit with before/after', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-edit-io',
      toolName: 'Edit',
      action: 'Editing src/foo.ts',
      display: {
        kind: 'file_io',
        operation: 'edit',
        path: 'src/foo.ts',
        before: 'a\nb\nc',
        after: 'a\nB\nc',
      },
    });

    expect(adapted.display).toEqual([
      { type: 'diff', path: 'src/foo.ts', old_text: 'a\nb\nc', new_text: 'a\nB\nc' },
    ]);
  });

  it('keeps a path-only file_op block for file_io without preview fields', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-read',
      toolName: 'Read',
      action: 'Reading src/foo.ts',
      display: {
        kind: 'file_io',
        operation: 'read',
        path: 'src/foo.ts',
      },
    });

    expect(adapted.display).toEqual([
      { type: 'file_op', operation: 'read', path: 'src/foo.ts', detail: undefined },
    ]);
  });

  it('omits plan review content from the approval panel while keeping Python-style choices', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-plan',
      toolName: 'ExitPlanMode',
      action: 'Review plan',
      display: {
        kind: 'plan_review',
        plan: '# Plan\n\n- Inspect\n- Change\n- Verify',
        path: '/tmp/kimi-plan.md',
      },
    });

    expect(adapted.display).toEqual([]);
    expect(adapted.choices).toEqual([
      { label: 'Approve', response: 'approved', selected_label: 'Approve' },
      { label: 'Reject', response: 'rejected', selected_label: 'Reject' },
      {
        label: 'Revise',
        response: 'rejected',
        selected_label: 'Revise',
        requires_feedback: true,
      },
    ]);
  });

  it('renders multi-option plan review choices ahead of reject controls', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-plan-options',
      toolName: 'ExitPlanMode',
      action: 'Review plan and choose an option',
      display: {
        kind: 'plan_review',
        plan: '# Plan',
        path: '/tmp/kimi-plan.md',
        options: [
          { label: 'Approach A', description: 'Small refactor' },
          { label: 'Approach B', description: 'Full refactor' },
        ],
      },
    });

    expect(adapted.choices).toEqual([
      {
        label: 'Approach A',
        response: 'approved',
        selected_label: 'Approach A',
        description: 'Small refactor',
      },
      {
        label: 'Approach B',
        response: 'approved',
        selected_label: 'Approach B',
        description: 'Full refactor',
      },
      { label: 'Reject', response: 'rejected', selected_label: 'Reject' },
      {
        label: 'Revise',
        response: 'rejected',
        selected_label: 'Revise',
        requires_feedback: true,
      },
    ]);
  });

  it('renders the /goal start menu for a CreateGoal approval in manual mode', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-goal',
      toolName: 'CreateGoal',
      action: 'Creating a goal',
      display: {
        kind: 'goal_start',
        objective: 'Fix the failing auth tests',
        completionCriterion: 'npm test -- auth exits 0',
        mode: 'manual',
      },
    });

    expect(adapted.display).toEqual([
      {
        type: 'brief',
        text: 'Start goal: Fix the failing auth tests\nDone when: npm test -- auth exits 0',
      },
    ]);
    expect(adapted.choices).toEqual([
      {
        label: 'Switch to Never Ask and start',
        response: 'approved',
        selected_label: 'auto',
        description:
          'Best if you want Kimi Code to keep working while you are away. Tools are approved automatically and questions are skipped; only plans in Plan mode wait for your review.',
      },
      {
        label: 'Switch to Ask When Needed and start',
        response: 'approved',
        selected_label: 'yolo',
        description:
          'Tools are approved automatically. Kimi Code may still ask you questions.',
      },
      {
        label: 'Start in Always Ask',
        response: 'approved',
        selected_label: 'manual',
        description:
          'Keep approvals on. Kimi Code will ask before risky actions, so the goal may stop and wait for you.',
      },
      {
        label: 'Do not start',
        response: 'cancelled',
        selected_label: 'cancel',
        description: 'Return to the input box with your goal command.',
      },
    ]);
  });

  it('renders the yolo-mode /goal start menu for a CreateGoal approval', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-goal-yolo',
      toolName: 'CreateGoal',
      action: 'Creating a goal',
      display: {
        kind: 'goal_start',
        objective: 'Ship the feature',
        mode: 'yolo',
      },
    });

    expect(adapted.display).toEqual([{ type: 'brief', text: 'Start goal: Ship the feature' }]);
    expect(adapted.choices).toEqual([
      {
        label: 'Switch to Never Ask and start',
        response: 'approved',
        selected_label: 'auto',
        description:
          'Best if you want Kimi Code to keep working while you are away. Tools are approved automatically and questions are skipped; only plans in Plan mode wait for your review.',
      },
      {
        label: 'Keep Ask When Needed and start',
        response: 'approved',
        selected_label: 'yolo',
        description:
          'Tools stay approved automatically. Kimi Code may still ask you questions.',
      },
      {
        label: 'Do not start',
        response: 'cancelled',
        selected_label: 'cancel',
        description: 'Return to the input box with your goal command.',
      },
    ]);
  });

  it('maps approved-for-session responses into core approval payloads', () => {
    expect(
      adaptPanelResponse({
        response: 'approved_for_session',
        feedback: 'looks good',
        selected_label: 'Approve for this session',
      }),
    ).toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
      selectedLabel: 'Approve for this session',
    });
  });

  it('formats structured auto review detail into a leading review display block', () => {
    const denied = adaptApprovalRequest({
      toolCallId: 'tc-denied',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'command', command: 'terraform apply' },
      approvalDetail: {
        outcome: 'denied',
        risk: 'medium',
        reason: 'Creating remote resources was not explicitly authorized.',
      },
    });
    expect(denied.display[0]).toEqual({
      type: 'review',
      title: 'Auto Review: denied (medium risk)',
      detail: 'Creating remote resources was not explicitly authorized.',
    });

    const failed = adaptApprovalRequest({
      toolCallId: 'tc-failed',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'command', command: 'terraform apply' },
      approvalDetail: {
        outcome: 'failed',
        reason: 'The review context exceeded the model window.',
      },
    });
    expect(failed.display[0]).toEqual({
      type: 'review',
      title: 'Auto Review failed',
      detail: 'The review context exceeded the model window.',
    });
  });
});
