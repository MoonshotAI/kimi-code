import { CURSOR_MARKER } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import type {
  DiffDisplayBlock,
  FileContentDisplayBlock,
  PendingApproval,
} from '#/tui/reverse-rpc/types';
import { getColorPalette } from '#/tui/theme/colors';

import { captureProcessWrite } from '../../../helpers/process';

const COLORS = getColorPalette('dark');

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makePending(): PendingApproval {
  return {
    data: {
      id: 'approval_1',
      tool_call_id: 'tool_1',
      tool_name: 'WriteFile',
      action: 'write a file',
      description: 'Update README.md',
      display: [],
      choices: [
        { label: 'Approve once', response: 'approved' },
        { label: 'Approve for this session', response: 'approved_for_session' },
        { label: 'Reject', response: 'rejected' },
        { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
      ],
    },
  };
}

function makeDialog(): {
  dialog: ApprovalPanelComponent;
  responses: Array<{
    response: string;
    feedback?: string | undefined;
    selected_label?: string | undefined;
  }>;
} {
  const responses: Array<{
    response: string;
    feedback?: string | undefined;
    selected_label?: string | undefined;
  }> = [];
  const dialog = new ApprovalPanelComponent(
    makePending(),
    (response) => responses.push(response),
    COLORS,
  );
  return { dialog, responses };
}

describe('ApprovalPanelComponent', () => {
  it('renders only numeric approval shortcuts in the hint', () => {
    const { dialog } = makeDialog();
    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('1/2/3/4 choose');
    expect(out).not.toContain('y/a/n/f');
  });

  it('renders dangerous shell warnings with simple copy and no icon', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_danger',
        tool_call_id: 'tool_danger',
        tool_name: 'Bash',
        action: 'run',
        description: '',
        display: [
          {
            type: 'shell',
            language: 'bash',
            command: 'rm -rf /tmp/cache',
            danger: 'recursive delete',
          },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS);

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Dangerous: recursive delete');
    expect(out).not.toContain('potentially destructive');
    expect(out).not.toContain('⚠');
  });

  it('numeric shortcuts still drive approval actions', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('2');
    expect(responses).toEqual([{ response: 'approved_for_session', feedback: undefined }]);
  });

  it('shortcut 4 enters feedback mode and submits the typed feedback', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'no' }]);
  });

  it('renders feedback input inline with the selected choice', () => {
    const { dialog } = makeDialog();
    dialog.handleInput('4');

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('▶ 4. Reject with feedback');
    expect(out).not.toContain('\n  > ');
  });

  it('legacy y/a/n/f shortcuts no longer trigger approval actions', () => {
    for (const key of ['y', 'a', 'n', 'f']) {
      const { dialog, responses } = makeDialog();
      dialog.handleInput(key);
      expect(responses).toEqual([]);
    }
  });

  it('feedback input supports left/right cursor editing', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\u001B[D');
    dialog.handleInput('!');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'n!o' }]);
  });

  it('feedback input keeps editor shortcuts like ctrl+b / ctrl+f', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('a');
    dialog.handleInput('b');
    dialog.handleInput('c');
    dialog.handleInput('\u0002');
    dialog.handleInput('\u0002');
    dialog.handleInput('X');
    dialog.handleInput('\u0006');
    dialog.handleInput('Y');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'aXbYc' }]);
  });

  it('renders an IME cursor marker while editing feedback', () => {
    const { dialog } = makeDialog();
    dialog.focused = true;
    dialog.handleInput('4');

    const out = dialog.render(80).join('\n');
    expect(out).toContain(CURSOR_MARKER);
  });

  it.each(['\u0003', '\u0004', '\u001B'])(
    'shortcut %j rejects approval immediately',
    (key) => {
      const { dialog, responses } = makeDialog();
      dialog.handleInput(key);
      expect(responses).toEqual([{ response: 'rejected' }]);
    },
  );

  it('renders ExitPlanMode with plan-specific header and plan-review choices', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan',
        tool_call_id: 'tool_plan',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [
          { label: 'Approve', response: 'approved' },
          { label: 'Reject', response: 'rejected' },
          { label: 'Revise', response: 'rejected', requires_feedback: true },
        ],
      },
    };
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS);

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('Ready to build with this plan?');
    expect(out).not.toContain('Approve ExitPlanMode?');
    expect(out).toContain('Approve');
    expect(out).toContain('Reject');
    expect(out).toContain('Revise');
    expect(out).not.toContain('Approve for this session');
    expect(out).not.toContain('Investigate');
  });

  // Inline expand-in-place used to inflate the panel past the viewport on
  // any non-trivial Edit, which then collided with pi-tui's inline scroll
  // and made the terminal flicker / refuse to scroll. The panel now always
  // renders the diff in its compact cluster form; ctrl+e instead asks the
  // host to open a dedicated full-screen preview that can manage its own
  // scrolling.
  it('renders an Edit diff in compact form and asks the host to open a preview on ctrl+e', () => {
    const responses: Array<{ response: string }> = [];
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      oldLines.push(`old${String(i)}`);
      newLines.push(`new${String(i)}`);
    }
    const diffBlock: DiffDisplayBlock = {
      type: 'diff',
      path: 'src/foo.ts',
      old_text: oldLines.join('\n'),
      new_text: newLines.join('\n'),
    };
    const pending: PendingApproval = {
      data: {
        id: 'approval_diff',
        tool_call_id: 'tool_diff',
        tool_name: 'Edit',
        action: 'edit',
        description: '',
        display: [diffBlock],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    let toolOutputToggles = 0;
    let planToggles = 0;
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = new ApprovalPanelComponent(
      pending,
      (r) => responses.push(r),
      COLORS,
      () => toolOutputToggles++,
      () => planToggles++,
      (block) => previewCalls.push(block),
    );

    const before = strip(dialog.render(120).join('\n'));
    expect(before).toContain('+30');
    expect(before).toContain('-30');
    expect(before).toContain('ctrl+e preview');
    expect(before).not.toContain('new30'); // compact view stays compact

    dialog.handleInput('\u0005'); // Ctrl+E

    // The panel itself does not expand; it delegates to the host.
    const after = strip(dialog.render(120).join('\n'));
    expect(after).not.toContain('new30');
    expect(after).toContain('ctrl+e preview');
    expect(previewCalls).toEqual([diffBlock]);
    // The unrelated forward-only callbacks must not fire for ctrl+e.
    expect(planToggles).toBe(0);
    expect(toolOutputToggles).toBe(0);
    expect(responses).toEqual([]);
  });

  it('forwards ctrl+o to the global tool-output toggle without affecting the panel', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_forward',
        tool_call_id: 'tool_forward',
        tool_name: 'Edit',
        action: 'edit',
        description: '',
        display: [
          {
            type: 'diff',
            path: 'src/foo.ts',
            old_text: Array.from({ length: 30 }, (_, i) => `old${String(i + 1)}`).join('\n'),
            new_text: Array.from({ length: 30 }, (_, i) => `new${String(i + 1)}`).join('\n'),
          },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    let globalToggleCalls = 0;
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS, () => globalToggleCalls++);

    dialog.handleInput('\u000F'); // Ctrl+O

    const after = strip(dialog.render(120).join('\n'));
    expect(globalToggleCalls).toBe(1);
    expect(after).toContain('ctrl+e preview');
    expect(after).not.toContain('new30');
  });

  // When there is no diff / file_content block to preview (e.g. plan_review
  // with an empty display), ctrl+e falls through to the legacy global plan
  // expand toggle so plan mode keeps working.
  it('falls through to onTogglePlanExpand when there is nothing to preview', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan_only',
        tool_call_id: 'tool_plan_only',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [{ label: 'Approve', response: 'approved' }],
      },
    };
    let planToggles = 0;
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = new ApprovalPanelComponent(
      pending,
      () => {},
      COLORS,
      undefined,
      () => planToggles++,
      (block) => previewCalls.push(block),
    );

    dialog.handleInput('\u0005'); // Ctrl+E
    expect(planToggles).toBe(1);
    expect(previewCalls).toEqual([]);
  });

  it('renders Write as a syntax-highlighted code block (file_content), not a diff', () => {
    const responses: Array<{ response: string }> = [];
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`const x${String(i)} = ${String(i)};`);
    const contentBlock: FileContentDisplayBlock = {
      type: 'file_content',
      path: 'src/new.ts',
      content: lines.join('\n'),
    };
    const pending: PendingApproval = {
      data: {
        id: 'approval_write',
        tool_call_id: 'tool_write',
        tool_name: 'Write',
        action: 'write',
        description: '',
        display: [contentBlock],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = new ApprovalPanelComponent(
      pending,
      (r) => responses.push(r),
      COLORS,
      undefined,
      undefined,
      (block) => previewCalls.push(block),
    );

    const collapsed = strip(dialog.render(120).join('\n'));
    // No diff markers, no +N -M header.
    expect(collapsed).not.toMatch(/^\s*\+\d+/m);
    expect(collapsed).not.toMatch(/^\s*-\d+/m);
    expect(collapsed).toContain('src/new.ts');
    expect(collapsed).toContain('const x1 = 1;');
    expect(collapsed).toContain('const x10 = 10;');
    expect(collapsed).not.toContain('const x25 = 25;');
    expect(collapsed).toContain('20 more lines hidden (ctrl+e to preview)');
    expect(collapsed).toContain('ctrl+e preview');

    dialog.handleInput('\u0005'); // Ctrl+E hands off to the host preview.
    const after = strip(dialog.render(120).join('\n'));
    // The panel itself stays compact; the full content is opened elsewhere.
    expect(after).not.toContain('const x30 = 30;');
    expect(previewCalls).toEqual([contentBlock]);
    expect(responses).toEqual([]);
  });

  it('renders unknown file_content extensions as plain text without stderr noise', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_unknown_write',
        tool_call_id: 'tool_unknown_write',
        tool_name: 'Write',
        action: 'write',
        description: '',
        display: [{ type: 'file_content', path: 'demo.abcxyz', content: 'hello\nworld' }],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const stderr = captureProcessWrite('stderr');
    try {
      const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
      const dialog = new ApprovalPanelComponent(
        pending,
        () => {},
        COLORS,
        undefined,
        undefined,
        (block) => previewCalls.push(block),
      );
      const collapsed = strip(dialog.render(120).join('\n'));
      expect(collapsed).toContain('hello');

      dialog.handleInput('\u0005'); // Ctrl+E
      expect(previewCalls).toHaveLength(1);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  it('returns feedback for plan-review revise choice', () => {
    const responses: Array<{
      response: string;
      feedback?: string | undefined;
      selected_label?: string | undefined;
    }> = [];
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan',
        tool_call_id: 'tool_plan',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [
          { label: 'Approve', response: 'approved' },
          {
            label: 'Revise',
            response: 'rejected',
            selected_label: 'Revise',
            requires_feedback: true,
          },
        ],
      },
    };
    const dialog = new ApprovalPanelComponent(
      pending,
      (response) => responses.push(response),
      COLORS,
    );

    dialog.handleInput('2');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\r');
    expect(responses).toEqual([
      { response: 'rejected', feedback: 'no', selected_label: 'Revise' },
    ]);
  });
});
