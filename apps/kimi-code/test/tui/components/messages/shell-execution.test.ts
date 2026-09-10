import { describe, expect, it } from 'vitest';

import {
  ShellExecutionComponent,
  shellExecutionResultRenderer,
} from '#/tui/components/messages/shell-execution';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('ShellExecutionComponent', () => {
  it('renders shell command previews with prompt indentation', () => {
    const component = new ShellExecutionComponent({
      command: 'printf hello\nprintf world',
      showCommand: true,
    });

    const output = component.render(100).map((line) => strip(line).trimEnd());

    expect(output).toContain('  $ printf hello');
    expect(output).toContain('    printf world');
  });

  it('keeps collapsed shell output short and expands on demand', () => {
    const collapsed = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output: ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
        is_error: false,
      },
    });

    const collapsedOutput = collapsed.render(100).map(strip).join('\n');
    expect(collapsedOutput).toContain('line1');
    expect(collapsedOutput).toContain('line3');
    expect(collapsedOutput).not.toContain('line4');
    expect(collapsedOutput).toContain('… (2 more lines, ctrl+o to expand)');

    const expanded = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output: ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
        is_error: false,
      },
      expanded: true,
    });

    const expandedOutput = expanded.render(100).map(strip).join('\n');
    expect(expandedOutput).toContain('line4');
    expect(expandedOutput).toContain('line5');
    expect(expandedOutput).not.toContain('ctrl+o to expand');
  });

  it('renders unbounded command preview when previewLines is undefined', () => {
    const cmd = Array.from({ length: 20 }, (_, i) => `step${String(i + 1)}`).join('\n');
    const component = new ShellExecutionComponent({
      command: cmd,
      showCommand: true,
      commandPreviewLines: undefined,
    });

    const output = component.render(100).map(strip).join('\n');
    expect(output).toContain('$ step1');
    expect(output).toContain('step20');
  });

  it('does not count trailing empty lines toward the preview cap', () => {
    const component = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output: 'hello\n\n\n', // 1 content line + 2 trailing empty lines
        is_error: false,
      },
    });

    const output = component.render(100).map(strip).join('\n');
    expect(output).toContain('hello');
    expect(output).not.toContain('… (2 more lines');
  });

  it('preserves internal empty lines while trimming only trailing ones', () => {
    const component = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output: 'a\n\nb\n\n\n', // 1 internal empty line + 2 trailing empty lines
        is_error: false,
      },
    });

    const output = component.render(100).map(strip).join('\n');
    expect(output).toContain('a');
    expect(output).toContain('b');
    expect(output).not.toContain('… (2 more lines');
  });

  it('truncates long single-line output by wrapped visual lines', () => {
    const component = new ShellExecutionComponent({
      result: {
        tool_call_id: 'call_shell',
        output: 'x'.repeat(500),
        is_error: false,
      },
    });

    const out = strip(component.render(20).join('\n'));
    expect(out).toContain('x');
    expect(out).not.toContain('x'.repeat(500));
    expect(out).toContain('… (');
  });

  describe('shellExecutionResultRenderer', () => {
    const longCmd = `echo ${'a'.repeat(200)}\necho done`;

    it('renders only the last output line as the outcome row while collapsed', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: longCmd },
        },
        {
          tool_call_id: 'call_1',
          output: 'first\nsecond\nthird\n\nTests 12 passed\n\n',
          is_error: false,
        },
        { expanded: false },
      );

      const rendered = components.flatMap((c) => c.render(100)).map(strip);
      expect(rendered).toEqual(['  … Tests 12 passed']);
    });

    it('identifies a background task by its first metadata line while collapsed', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: 'npm run build', run_in_background: true },
        },
        {
          tool_call_id: 'call_1',
          output: [
            'task_id: bash-abc123',
            'pid: 12345',
            'description: npm run build',
            'status: running',
            'automatic_notification: true',
            'next_step: The completion arrives automatically in a later turn.',
            'human_shell_hint: The task is visible in the background-task panel.',
          ].join('\n'),
          is_error: false,
        },
        { expanded: false },
      );

      const rendered = components.flatMap((c) => c.render(100)).map(strip);
      expect(rendered).toEqual(['  task_id: bash-abc123 …']);
    });

    it('shows a short result whole while collapsed', () => {
      const components = shellExecutionResultRenderer(
        { id: 'call_1', name: 'Bash', args: { command: 'git status --short' } },
        { tool_call_id: 'call_1', output: ' M src/a.ts\n?? src/b.ts\n', is_error: false },
        { expanded: false },
      );
      const rendered = components.flatMap((c) => c.render(100)).map(strip);
      expect(rendered).toEqual(['   M src/a.ts', '  ?? src/b.ts']);
    });

    it('renders no outcome row for a successful result without output', () => {
      const components = shellExecutionResultRenderer(
        { id: 'call_1', name: 'Bash', args: { command: 'true' } },
        { tool_call_id: 'call_1', output: '\n  \n', is_error: false },
        { expanded: false },
      );
      expect(components).toEqual([]);
    });

    it('keeps a failing result previewed while collapsed and leaves the command to the call preview', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: longCmd },
        },
        {
          tool_call_id: 'call_1',
          output: 'boom',
          is_error: true,
        },
        { expanded: false },
      );

      const rendered = components
        .flatMap((c) => c.render(100))
        .map(strip)
        .join('\n');
      // Command is owned by ToolCallComponent.buildCallPreview, not the
      // renderer — rendering it here too would duplicate it once the result
      // lands.
      expect(rendered).not.toContain('$ echo');
      expect(rendered).toContain('boom');
    });

    it('still renders only the result when expanded', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: longCmd },
        },
        {
          tool_call_id: 'call_1',
          output: ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
          is_error: false,
        },
        { expanded: true },
      );

      const rendered = components
        .flatMap((c) => c.render(300))
        .map(strip)
        .join('\n');
      expect(rendered).not.toContain('$ echo');
      expect(rendered).toContain('line4');
      expect(rendered).toContain('line5');
    });
  });
});
