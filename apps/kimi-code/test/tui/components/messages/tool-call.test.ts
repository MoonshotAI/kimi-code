import { visibleWidth, type TUI } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';

import { captureProcessWrite } from '../../../helpers/process';

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function strip(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
}

function stubTui(rows: number): TUI {
  return {
    terminal: { rows },
    requestRender: () => {},
  } as unknown as TUI;
}

describe('ToolCallComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the shared non-emoji tool status bullet', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_read_marker',
        name: 'Read',
        args: { path: 'foo.ts' },
      },
      {
        tool_call_id: 'call_read_marker',
        output: 'content',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain(`${STATUS_BULLET}Used Read`);
    expect(out).not.toContain(`\u23FA Used Read`);
    expect(out).not.toContain(`${String.fromCodePoint(0x23fa, 0xfe0e)} Used Read`);
  });

  describe('detach hint for long-running foreground Bash/Agent', () => {
    it('shows the Ctrl+B hint after 10s for a running Bash call', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_bash_long', name: 'Bash', args: { command: 'sleep 30' } },
        undefined,
        stubTui(30),
      );

      expect(strip(component.render(100).join('\n'))).not.toContain(
        'Press Ctrl+B to run in background',
      );

      vi.advanceTimersByTime(10_000);
      expect(strip(component.render(100).join('\n'))).toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });

    it('shows the hint immediately for a running Agent call', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_agent_long', name: 'Agent', args: { description: 'explore' } },
        undefined,
        stubTui(30),
      );

      // No timer advancement — Agents advertise Ctrl+B immediately.
      expect(strip(component.render(100).join('\n'))).toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });

    it('does not show the hint for non-detachable tools', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_read_long', name: 'Read', args: { path: 'foo.ts' } },
        undefined,
        stubTui(30),
      );

      vi.advanceTimersByTime(15_000);
      expect(strip(component.render(100).join('\n'))).not.toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });

    it('does not show the hint when the result lands before 10s', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_bash_short', name: 'Bash', args: { command: 'echo hi' } },
        undefined,
        stubTui(30),
      );

      vi.advanceTimersByTime(5_000);
      component.setResult({ tool_call_id: 'call_bash_short', output: 'hi', is_error: false });
      vi.advanceTimersByTime(10_000);

      expect(strip(component.render(100).join('\n'))).not.toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });
  });

  it('keeps collapsed tool-call lines within very narrow widths', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_narrow_read',
        name: 'Read',
        args: { path: 'very/long/path/to/foo.ts' },
      },
      {
        tool_call_id: 'call_narrow_read',
        output: 'content',
        is_error: false,
      },
    );

    for (const width of [1, 2, 4, 10, 39]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('keeps collapsed tool results short and expands on demand', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      {
        tool_call_id: 'call_shell',
        output: ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
        is_error: false,
      },
    );

    const collapsed = strip(component.render(100).join('\n'));
    expect(collapsed).toContain('line1');
    expect(collapsed).toContain('line2');
    expect(collapsed).toContain('line3');
    expect(collapsed).not.toContain('line4');
    expect(collapsed).toContain('... (2 more lines, ctrl+o to expand)');

    component.setExpanded(true);

    const expanded = strip(component.render(100).join('\n'));
    expect(expanded).toContain('line4');
    expect(expanded).toContain('line5');
    expect(expanded).not.toContain('ctrl+o to expand');
  });

  it('renders live Bash output while the command is running', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell_live',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      undefined,
    );

    component.appendLiveOutput('line1\n');
    component.appendLiveOutput('line2\n');

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Running a command');
    expect(out).toContain('line1');
    expect(out).toContain('line2');
  });

  it('clears live Bash output when the final result arrives', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell_live_done',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      undefined,
    );

    component.appendLiveOutput('streamed-only\n');
    component.setResult({
      tool_call_id: 'call_shell_live_done',
      output: 'final-only\n',
      is_error: false,
    });

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Ran a command');
    expect(out).toContain('final-only');
    expect(out).not.toContain('streamed-only');
  });

  describe('Bash command preview', () => {
    const longCommand = Array.from({ length: 15 }, (_, i) => `echo step${String(i + 1)}`).join(
      '\n',
    );

    it('shows the truncated command while running and reveals the rest when expanded', () => {
      const component = new ToolCallComponent(
        { id: 'call_bash_running', name: 'Bash', args: { command: longCommand } },
        undefined,
      );

      const collapsed = strip(component.render(100).join('\n'));
      expect(collapsed).toContain('Running a command');
      expect(collapsed).toContain('echo step1');
      expect(collapsed).toContain('echo step10');
      expect(collapsed).not.toContain('echo step11');

      component.setExpanded(true);

      const expanded = strip(component.render(100).join('\n'));
      expect(expanded).toContain('echo step11');
      expect(expanded).toContain('echo step15');
    });

    it('keeps the command preview after the result lands to avoid a height collapse', () => {
      const component = new ToolCallComponent(
        { id: 'call_bash_done', name: 'Bash', args: { command: longCommand } },
        undefined,
      );

      // Sanity: while running, the in-flight preview shows the command.
      expect(strip(component.render(100).join('\n'))).toContain('$ echo step1');

      component.setResult({ tool_call_id: 'call_bash_done', output: 'done', is_error: false });

      // Collapsed result view still shows the command preview (capped at
      // COMMAND_PREVIEW_LINES) so a multi-line command with short output does
      // not collapse the card. The command is owned by buildCallPreview, so it
      // must appear exactly once — the result renderer no longer renders it.
      const out = strip(component.render(100).join('\n'));
      expect(out).toContain('Ran a command');
      expect(out).toContain('$ echo step1');
      expect(out).toContain('echo step10');
      expect(out).not.toContain('echo step11');
      expect(out).toContain('done');
      expect(out.split('$ echo step1').length - 1).toBe(1);

      component.setExpanded(true);
      const expanded = strip(component.render(100).join('\n'));
      expect(expanded).toContain('echo step11');
      expect(expanded).toContain('echo step15');
    });

    it('keeps the command preview when the command produces no output', () => {
      const component = new ToolCallComponent(
        { id: 'call_bash_empty', name: 'Bash', args: { command: 'mkdir -p a/b/c\necho done' } },
        { tool_call_id: 'call_bash_empty', output: '', is_error: false },
      );

      // buildContent early-returns on empty output, but the command preview
      // (owned by buildCallPreview) must still render so the card does not
      // collapse to just the header.
      const out = strip(component.render(100).join('\n'));
      expect(out).toContain('Ran a command');
      expect(out).toContain('$ mkdir -p a/b/c');
      expect(out).toContain('echo done');
    });
  });

  it('hides tool output bodies that start with a <system-reminder tag', () => {
    const reminderOutput =
      '<system-reminder>\nThe task tools have not been used recently.\n</system-reminder>';
    const component = new ToolCallComponent(
      {
        id: 'call_hidden',
        name: 'Bash',
        args: { command: 'echo hi' },
      },
      {
        tool_call_id: 'call_hidden',
        output: reminderOutput,
        is_error: false,
      },
    );

    const collapsed = strip(component.render(100).join('\n'));
    expect(collapsed).toContain(`${STATUS_BULLET}Ran a command`);
    expect(collapsed).not.toContain('system-reminder');
    expect(collapsed).not.toContain('task tools');

    component.setExpanded(true);
    const expanded = strip(component.render(100).join('\n'));
    expect(expanded).not.toContain('system-reminder');
    expect(expanded).not.toContain('task tools');
  });

  it('hides <system-reminder-prefixed output even when the tool result is an error', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_hidden_err',
        name: 'Bash',
        args: { command: 'false' },
      },
      {
        tool_call_id: 'call_hidden_err',
        output: '<system-reminder>do not show</system-reminder>',
        is_error: true,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).not.toContain('system-reminder');
    expect(out).not.toContain('do not show');
  });

  it('renders output that merely starts with a literal <system> tag', () => {
    // Tool metadata no longer travels inside `output` (it rides the result's
    // `note` side channel), so real output starting with the literal tag —
    // a file that contains it, an MCP tool's text — must stay visible.
    const component = new ToolCallComponent(
      {
        id: 'call_literal',
        name: 'Bash',
        args: { command: 'cat notes.txt' },
      },
      {
        tool_call_id: 'call_literal',
        output: '<system>literal text from a user file</system>\nsecond line',
        is_error: false,
      },
    );

    component.setExpanded(true);
    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('<system>literal text from a user file</system>');
    expect(out).toContain('second line');
  });

  it('renders AgentSwarm results as a one-line summary without raw XML', () => {
    const output = [
      '<agent_swarm_result>',
      '<summary>completed: 1, failed: 1, aborted: 1</summary>',
      '<subagent index="1" outcome="completed">Reviewed src/a.ts.</subagent>',
      '<subagent index="2" outcome="failed">Agent timed out.</subagent>',
      '<subagent index="3" outcome="aborted">User aborted.</subagent>',
      '</agent_swarm_result>',
    ].join('\n');
    const component = new ToolCallComponent(
      {
        id: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        },
      },
      {
        tool_call_id: 'call_swarm',
        output,
        is_error: false,
      },
    );

    const out = strip(component.render(120).join('\n'));

    expect(out).toContain('Agent swarm: ✓ 1 completed · ✗ 1 failed · ⊘ 1 aborted');
    expect(out).not.toContain('<agent_swarm_result>');
    expect(out).not.toContain('Reviewed src/a.ts.');
    expect(out).not.toContain('Agent timed out.');
  });

  it('renders an AgentSwarm fallback summary when the result is not structured', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_swarm_failed',
        name: 'AgentSwarm',
        args: { description: 'Review changed files' },
      },
      {
        tool_call_id: 'call_swarm_failed',
        output: 'provider request failed',
        is_error: true,
      },
    );

    const out = strip(component.render(120).join('\n'));

    expect(out).toContain('Agent swarm: ✗ Failed.');
    expect(out).not.toContain('provider request failed');
  });

  it('still renders tool output when the body merely contains <system later on', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_inline',
        name: 'Bash',
        args: { command: 'echo hi' },
      },
      {
        tool_call_id: 'call_inline',
        output: 'first line\n<system-reminder>nope</system-reminder>',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('first line');
  });

  it('renders ExitPlanMode plan from result output when args.plan is absent', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit',
        output:
          'Exited plan mode. Plan mode deactivated. All tools are now available.\n' +
          'Plan saved to: /tmp/plan.md\n\n' +
          '## Approved Plan:\n# File Plan\n\n1. Do the focused fix.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Current plan');
    expect(out).toContain('File Plan');
    expect(out).toContain('1. Do the focused fix.');
    expect(out).not.toContain('Plan saved to: /tmp/plan.md');
  });

  it('setPlanInfo injects plan body when args.plan is empty (plan-file mode)', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_async',
        name: 'ExitPlanMode',
        args: {},
      },
      undefined,
      undefined,
    );

    // A fresh tool card only shows the 'Current plan' title; no plan box renders yet.
    const before = strip(component.render(100).join('\n'));
    expect(before).toContain('Current plan');
    expect(before).not.toContain('Refactor session');

    component.setPlanInfo({ plan: '# Refactor session\n\n- step', path: '/tmp/refactor.md' });

    const after = strip(component.render(100).join('\n'));
    expect(after).toContain('Refactor session');
    expect(after).toContain('plan:');
    expect(after).toContain('refactor.md');
    // Directory portion of the path must not leak into the visible header.
    expect(after).not.toContain('/tmp/refactor.md');
  });

  it('renders the full plan preview', () => {
    const longPlan = `# Refactor session\n\n${Array.from({ length: 40 }, (_, i) => `- step ${String(i + 1)}`).join('\n')}`;
    const component = new ToolCallComponent(
      {
        id: 'call_exit_long',
        name: 'ExitPlanMode',
        args: { plan: longPlan },
      },
      undefined,
      stubTui(24),
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('step 1');
    expect(out).toContain('step 40');
    expect(out).not.toContain('more lines');
  });

  it('plan preview controls are no-ops for non-ExitPlanMode tool calls', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_bash_plan',
        name: 'Bash',
        args: { command: 'echo hi' },
      },
      undefined,
      undefined,
    );

    component.setPlanInfo({ plan: 'should be ignored', path: '/etc/hosts' });

    const out = strip(component.render(100).join('\n'));
    expect(out).not.toContain('should be ignored');
    expect(out).not.toContain('plan:');
  });

  it('ctrl+o does not affect the full plan preview', () => {
    const longPlan = `# P\n\n${Array.from({ length: 40 }, (_, i) => `- step ${String(i + 1)}`).join('\n')}`;
    const component = new ToolCallComponent(
      {
        id: 'call_exit_isolation',
        name: 'ExitPlanMode',
        args: { plan: longPlan },
      },
      undefined,
      stubTui(24),
    );
    component.setExpanded(true);
    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('step 40');
    expect(out).not.toContain('more lines');
  });

  it('header chips an Approved status when ExitPlanMode result indicates approval', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_approved',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit_approved',
        output:
          'Exited plan mode. Plan mode deactivated. All tools are now available.\n' +
          'Plan saved to: /tmp/plan.md\n\n' +
          '## Approved Plan:\n# Plan body',
        is_error: false,
      },
    );

    const header = strip(component.render(100).join('\n')).split('\n')[1] ?? '';
    expect(header).toMatch(/Current plan · Approved\s*$/);
  });

  it('header chips approved option label when the user picked one', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_chosen',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit_chosen',
        output:
          'Exited plan mode. Selected approach: Pragmatic refactor\n' +
          'Execute ONLY the selected approach. Do not execute any unselected alternatives.\n\n' +
          'Plan mode deactivated. All tools are now available.\n' +
          'Plan saved to: /tmp/plan.md\n\n' +
          '## Approved Plan:\n# body',
        is_error: false,
      },
    );

    const header = strip(component.render(100).join('\n')).split('\n')[1] ?? '';
    expect(header).toContain('Current plan · Approved: Pragmatic refactor');
  });

  it('header chips Auto-approved when ExitPlanMode was auto-approved without user review', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_auto',
        name: 'ExitPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_exit_auto',
        output:
          'Exited plan mode. Plan mode deactivated. All tools are now available.\n' +
          'Note: this plan was auto-approved without user review — the user has NOT explicitly approved it.\n' +
          'Plan saved to: /tmp/plan.md\n\n' +
          '## Plan (auto-approved, not user-reviewed):\n# Auto Plan\n\n1. Do the thing.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    const header = out.split('\n')[1] ?? '';
    expect(header).toMatch(/Current plan · Auto-approved\s*$/);
    // The plan body renders from the auto-approved marker; the engine-side
    // note above the marker must not leak into the rendered plan box.
    expect(out).toContain('Auto Plan');
    expect(out).toContain('1. Do the thing.');
    expect(out).not.toContain('Note: this plan was auto-approved');
  });

  it('renders Rejected in the plan box title and keeps revise feedback visible', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_reject_fb',
        name: 'ExitPlanMode',
        args: { plan: '# Rework Plan\n\n- step 1' },
      },
      {
        tool_call_id: 'call_exit_reject_fb',
        output: 'User rejected the plan. Feedback:\n\nplease rethink step 2',
        is_error: false,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('plan · Rejected');
    expect(out).toContain('↪ Suggestion');
    expect(out).toContain('please rethink step 2');
  });

  it('renders is_error ExitPlanMode reject in the plan box title without raw error text', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_exit_reject',
        name: 'ExitPlanMode',
        args: { plan: '# Rejected Plan\n\n- keep investigating' },
      },
      {
        tool_call_id: 'call_exit_reject',
        output: 'Plan rejected by user. Plan mode remains active.',
        is_error: true,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('plan · Rejected');
    expect(out).toContain('Rejected Plan');
    expect(out).not.toContain('Plan rejected by user.');
    expect(out).not.toContain('Plan mode remains active.');
  });

  it('suppresses EnterPlanMode success body so prompt scaffolding does not leak into the transcript', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_enter',
        name: 'EnterPlanMode',
        args: { reason: 'plan a refactor' },
      },
      {
        tool_call_id: 'call_enter',
        output:
          'Plan mode is now active. Your workflow:\n\n' +
          'Plan file: /tmp/plan.md\n\n' +
          '1. Use read-only tools (Read, Grep, Glob) to investigate the codebase.\n' +
          '2. Design a concrete, step-by-step plan.\n' +
          '3. Write the plan to the plan file with Write or Edit.\n' +
          '4. When the plan is ready, call ExitPlanMode for user approval.\n\n' +
          'Do NOT edit files other than the plan file while plan mode is active.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Used EnterPlanMode');
    expect(out).not.toContain('Plan mode is now active');
    expect(out).not.toContain('Plan file:');
    expect(out).not.toContain('read-only tools');
  });

  it('still surfaces EnterPlanMode error output', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_enter_err',
        name: 'EnterPlanMode',
        args: {},
      },
      {
        tool_call_id: 'call_enter_err',
        output: 'Plan mode is already active. Use ExitPlanMode when the plan is ready.',
        is_error: true,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Plan mode is already active');
  });

  it('renders AskUserQuestion with a friendly header instead of the raw tool name', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_question',
        name: 'AskUserQuestion',
        args: {},
      },
      {
        tool_call_id: 'call_question',
        output: JSON.stringify({
          answers: {
            'Favorite editor?': 'Vim',
          },
        }),
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Collected your answers');
    expect(out).toContain('Favorite editor?');
    expect(out).toContain('Vim');
    expect(out).not.toContain('AskUserQuestion');
  });

  it('renders background AskUserQuestion as a started task', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_background_question',
        name: 'AskUserQuestion',
        args: { background: true },
      },
      {
        tool_call_id: 'call_background_question',
        output: [
          'task_id: question-aaaaaaaa',
          'description: Which database?',
          'status: running',
        ].join('\n'),
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Started background question');
    expect(out).toContain('question-aaaaaaaa');
    expect(out).not.toContain('Collected your answers');
  });

  it('renders GetGoal as a goal check without raw JSON', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_get_goal',
        name: 'GetGoal',
        args: {},
      },
      {
        tool_call_id: 'call_get_goal',
        output: JSON.stringify({
          goal: {
            goalId: 'g1',
            objective: 'Ship feature X',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            startedBy: 'model',
            updatedBy: 'model',
            turnsUsed: 1,
            tokensUsed: 800,
            wallClockMs: 5000,
            budget: {
              tokenBudget: null,
              turnBudget: null,
              wallClockBudgetMs: null,
              remainingTokens: null,
              remainingTurns: null,
              remainingWallClockMs: null,
              tokenBudgetReached: false,
              turnBudgetReached: false,
              wallClockBudgetReached: false,
              overBudget: false,
            },
          },
        }),
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Checked goal');
    expect(out).toContain('Goal active: Ship feature X');
    expect(out).not.toContain('Used GetGoal');
    expect(out).not.toContain('"objective"');
  });

  it('renders SetGoalBudget with a readable budget argument', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_goal_budget',
        name: 'SetGoalBudget',
        args: { value: 10, unit: 'turns' },
      },
      {
        tool_call_id: 'call_goal_budget',
        output: 'Goal budget set: 10 turns.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Set goal budget (10 turns)');
    expect(out).not.toContain('Set goal budget (10 turns) · 10 turns');
    expect(out).not.toContain('Used SetGoalBudget (turns)');
    expect(out).not.toContain('Goal budget set: 10 turns.');
  });

  it('renders successful SetGoalBudget headers with the primary goal marker', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_goal_budget',
          name: 'SetGoalBudget',
          args: { value: 10, unit: 'turns' },
        },
        {
          tool_call_id: 'call_goal_budget',
          output: 'Goal budget set: 10 turns.',
          is_error: false,
        },
      );

      const out = component.render(100).join('\n');
      expect(out).toContain(chalk.hex(darkColors.primary)(STATUS_BULLET));
      expect(out).not.toContain(chalk.hex(darkColors.success)(STATUS_BULLET));
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('renders UpdateGoal as a model-reported status, not a user lifecycle marker', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_update_goal',
        name: 'UpdateGoal',
        args: { status: 'blocked' },
      },
      {
        tool_call_id: 'call_update_goal',
        output: 'Goal marked blocked.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Reported goal blocked');
    expect(out).not.toContain('Updated goal (blocked)');
    expect(out).not.toContain('· blocked');
    expect(out).not.toContain('Goal marked blocked.');
    expect(out).not.toContain('● Goal blocked');
  });

  it('renders successful UpdateGoal report headers entirely in the primary goal color', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      for (const status of ['complete', 'blocked']) {
        const component = new ToolCallComponent(
          {
            id: `call_update_goal_${status}`,
            name: 'UpdateGoal',
            args: { status },
          },
          {
            tool_call_id: `call_update_goal_${status}`,
            output: `Goal marked ${status}.`,
            is_error: false,
          },
        );

        const out = component.render(100).join('\n');
        expect(out).toContain(chalk.hex(darkColors.primary)(STATUS_BULLET));
        expect(out).not.toContain(chalk.hex(darkColors.success)(STATUS_BULLET));
      }
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('appends a chip to the header once a result arrives', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_read',
        name: 'Read',
        args: { path: 'foo.ts' },
      },
      {
        tool_call_id: 'call_read',
        output: '1\tfoo\n2\tbar\n3\tbaz',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Used Read');
    expect(out).toContain('· 3 lines');
  });

  it('truncates a long file path from the head so the filename stays visible', () => {
    const longPath =
      'apps/kimi-code/src/tui/components/messages/tool-renderers/long-path/example/final-file.ts';
    const component = new ToolCallComponent(
      {
        id: 'call_long_path',
        name: 'Read',
        args: { path: longPath },
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('final-file.ts');
    expect(out).toContain('…');
    expect(out).not.toContain('apps/kimi-code/src/tui/components/messages/tool-renderers/long-pa…');
  });

  it('shows Read paths relative to the active workspace', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_workspace_read',
        name: 'Read',
        args: { path: '/tmp/proj-a/apps/kimi-code/src/main.ts' },
      },
      {
        tool_call_id: 'call_workspace_read',
        output: '1\tcontent',
        is_error: false,
      },
      undefined,
      '/tmp/proj-a',
    );

    const out = strip(component.render(100).join('\n'));
    const expectedReadPath =
      process.platform === 'win32' ? 'apps\\kimi-code\\src\\main.ts' : 'apps/kimi-code/src/main.ts';
    expect(out).toContain(`Used Read (${expectedReadPath})`);
    expect(out).not.toContain('/tmp/proj-a/apps');
    expect(component.getReadSnapshot().filePath).toBe(expectedReadPath);
  });

  it('keeps Read paths outside the active workspace absolute', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_external_read',
        name: 'Read',
        args: { path: '/tmp/proj-ab/src/main.ts' },
      },
      undefined,
      undefined,
      '/tmp/proj-a',
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Read (/tmp/proj-ab/src/main.ts)');
    expect(component.getReadSnapshot().filePath).toBe('/tmp/proj-ab/src/main.ts');
  });

  it('does not append a chip while a tool is still running', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_pending',
        name: 'Read',
        args: { path: 'foo.ts' },
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Read');
    expect(out).not.toContain('lines');
  });

  it('renders a single foreground subagent without the generic Agent tool header', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const component = new ToolCallComponent(
      {
        id: 'call_agent',
        name: 'Agent',
        args: { description: 'explore project xxx' },
      },
      undefined,
    );

    component.onSubagentSpawned({
      agentId: 'sub_explore_123456',
      agentName: 'explore',
      runInBackground: false,
    });

    let out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Queued (explore project xxx) · 0 tools · 0s');
    expect(out).not.toContain('Using Agent');
    expect(out).not.toContain('Used Agent');

    vi.setSystemTime(20_000);
    component.appendSubagentText('think1\nthink2\nthink3', 'thinking');
    component.appendSubagentText('answer1\nanswer2\nanswer3', 'text');
    component.appendSubToolCall({
      id: 'sub_explore_123456:read',
      name: 'Read',
      args: { path: 'apps/kimi-code/src/tui/utils/background-agent-status.ts' },
    });

    out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Running (explore project xxx) · 1 tool · 10s');
    expect(out).toContain('Using Read (apps/kimi-code/src/tui/utils/background-agent-status.ts)');
    // Thinking and text are mutually exclusive in the active window: the most
    // recently streamed (text) wins, so thinking is hidden entirely.
    expect(out).not.toContain('think1');
    expect(out).not.toContain('think2');
    expect(out).not.toContain('think3');
    expect(out).not.toContain('answer1');
    expect(out).toContain('answer2');
    expect(out).toContain('answer3');
    expect(out).toContain('│ answer3');

    vi.setSystemTime(22_000);
    component.onSubagentCompleted({ resultSummary: 'summary fallback' });
    component.setResult({
      tool_call_id: 'call_agent',
      output: 'parent duplicate result',
      is_error: false,
    });
    vi.setSystemTime(30_000);

    out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Completed (explore project xxx) · 1 tool · 12s');
    expect(out).not.toContain('think3');
    expect(out).toContain('│ answer3');
    expect(out).not.toContain('Used Agent');
    expect(out).not.toContain('parent duplicate result');
    expect(out).not.toContain('summary fallback');
  });

  it('shows Backgrounded after a foreground subagent is detached, even after setResult', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_detach',
        name: 'Agent',
        args: { description: 'long task' },
      },
      undefined,
      stubTui(30),
    );
    component.onSubagentSpawned({
      agentId: 'sub_detach_1',
      agentName: 'explore',
      runInBackground: false,
    });
    component.onSubagentStarted({
      agentId: 'sub_detach_1',
      agentName: 'explore',
      runInBackground: false,
    });

    // Sanity: running before detach.
    expect(strip(component.render(120).join('\n'))).toContain('Running');

    component.markBackgrounded();
    let out = strip(component.render(120).join('\n'));
    expect(out).toContain('Backgrounded');
    expect(out).not.toContain('Completed');

    // The spawn-success ToolResult landing must NOT flip the card to Completed.
    component.setResult({
      tool_call_id: 'call_agent_detach',
      output: 'agent_id: sub_detach_1\nactual_subagent_type: explore\n',
      is_error: false,
    });
    out = strip(component.render(120).join('\n'));
    expect(out).toContain('Backgrounded');
    expect(out).not.toContain('Completed');

    component.dispose();
  });

  it('summarizes subagent tools as a count plus the current tool', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_tools',
        name: 'Agent',
        args: { description: 'inspect tools' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_tools',
      agentName: 'explore',
      runInBackground: false,
    });

    for (let i = 1; i <= 4; i++) {
      const id = `sub_tools:read-${String(i)}`;
      component.appendSubToolCall({ id, name: 'Read', args: { path: `file${String(i)}.ts` } });
      component.finishSubToolCall({ tool_call_id: id, output: 'ok', is_error: false });
    }
    component.appendSubToolCall({
      id: 'sub_tools:grep',
      name: 'Grep',
      args: { pattern: 'auth' },
    });

    const out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Running (inspect tools) · 5 tools · 0s');
    // Only the current (most recent ongoing) tool appears in the summary line.
    expect(out).toContain('Using Grep (auth)');
    // No per-tool activity rows are rendered.
    expect(out).not.toContain('file1.ts');
    expect(out).not.toContain('file2.ts');
    expect(out).not.toContain('file3.ts');
    expect(out).not.toContain('file4.ts');
    expect(out).not.toContain('Used Read');
  });

  it('keeps the subagent tool summary pinned to the most recent tool', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_stable_tools',
        name: 'Agent',
        args: { description: 'inspect tools' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_tools',
      agentName: 'explore',
      runInBackground: false,
    });

    for (let i = 1; i <= 5; i++) {
      component.appendSubToolCall({
        id: `sub_tools:read-${String(i)}`,
        name: 'Read',
        args: { path: `file${String(i)}.ts` },
      });
    }
    component.appendSubToolCallDelta({
      id: 'sub_tools:read-1',
      name: 'Read',
      argumentsPart: '{"path":"file1-updated.ts"}',
    });
    component.finishSubToolCall({
      tool_call_id: 'sub_tools:read-1',
      output: 'ok',
      is_error: false,
    });

    const out = strip(component.render(120).join('\n'));
    // The updated/finished older tool must not surface in the summary.
    expect(out).not.toContain('file1-updated.ts');
    expect(out).not.toContain('file2.ts');
    expect(out).not.toContain('file3.ts');
    expect(out).not.toContain('file4.ts');
    // Only the most recent ongoing tool is shown.
    expect(out).toContain('Using Read (file5.ts)');
  });

  it('wraps the single subagent active window with a hanging gutter', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_wrapped_text',
        name: 'Agent',
        args: { description: 'inspect wrapping' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_wrapped',
      agentName: 'explore',
      runInBackground: false,
    });
    component.appendSubagentText(
      'output words that should also wrap with a clean hanging indent',
      'text',
    );

    const joined = strip(component.render(34).join('\n'));
    // The two-row window drops the head of the wrapped paragraph.
    expect(joined).not.toContain('output words that should');
    // Every kept row carries the `│` gutter as a hanging indent.
    expect(joined).toContain('│ wrap with a clean hanging');
    expect(joined).toContain('│ indent');
  });

  it('scrolls single subagent thinking to the last two display rows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_scroll',
        name: 'Agent',
        args: { description: 'long think' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_scroll',
      agentName: 'explore',
      runInBackground: false,
    });
    // A single long logical line (no newlines) wraps to many display rows;
    // only the last THINKING_PREVIEW_LINES (2) should remain visible.
    const segs = Array.from({ length: 30 }, (_, i) => `seg${String(i).padStart(2, '0')}`);
    component.appendSubagentText(segs.join(' '), 'thinking');

    const lines = strip(component.render(40).join('\n')).split('\n');
    const thinkingRows = lines.filter((l) => /seg\d\d/.test(l));
    expect(thinkingRows.length).toBe(2);
    expect(lines.join('\n')).toContain('seg29');
    expect(lines.join('\n')).not.toContain('seg00');
  });

  it('shows a two-row tail of an ongoing subagent Bash output', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_bash_out',
        name: 'Agent',
        args: { description: 'run bash' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_bash',
      agentName: 'explore',
      runInBackground: false,
    });
    component.appendSubToolCall({
      id: 'sub_bash:cmd',
      name: 'Bash',
      args: { command: 'ls -la' },
    });
    const output = Array.from({ length: 10 }, (_, i) => `bash-line-${String(i)}`).join('\n');
    component.appendSubToolLiveOutput('sub_bash:cmd', output);

    let out = strip(component.render(120).join('\n'));
    expect(out).toContain('Using Bash (ls -la)');
    // The active window keeps only the last two rows of live output.
    expect(out).toContain('bash-line-8');
    expect(out).toContain('bash-line-9');
    expect(out).not.toContain('bash-line-7');
    // No ctrl+o promise for the subagent window.
    expect(out).not.toContain('ctrl+o');

    // The global ctrl+o expand toggle must NOT expand the window.
    component.setExpanded(true);
    out = strip(component.render(120).join('\n'));
    expect(out).toContain('bash-line-9');
    expect(out).not.toContain('bash-line-7');
  });

  it('shows live output for generic subagent tools but not for recognized ones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_mixed',
        name: 'Agent',
        args: { description: 'mixed tools' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_mixed',
      agentName: 'explore',
      runInBackground: false,
    });
    // A finished recognized tool: its output body never reaches the window.
    component.appendSubToolCall({
      id: 'sub_mixed:read',
      name: 'Read',
      args: { path: 'foo.ts' },
    });
    component.finishSubToolCall({
      tool_call_id: 'sub_mixed:read',
      output: 'recognized-read-body\nhidden-read-line',
      is_error: false,
    });
    // An ongoing generic (MCP) tool: its live output is the active stream.
    component.appendSubToolCall({
      id: 'sub_mixed:mcp',
      name: 'mcp__server__do',
      args: {},
    });
    const mcpOut = Array.from({ length: 5 }, (_, i) => `mcp-line-${String(i)}`).join('\n');
    component.appendSubToolLiveOutput('sub_mixed:mcp', mcpOut);

    const out = strip(component.render(120).join('\n'));
    // Recognized tool output never appears.
    expect(out).not.toContain('recognized-read-body');
    // Generic tool output shows as the two-row active window tail.
    expect(out).toContain('mcp-line-3');
    expect(out).toContain('mcp-line-4');
    expect(out).not.toContain('mcp-line-2');
    expect(out).not.toContain('ctrl+o');
  });

  it('renders failed single subagents with the dedicated header and error text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_failed',
        name: 'Agent',
        args: { description: 'check failure' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_failed',
      agentName: 'explore',
      runInBackground: false,
    });

    vi.setSystemTime(4000);
    component.onSubagentFailed({ error: 'subagent exceeded max_steps' });

    const out = strip(component.render(120).join('\n'));
    expect(out).toContain('Explore Agent Failed (check failure) · 0 tools · 3s');
    expect(out).toContain('│ subagent exceeded max_steps');
    expect(out).not.toContain('Using Agent');
    expect(out).not.toContain('Used Agent');
  });

  it('keeps the same card height between running and done', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const component = new ToolCallComponent(
      {
        id: 'call_agent_height',
        name: 'Agent',
        args: { description: 'height stable' },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: 'sub_height',
      agentName: 'explore',
      runInBackground: false,
    });
    component.appendSubToolCall({ id: 'sub_height:read', name: 'Read', args: { path: 'a.ts' } });
    component.appendSubagentText('short answer', 'text');

    const runningLines = strip(component.render(120).join('\n')).split('\n').length;

    component.onSubagentCompleted({ resultSummary: 'short answer' });
    component.setResult({ tool_call_id: 'call_agent_height', output: 'done', is_error: false });

    const doneLines = strip(component.render(120).join('\n')).split('\n').length;

    expect(doneLines).toBe(runningLines);
  });

  describe('background agent terminal state vs spawn-success ToolResult', () => {
    // The Agent tool returns a "task spawned" result the moment a
    // run_in_background=true call lands. That result is not an error and its
    // body says `status: running`, so for backgrounded agents `this.result`
    // alone cannot distinguish a successful completion from a failure / lost
    // task. The fix is `setBackgroundTaskTerminalStatus`, which overrides the
    // result-based derivation with the actual BackgroundTaskInfo status.
    const spawnSuccessResult = {
      tool_call_id: 'call_bg_agent',
      output: [
        'task_id: agent-deadbeef',
        'status: running',
        'agent_id: agent-0',
        'actual_subagent_type: coder',
        'automatic_notification: true',
      ].join('\n'),
      is_error: false,
    };

    function makeBackgroundAgentComponent(): ToolCallComponent {
      const component = new ToolCallComponent(
        {
          id: 'call_bg_agent',
          name: 'Agent',
          args: {
            description: 'background agent 1',
            run_in_background: true,
          },
        },
        spawnSuccessResult,
      );
      component.onSubagentSpawned({
        agentId: 'agent-0',
        agentName: 'coder',
        runInBackground: true,
      });
      return component;
    }

    it('reads as "done" by default after spawn — the existing behavior the fix replaces', () => {
      // This pins the legacy behavior. Without overrides the snapshot
      // trusts the spawn-success result and reports phase='done'. The
      // 'lost' / 'killed' / 'failed' overrides below must beat this.
      const component = makeBackgroundAgentComponent();
      expect(component.getSubagentSnapshot().phase).toBe('done');
    });

    it('setBackgroundTaskTerminalStatus("lost") flips the snapshot phase to "failed"', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('lost');
      const snap = component.getSubagentSnapshot();
      expect(snap.phase).toBe('failed');
      // The agent-group renderer uses snap.errorText for the "Error:" line.
      // The spawn-success ToolResult must NOT leak as the failure message.
      expect(snap.errorText).toContain('lost');
      expect(snap.errorText).not.toContain('task_id:');
    });

    it('setBackgroundTaskTerminalStatus("killed") flips the snapshot phase to "failed"', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('killed');
      const snap = component.getSubagentSnapshot();
      expect(snap.phase).toBe('failed');
      expect(snap.errorText).toContain('killed');
      expect(snap.errorText).not.toContain('task_id:');
    });

    it('setBackgroundTaskTerminalStatus("failed") flips the snapshot phase to "failed"', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('failed');
      const snap = component.getSubagentSnapshot();
      expect(snap.phase).toBe('failed');
      expect(snap.errorText).toContain('failed');
      expect(snap.errorText).not.toContain('task_id:');
    });

    it('setBackgroundTaskTerminalStatus("completed") keeps the snapshot phase at "done"', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('completed');
      const snap = component.getSubagentSnapshot();
      expect(snap.phase).toBe('done');
      expect(snap.errorText).toBeUndefined();
    });

    it('overrides win even when set before the spawn-success result is recorded', () => {
      // Order-independence guard: reconcile may run before tool result
      // has been replayed back into the component on some boot paths.
      const component = new ToolCallComponent(
        {
          id: 'call_bg_agent',
          name: 'Agent',
          args: { description: 'background agent A', run_in_background: true },
        },
        undefined,
      );
      component.setBackgroundTaskTerminalStatus('lost');
      // Now the spawn-success result lands.
      component.setResult({ ...spawnSuccessResult, tool_call_id: 'call_bg_agent' });
      expect(component.getSubagentSnapshot().phase).toBe('failed');
    });

    // Standalone render path — when only ONE Agent tool call lands in a
    // step, the card is never upgraded into an `AgentGroupComponent` and is
    // mounted on its own. The standalone header derives its label from
    // `getDerivedSubagentPhase()` (separate from `getSubagentSnapshot`).
    // Without the override threading into that path AND a header rebuild,
    // a lost bg agent keeps the green "✓ Completed" label.
    it('standalone render: lost bg agent must show Failed/Lost, not Completed', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('lost');
      const out = strip(component.render(120).join('\n'));
      expect(out).not.toContain('Completed');
      expect(out).toMatch(/Failed|Lost/);
      // Friendly failure message must reach the rendered card.
      expect(out).toContain('lost');
      expect(out).not.toContain('task_id:');
    });

    it('standalone render: completed bg agent still shows Completed', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('completed');
      const out = strip(component.render(120).join('\n'));
      expect(out).toContain('Completed');
      expect(out).not.toMatch(/Failed/);
      expect(out).not.toContain('task_id:');
    });

    // Stable id routing — `tc.subagentAgentId` is left undefined for
    // backgrounded agents both live (`handleSubagentSpawned` early-returns
    // for `runInBackground`, never calling tc.onSubagentSpawned) and on
    // resume (the wire format does not carry a `subagent` block back into
    // `applySubagentReplay`). The AgentTool's spawn-success ToolResult,
    // however, always carries `agent_id: agent-N` — fall back to parsing
    // that so callers asking `getSubagentAgentId` always get the right id,
    // and `applyBackgroundTaskTerminalStatus` can route by id instead of
    // by description (which collides between unrelated cards).
    it('getSubagentAgentId parses agent_id from the spawn-success ToolResult', () => {
      const component = new ToolCallComponent(
        {
          id: 'call_bg_agent',
          name: 'Agent',
          args: { description: 'background agent 1', run_in_background: true },
        },
        spawnSuccessResult,
      );
      // No spawn metadata was wired in — exactly the resume / backgrounded
      // case we are guarding against.
      expect(component.getSubagentAgentId()).toBe('agent-0');
    });

    it('getSubagentAgentId still prefers in-memory subagent metadata when set', () => {
      // If `setSubagentMeta` / `onSubagentSpawned` did wire an id, that one
      // is authoritative — it survived the in-flight phase before any
      // ToolResult landed and can disambiguate concurrent calls.
      const component = new ToolCallComponent(
        {
          id: 'call_bg_agent',
          name: 'Agent',
          args: { description: 'X', run_in_background: true },
        },
        spawnSuccessResult,
      );
      component.setSubagentMeta('agent-explicit', 'coder');
      expect(component.getSubagentAgentId()).toBe('agent-explicit');
    });

    it('getSubagentAgentId returns undefined for non-Agent tool calls even when output looks similar', () => {
      const component = new ToolCallComponent(
        {
          id: 'call_bash',
          name: 'Bash',
          args: { command: 'echo agent_id: agent-fake' },
        },
        {
          tool_call_id: 'call_bash',
          output: 'agent_id: agent-fake\nstatus: running',
          is_error: false,
        },
      );
      expect(component.getSubagentAgentId()).toBeUndefined();
    });

    it('setBackgroundTaskTerminalStatus errorText overwrites the friendly generic', () => {
      // Live failures arrive via `subagent.failed` with the real error from
      // the subagent loop. That string is far more informative than the
      // generic "Background agent failed" fallback the friendly path emits.
      // When the caller supplies errorText it must win, regardless of
      // whether the friendly message was written first.
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('failed');
      expect(component.getSubagentSnapshot().errorText).toBe('Background agent failed');

      component.setBackgroundTaskTerminalStatus('failed', {
        errorText: 'subagent exceeded max_steps',
      });
      expect(component.getSubagentSnapshot().errorText).toBe('subagent exceeded max_steps');
    });

    it('setBackgroundTaskTerminalStatus errorText is written even on first call', () => {
      const component = makeBackgroundAgentComponent();
      component.setBackgroundTaskTerminalStatus('failed', {
        errorText: 'OAuth refresh failed',
      });
      expect(component.getSubagentSnapshot().errorText).toBe('OAuth refresh failed');
    });

    it('setBackgroundTaskTerminalStatus does not overwrite a real onSubagentFailed error with the generic', () => {
      const component = makeBackgroundAgentComponent();
      component.onSubagentFailed({ error: 'real crash from subagent' });
      // background.task.terminated event arrives later without an errorText
      // override; the friendly generic must NOT clobber the real message.
      component.setBackgroundTaskTerminalStatus('failed');
      expect(component.getSubagentSnapshot().errorText).toBe('real crash from subagent');
    });
  });

  it('scrolls the Write streaming preview to the last COMMAND_PREVIEW_LINES', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const escaped = lines.join('\\n');
    const component = new ToolCallComponent(
      {
        id: 'call_write_stream',
        name: 'Write',
        args: { file_path: 'foo.ts', content: lines.join('\n') },
        streamingArguments: `{"file_path":"foo.ts","content":"${escaped}`,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Write');
    // Streaming preview caps at COMMAND_PREVIEW_LINES (10) and shows the tail.
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line20');
    expect(out).toContain('line21');
    expect(out).toContain('line30');
    // Line numbers should reflect actual file positions.
    expect(out).toContain('  21');
    expect(out).toContain('  30');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('switches a streaming tool call to Truncated when the step ended with max_tokens', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) lines.push(`line${String(i)}`);
    const escaped = lines.join('\\n');
    const component = new ToolCallComponent(
      {
        id: 'call_write_truncated',
        name: 'Write',
        args: { file_path: 'foo.ts', content: lines.join('\n') },
        streamingArguments: `{"file_path":"foo.ts","content":"${escaped}`,
        truncated: true,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Truncated Write');
    expect(out).not.toContain('Preparing Write');
    expect(out).toContain('Tool call arguments truncated by max_tokens');
    // The live argument preview must NOT render once the call is
    // truncated — leaving the half-streamed Write content on screen
    // was the original "preparing write" bug.
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line10');
  });

  it('renders a stable Edit progress placeholder during the streaming delta window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(4000);
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      oldLines.push(`old${String(i)}`);
      newLines.push(`new${String(i)}`);
    }
    const oldEscaped = oldLines.join('\\n');
    const newEscaped = newLines.join('\\n');
    const streaming = `{"file_path":"foo.ts","old_string":"${oldEscaped}","new_string":"${newEscaped}`;
    const component = new ToolCallComponent(
      {
        id: 'call_edit_stream',
        name: 'Edit',
        args: {
          file_path: 'foo.ts',
          old_string: oldLines.join('\n'),
          new_string: newLines.join('\n'),
        },
        streamingArguments: streaming,
        streamingStartedAtMs: 0,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Edit');
    expect(out).toContain('foo.ts');
    expect(out).toContain('Preparing changes for foo.ts...');
    expect(out).toContain('4s elapsed');
    expect(out).toMatch(/\d+(?:\.\d+)? (?:B|KB|MB)/);
    expect(out).not.toContain('old20');
    expect(out).not.toContain('new20');
    expect(out).not.toMatch(/^\s*\d+\s+[+-]\s/m);
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('caps the Write preview between finalized args and result to keep transcript height stable', () => {
    // The wire sequence is: tool.call.delta → ... → tool.call (final
    // args, no streamingArguments) → tool.result. Between tool.call and
    // tool.result we briefly sit with finalized args and no result yet —
    // even without an approval panel, at least one render tick can land
    // in this state. The preview must stay capped so the transcript
    // height does not balloon and then snap back when the result lands;
    // a big shrink triggers pi-tui's full-redraw path which wipes the
    // terminal scrollback (history before TUI start).
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const component = new ToolCallComponent(
      {
        id: 'call_write_pending',
        name: 'Write',
        args: { file_path: 'foo.ts', content: lines.join('\n') },
        // No streamingArguments → finalized args; no result yet.
      },
      undefined,
    );
    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line10');
    expect(out).not.toContain('line11');
    expect(out).not.toContain('line25');
    expect(out).toContain('ctrl+o to expand');
  });

  it('snaps a long Write preview to the collapsed cap when the result arrives', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const escaped = lines.join('\\n');
    const component = new ToolCallComponent(
      {
        id: 'call_write_snap',
        name: 'Write',
        args: { file_path: 'big.txt', content: lines.join('\n') },
        streamingArguments: `{"file_path":"big.txt","content":"${escaped}"}`,
      },
      undefined,
    );
    expect(strip(component.render(100).join('\n'))).toContain('line25');

    component.setResult({
      tool_call_id: 'call_write_snap',
      output: 'Wrote big.txt',
      is_error: false,
    });

    const after = strip(component.render(100).join('\n'));
    expect(after).toContain('line1');
    expect(after).not.toContain('line25');
    expect(after).toContain('ctrl+o to expand');
  });

  it('refreshes the header when file_path arrives in a later streaming delta', () => {
    // First delta: only an opening brace, no file_path yet.
    const component = new ToolCallComponent(
      {
        id: 'call_write_path',
        name: 'Write',
        args: {},
        streamingArguments: '{',
      },
      undefined,
    );
    const before = strip(component.render(100).join('\n'));
    expect(before).toContain('Using Write');
    expect(before).not.toContain('foo.ts');

    // Later delta: file_path is now parseable from streamingArguments.
    component.updateToolCall({
      id: 'call_write_path',
      name: 'Write',
      args: { file_path: 'foo.ts' },
      streamingArguments: '{"file_path":"foo.ts","content":"hello',
    });
    const after = strip(component.render(100).join('\n'));
    expect(after).toContain('foo.ts');
  });

  it('builds the call preview when finalized args arrive after streaming', () => {
    // Mimic the wire sequence: tool.call.delta → ... → tool.call (finalized).
    const component = new ToolCallComponent(
      {
        id: 'call_write_seq',
        name: 'Write',
        args: { file_path: 'foo.ts', content: 'a\nb' },
        streamingArguments: '{"file_path":"foo.ts","content":"a\\nb',
      },
      undefined,
    );
    // While streaming, body is rendered live from streamingArguments.
    expect(strip(component.render(100).join('\n'))).toMatch(/^\s*1\s+a\s*$/m);

    // Finalized tool.call: streamingArguments is undefined; the body
    // re-renders from finalized args, content unchanged.
    component.updateToolCall({
      id: 'call_write_seq',
      name: 'Write',
      args: { file_path: 'foo.ts', content: 'a\nb' },
    });
    const out = strip(component.render(100).join('\n'));
    expect(out).toMatch(/^\s*1\s+a\s*$/m);
    expect(out).toMatch(/^\s*2\s+b\s*$/m);
  });

  it('builds the Edit diff when finalized args arrive after streaming', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_edit_seq',
        name: 'Edit',
        args: { file_path: 'foo.ts' },
        streamingArguments: '{"file_path":"foo.ts","old_string":"a\\nb","new_string":"a\\nB',
        streamingStartedAtMs: Date.now(),
      },
      undefined,
    );
    expect(strip(component.render(100).join('\n'))).toContain('Preparing changes');
    expect(strip(component.render(100).join('\n'))).not.toMatch(/^\s*\d+\s+[+-]\s/m);

    component.updateToolCall({
      id: 'call_edit_seq',
      name: 'Edit',
      args: { file_path: 'foo.ts', old_string: 'a\nb', new_string: 'a\nB' },
    });
    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('foo.ts');
    expect(out).toMatch(/^\s*2\s+- b\s*$/m);
    expect(out).toMatch(/^\s*2\s+\+ B\s*$/m);
  });

  it('refreshes and stops the Edit streaming progress timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = { requestRender: vi.fn() };
    const component = new ToolCallComponent(
      {
        id: 'call_edit_timer',
        name: 'Edit',
        args: { file_path: 'foo.ts' },
        streamingArguments: '{"file_path":"foo.ts","old_string":"a',
        streamingStartedAtMs: 0,
      },
      undefined,
      ui as never,
    );

    expect(strip(component.render(100).join('\n'))).toContain('0s elapsed');
    vi.advanceTimersByTime(1000);
    expect(ui.requestRender).toHaveBeenCalled();
    expect(strip(component.render(100).join('\n'))).toContain('1s elapsed');

    ui.requestRender.mockClear();
    component.setResult({
      tool_call_id: 'call_edit_timer',
      output: 'Replaced 1 occurrence in foo.ts',
      is_error: false,
    });
    vi.advanceTimersByTime(1000);
    expect(ui.requestRender).not.toHaveBeenCalled();

    const componentToDispose = new ToolCallComponent(
      {
        id: 'call_edit_dispose',
        name: 'Edit',
        args: { file_path: 'bar.ts' },
        streamingArguments: '{"file_path":"bar.ts","old_string":"a',
        streamingStartedAtMs: 0,
      },
      undefined,
      ui as never,
    );
    ui.requestRender.mockClear();
    componentToDispose.dispose();
    vi.advanceTimersByTime(1000);
    expect(ui.requestRender).not.toHaveBeenCalled();
  });

  it('expands the Write call preview when ctrl+o expansion is set', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const component = new ToolCallComponent(
      {
        id: 'call_write_done',
        name: 'Write',
        args: { file_path: 'big.txt', content: lines.join('\n') },
      },
      {
        tool_call_id: 'call_write_done',
        output: 'Wrote big.txt',
        is_error: false,
      },
    );

    const collapsed = strip(component.render(100).join('\n'));
    expect(collapsed).toContain('line1');
    expect(collapsed).toContain('line10');
    expect(collapsed).not.toContain('line25');
    expect(collapsed).toContain('ctrl+o to expand');

    component.setExpanded(true);

    const expanded = strip(component.render(100).join('\n'));
    expect(expanded).toContain('line25');
    expect(expanded).toContain('line30');
    expect(expanded).not.toContain('ctrl+o to expand');
  });

  it('renders unknown Write file extensions as plain text without stderr noise', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_write_unknown_ext',
          name: 'Write',
          args: { file_path: 'demo.abcxyz', content: 'hello\nworld' },
        },
        {
          tool_call_id: 'call_write_unknown_ext',
          output: 'Wrote demo.abcxyz',
          is_error: false,
        },
      );

      const collapsed = strip(component.render(100).join('\n'));
      expect(collapsed).toContain('hello');

      component.setExpanded(true);
      const expanded = strip(component.render(100).join('\n'));
      expect(expanded).toContain('world');
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });
});
