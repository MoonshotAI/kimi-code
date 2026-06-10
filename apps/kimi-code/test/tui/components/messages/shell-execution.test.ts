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
    expect(collapsedOutput).toContain('... (2 more lines, ctrl+o to expand)');

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
    expect(output).not.toContain('... (2 more lines');
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
    expect(output).not.toContain('... (2 more lines');
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
    expect(out).toContain('... (');
  });

  describe('shellExecutionResultRenderer', () => {
    const longCmd = `echo ${'a'.repeat(200)}\necho done`;

    it('omits the command preview when collapsed', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: longCmd },
        },
        {
          tool_call_id: 'call_1',
          output: 'ok',
          is_error: false,
        },
        { expanded: false },
      );

      const rendered = components
        .flatMap((c) => c.render(100))
        .map(strip)
        .join('\n');
      expect(rendered).not.toContain('$ echo');
      expect(rendered).toContain('ok');
    });

    it('reveals the full multi-line command when expanded', () => {
      const components = shellExecutionResultRenderer(
        {
          id: 'call_1',
          name: 'Bash',
          args: { command: longCmd },
        },
        {
          tool_call_id: 'call_1',
          output: 'ok',
          is_error: false,
        },
        { expanded: true },
      );

      const rendered = components
        .flatMap((c) => c.render(300))
        .map(strip)
        .join('\n');
      expect(rendered).toContain(`$ echo ${'a'.repeat(200)}`);
      expect(rendered).toContain('echo done');
      expect(rendered).toContain('ok');
    });
  });
});
