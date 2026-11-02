import { visibleWidth, type Component, type TuiMouseEvent } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusMessageComponent } from '#/tui/components/messages/status-message';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { TranscriptContainer } from '#/tui/components/messages/transcript-container';
import { TranscriptGroupComponent } from '#/tui/components/messages/transcript-group';
import { TranscriptMoreComponent } from '#/tui/components/messages/transcript-more';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import type { TranscriptPresentationOptions } from '#/tui/config';
import { currentTheme, lightColors } from '#/tui/theme';
import { mixColors } from '#/tui/theme/color-mix';
import type { ToolCallBlockData, ToolResultBlockData, TranscriptEntry } from '#/tui/types';
import { markTranscriptComponent } from '#/tui/utils/transcript-component-metadata';
import { TRANSCRIPT_MAX_VISIBLE } from '#/tui/utils/transcript-projection';

let id = 0;
const defaultChalkLevel = chalk.level;

function options(overrides: Partial<TranscriptPresentationOptions> = {}): TranscriptPresentationOptions {
  return {
    fullscreen: true,
    groupTools: 'explore',
    groupThinking: true,
    ...overrides,
  };
}

function tool(
  name: string,
  args: Record<string, unknown> = {},
  result?: ToolResultBlockData,
): ToolCallComponent {
  const callId = result?.tool_call_id ?? `call-${++id}`;
  return new ToolCallComponent(
    { id: callId, name, args },
    result ?? { tool_call_id: callId, output: 'first\nsecond\nthird\nfourth', is_error: false },
    undefined,
    '/work',
  );
}

function runningTool(name: string, args: Record<string, unknown> = {}): ToolCallComponent {
  const callId = `call-${++id}`;
  return new ToolCallComponent({ id: callId, name, args }, undefined, undefined, '/work');
}

function agents(count: number): ToolCallComponent[] {
  return Array.from({ length: count }, () => tool('Agent'));
}

function thought(ms = 3000): ThinkingComponent {
  const component = new ThinkingComponent('reasoning', true, 'finalized');
  component.finalize({ known: true, ms });
  return component;
}

function makeContainer(presentation = options()) {
  const requestRender = vi.fn();
  const container = new TranscriptContainer(0, 0, requestRender);
  container.setPresentationOptions(presentation);
  return { container, requestRender };
}

function plain(lines: readonly string[]): string {
  return lines.join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function tailLines(lines: readonly string[]): string[] {
  return plain(lines).split('\n').filter((line) => /^ {2}[└├] /.test(line));
}

function click(container: TranscriptContainer, y: number, x = 0): void {
  const lines = container.render(80);
  const event: TuiMouseEvent = {
    type: 'click',
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
  container.handleMouse(event);
}

function user(text: string): UserMessageComponent {
  const component = new UserMessageComponent(text);
  const entry: TranscriptEntry = { id: `entry-${++id}`, kind: 'user', content: text, renderMode: 'markdown' };
  markTranscriptComponent(component, entry);
  return component;
}

afterEach(() => {
  vi.useRealTimers();
  chalk.level = defaultChalkLevel;
  currentTheme.setTerminalBackground(undefined);
});

describe('TranscriptGroupComponent', () => {
  it('renders collapsed and expanded summaries without rendering hidden members', () => {
    const { container } = makeContainer();
    const thinking = thought();
    const read = tool('Read', { path: '/work/a.ts' });
    const memberRender = vi.spyOn(read, 'render');
    container.addChild(thinking);
    container.addChild(read);

    const collapsed = container.render(80);
    expect(plain(collapsed)).toContain('› Thought for 3s, read 1 file');
    expect(memberRender).not.toHaveBeenCalled();

    container.toggleGroup(thinking);
    const expanded = plain(container.render(80));
    expect(expanded).toContain('⌄ Thought for 3s, read 1 file');
    expect(expanded).toContain('│ ');
    expect(expanded).toContain('Used Read');
    expect(memberRender).toHaveBeenCalled();
  });

  it('keeps regular thinking previews unchanged by grouping preferences', () => {
    const { container } = makeContainer(options({ fullscreen: false, groupThinking: true }));
    const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive', true, 'live');
    container.addChild(thinking);

    const preview = plain(container.render(80));
    expect(preview).not.toContain('one');
    expect(preview).toContain('four');
    expect(preview).toContain('five');

    container.setPresentationOptions(options({ fullscreen: false, groupThinking: false }));
    expect(plain(container.render(80))).toBe(preview);
  });

  it('keeps thinking as a visible boundary when grouping is off', () => {
    const { container } = makeContainer(options({ groupThinking: false }));
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read'));

    const text = plain(container.render(80));
    expect(text).toContain('reasoning');
    expect(text).toContain('› Read 1 file');
    expect(text).not.toContain('Used Read');
  });

  it('reuses the same output array while a collapsed group is unchanged', () => {
    const { container } = makeContainer();
    container.addChild(thought());
    container.addChild(tool('Read'));

    const first = container.render(100);
    const second = container.render(100);

    expect(second).toBe(first);
  });

  it('re-renders a member when its card expands and preserves Ctrl+O expansion', () => {
    const { container } = makeContainer();
    const output = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
    const first = tool('Bash', { command: 'cat a.txt' }, {
      tool_call_id: 'bash-a',
      output,
      is_error: false,
    });
    const second = tool('Bash', { command: 'cat b.txt' }, {
      tool_call_id: 'bash-b',
      output,
      is_error: false,
    });
    container.addChild(first);
    container.addChild(second);
    container.toggleGroup(first);
    const collapsedLines = plain(container.render(100)).split('\n');
    const firstHeader = collapsedLines.findIndex((line) => line.includes('Ran a command') && line.includes('cat a.txt'));
    expect(firstHeader).toBeGreaterThanOrEqual(0);

    click(container, firstHeader);

    expect(first.isExpanded()).toBe(true);
    const expandedLines = plain(container.render(100)).split('\n');
    expect(expandedLines.length).toBeGreaterThan(collapsedLines.length);
    expect(expandedLines.some((line) => line.trimEnd().endsWith('line 1'))).toBe(true);

    first.setExpanded(false);
    container.toggleToolOutputExpansion();
    expect(first.isExpanded()).toBe(true);
    expect(second.isExpanded()).toBe(true);
    expect(plain(container.render(100)).split('\n').length).toBeGreaterThan(collapsedLines.length);
  });

  it('keeps diff and failure tails at 70 columns', () => {
    const { container } = makeContainer(options({ groupTools: 'auto' }));
    const components = [
      thought(9000),
      tool('Read', { path: '/work/a.ts' }),
      tool('Grep', { pattern: 'needle' }),
      tool('FetchURL'),
      tool('WebSearch'),
      tool('Skill'),
      tool('Edit', { path: '/work/a.ts', old_string: 'one', new_string: 'two' }),
      tool('Bash', { command: 'pnpm test' }, {
        tool_call_id: 'failed-bash',
        output: 'failed',
        is_error: true,
      }),
    ];
    for (const component of components) container.addChild(component);

    chalk.level = 3;
    const lines = container.render(70);
    expect(plain(lines)).toContain('+1 -1 · 1 failed');
    expect(lines.join('\n')).toContain(currentTheme.fg('diffAdded', '+1'));
    expect(lines.join('\n')).toContain(currentTheme.fg('diffRemoved', '-1'));
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(70);
  });

  it('sweeps a highlight with fake time and stops its timer after fading', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { container, requestRender } = makeContainer();
    container.setTurnActive(true);
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(runningTool('Grep'));

    const initial = container.render(80);
    expect(plain(initial)).toContain('› Thought for 3s');
    expect(plain(initial)).not.toContain('⠋');
    requestRender.mockClear();
    vi.advanceTimersByTime(100);
    const next = container.render(80);
    expect(requestRender).toHaveBeenCalled();
    expect(next).not.toEqual(initial);

    container.setTurnActive(false);
    container.render(80);
    for (let frame = 0; frame < 40; frame++) {
      vi.advanceTimersByTime(50);
      container.render(80);
    }
    expect(vi.getTimerCount()).toBe(0);
    container.clear();
  });

  it('pauses after the highlight leaves the summary before restarting', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { container } = makeContainer();
    container.addChild(tool('Read'));
    container.setTurnActive(true);
    container.render(100);

    for (let frame = 0; frame < 13; frame++) {
      vi.advanceTimersByTime(50);
      container.render(100);
    }
    const dimMarker = chalk.hex(currentTheme.color('textDim'))('›');
    expect(container.render(100)[1]?.startsWith(dimMarker)).toBe(true);

    for (let frame = 0; frame < 7; frame++) {
      vi.advanceTimersByTime(50);
      container.render(100);
    }
    expect(container.render(100)[1]?.startsWith(dimMarker)).toBe(false);
    container.clear();
  });

  it('renders running and recent tails with one mixed color and elapsed seconds', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    currentTheme.setTerminalBackground('#1E1E1E');
    const { container } = makeContainer();
    const read = runningTool('Read', { path: '/work/a.ts' });
    const bash = runningTool('Bash', { command: 'sleep 5' });
    container.addChild(read);
    container.addChild(bash);
    container.setTurnActive(true);

    const initial = container.render(100);
    const text = plain(initial);
    expect(text).toContain('├ Read a.ts');
    expect(text).toContain('└ $ sleep 5');
    const tailColor = mixColors(currentTheme.color('textDim'), '#1E1E1E', 0.35);
    expect(initial.join('\n')).toContain(chalk.hex(tailColor)('  └ $ sleep 5'));

    vi.advanceTimersByTime(2_000);
    expect(plain(container.render(100))).toContain('└ $ sleep 5 · 2s');

    for (const component of [read, bash]) {
      component.setResult({
        tool_call_id: component.toolCallView.id,
        output: 'ok',
        is_error: false,
      }, { known: true, ms: 2_500 });
    }
    const recent = plain(container.render(100));
    expect(recent).not.toContain('├ Read a.ts');
    expect(recent).toContain('└ $ sleep 5');
    expect(recent).not.toContain('$ sleep 5 · 2s');

    container.toggleGroup(read);
    const expanded = container.render(100);
    expect(plain(expanded)).toContain('└ Show less');
    expect(plain(expanded)).not.toContain('└ $ sleep 5');
    const guideColor = mixColors(currentTheme.color('textDim'), '#1E1E1E', 0.60);
    expect(expanded.join('\n')).toContain(chalk.hex(guideColor)('│ '));
    expect(expanded.join('\n')).toContain(chalk.hex(guideColor)('└ '));

    container.toggleGroup(read);
    container.setTurnActive(false);
    expect(plain(container.render(100))).not.toContain('$ sleep 5');
    container.clear();
  });

  it('draws both Show less rows in the tail color and follows theme and background changes', () => {
    chalk.level = 3;
    const previousPalette = currentTheme.palette;
    currentTheme.setTerminalBackground('#FFFFFF');
    const { container: group } = makeContainer();
    const read = runningTool('Read', { path: '/work/a.ts' });
    group.addChild(read);
    group.setTurnActive(true);
    group.toggleGroup(read);
    group.render(100);
    const { container: dense } = makeContainer(options({ groupTools: 'auto' }));
    for (const component of [tool('Read'), tool('Agent'), tool('Read'), ...agents(TRANSCRIPT_MAX_VISIBLE - 1)]) dense.addChild(component);
    click(dense, 1);
    dense.render(100);
    const tailColor = (background: string): string => mixColors(lightColors.textDim, background, 0.35);

    try {
      currentTheme.setPalette(lightColors);
      expect(group.render(100).join('\n')).toContain(chalk.hex(tailColor('#FFFFFF'))('Show less'));
      expect(dense.render(100).join('\n')).toContain(chalk.hex(tailColor('#FFFFFF'))('Show less'));

      currentTheme.setTerminalBackground('#FAFBFC');
      expect(group.render(100).join('\n')).toContain(chalk.hex(tailColor('#FAFBFC'))('Show less'));
      expect(dense.render(100).join('\n')).toContain(chalk.hex(tailColor('#FAFBFC'))('Show less'));

      group.toggleGroup(read);
      expect(group.render(100).join('\n')).toContain(chalk.hex(tailColor('#FAFBFC'))('  └ Read a.ts'));
      click(dense, 1);
      expect(dense.render(100).join('\n')).toContain(currentTheme.fg('textMuted', '… 2 more'));
    } finally {
      currentTheme.setPalette(previousPalette);
      group.clear();
    }
  });

  it('hides the tail and pauses the highlight below streaming thinking', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { container } = makeContainer();
    container.addChild(runningTool('Read', { path: '/work/a.ts' }));
    const thinking = new ThinkingComponent('reasoning', true, 'live');
    container.addChild(thinking);
    container.setTurnActive(true);

    const initial = container.render(100);
    vi.advanceTimersByTime(100);
    const streaming = container.render(100);
    expect(streaming[1]).toBe(initial[1]);
    expect(tailLines(streaming)).toEqual([]);

    thinking.finalize({ known: true, ms: 100 });
    container.render(100);
    vi.advanceTimersByTime(100);
    const active = container.render(100);
    expect(active[1]).not.toBe(streaming[1]);
    expect(tailLines(active)).toEqual(['  └ Read a.ts']);
    container.clear();
  });

  it('keeps a finished tool out of the tail while thinking streams and after it merges', () => {
    const { container } = makeContainer();
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    const thinking = new ThinkingComponent('reasoning', true, 'live');
    container.addChild(thinking);
    container.setTurnActive(true);

    const streaming = container.render(100);
    expect(plain(streaming)).toContain('› Read 1 file');
    expect(plain(streaming)).toContain('reasoning');
    expect(tailLines(streaming)).toEqual([]);

    thinking.finalize({ known: true, ms: 1000 });
    const merged = container.render(100);
    expect(plain(merged)).toContain('› Thought for 1s, read 1 file');
    expect(tailLines(merged)).toEqual([]);

    container.addChild(runningTool('Grep', { pattern: 'needle' }));
    expect(tailLines(container.render(100))).toEqual(['  └ Search "needle"']);
    container.clear();
  });

  it('keeps a running Bash in the tail after a finished thought', () => {
    const { container } = makeContainer(options({ groupTools: 'auto' }));
    container.addChild(runningTool('Bash', { command: 'sleep 5' }));
    container.addChild(thought());
    container.setTurnActive(true);

    expect(tailLines(container.render(100))).toEqual(['  └ $ sleep 5']);
    container.clear();
  });

  it.each([
    ['Read', { path: '/work/a.ts' }, 'Read a.ts'],
    ['ReadMediaFile', { path: '/work/a.png' }, 'View a.png'],
    ['Grep', { pattern: 'needle', path: '/work/src' }, 'Search "needle" in src'],
    ['Glob', { pattern: '**/*.ts' }, 'Find **/*.ts'],
    ['Bash', { command: 'git status' }, '$ git status'],
    ['Edit', { path: '/work/a.ts', old_string: 'a', new_string: 'b' }, 'Edit a.ts'],
    ['Write', { path: '/work/a.ts', content: 'a' }, 'Write a.ts'],
    ['TodoList', { todos: [{ title: 'Verify layout', status: 'in_progress' }] }, 'Update todos · Verify layout'],
    ['Skill', { skill: 'review' }, 'Load skill review'],
    ['WebSearch', { query: 'terminal grouping' }, 'Search web "terminal grouping"'],
    ['FetchURL', { url: 'https://example.com/docs' }, 'Fetch example.com/docs'],
    ['WaitFor', { task_id: 'task-1' }, 'Wait for task-1'],
    ['TaskOutput', { task_id: 'task-1' }, 'Read output of task-1'],
    ['TaskList', {}, 'List tasks'],
    ['mcp__server__tool', {}, 'server: tool'],
    ['CustomTool', { input: 'value' }, 'CustomTool value'],
    ['Read', {}, 'Read'],
    ['ReadMediaFile', {}, 'View'],
    ['Grep', {}, 'Search'],
    ['Glob', {}, 'Find'],
    ['Bash', {}, '$'],
    ['Edit', {}, 'Edit'],
    ['Write', {}, 'Write'],
    ['Skill', {}, 'Load skill'],
    ['WebSearch', {}, 'Search web'],
    ['FetchURL', {}, 'Fetch'],
    ['WaitFor', {}, 'Wait for any task'],
    ['TaskOutput', {}, 'Read output'],
    ['Read', { path: '' }, 'Read'],
    ['Edit', { path: '' }, 'Edit'],
    ['Write', { path: '' }, 'Write'],
    ['Grep', { pattern: 'needle', path: '' }, 'Search "needle"'],
    ['FetchURL', { url: 'https://' }, 'Fetch'],
    ['TodoList', { todos: [{ title: '', status: 'in_progress' }] }, 'Update todos'],
    ['CustomTool', { input: '\nvalue' }, 'CustomTool'],
  ])('renders the %s tail description', (name, args, expected) => {
    const { container } = makeContainer(options({ groupTools: 'auto' }));
    container.addChild(runningTool(name, args));
    container.setTurnActive(true);

    const tail = plain(container.render(100)).split('\n').find((line) => line.startsWith('  └ '));
    expect(tail).toBe(`  └ ${expected}`);
    container.clear();
  });

  it('keeps a clicked streaming thought outside after it finishes and restores it on collapse', () => {
    const { container } = makeContainer();
    const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive', true, 'live');
    container.addChild(tool('Read'));
    container.addChild(thinking);

    expect(plain(container.render(80))).toContain('Read 1 file');
    click(container, plain(container.render(80)).split('\n').length - 1);
    expect(thinking.isExpanded()).toBe(true);

    thinking.finalize({ known: true, ms: 3000 });
    const finished = plain(container.render(80));
    expect(finished).toContain('Read 1 file');
    expect(finished).not.toContain('Thought for 3s');
    expect(finished).toContain('one');

    click(container, plain(container.render(80)).split('\n').length - 1);
    expect(thinking.isExpanded()).toBe(false);
    expect(plain(container.render(80))).toContain('Thought for 3s, read 1 file');
  });

  it('keeps a clicked member outside the summary and restores it when collapsed', () => {
    const { container } = makeContainer();
    const output = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
    const first = tool('Bash', { command: 'cat a.txt' }, {
      tool_call_id: 'manual-a',
      output,
      is_error: false,
    });
    container.addChild(first);
    container.addChild(tool('Bash', { command: 'cat b.txt' }));
    container.toggleGroup(first);

    const expanded = plain(container.render(100)).split('\n');
    click(container, expanded.findIndex((line) => line.includes('cat a.txt')));
    expect(first.isExpanded()).toBe(true);
    expect(plain(container.render(100))).toContain('Ran 1 command');

    const external = plain(container.render(100)).split('\n');
    click(container, external.findLastIndex((line) => line.includes('cat a.txt')));
    expect(first.isExpanded()).toBe(false);
    expect(plain(container.render(100))).toContain('Ran 2 commands');
  });

  it('does not treat Ctrl+O expansion as opening individual members', () => {
    const { container } = makeContainer();
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(tool('Read', { path: '/work/b.ts' }));

    container.toggleToolOutputExpansion();

    const text = plain(container.render(80));
    expect(text).toContain('Read 2 files');
    expect(text.match(/│ .*Used Read/g)).toHaveLength(2);
  });

  it('returns members collapsed by Ctrl+O to their groups', () => {
    const { container } = makeContainer();
    const output = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
    const opened = tool('Bash', { command: 'cat a.txt' }, {
      tool_call_id: 'opened-by-user',
      output,
      is_error: false,
    });
    container.addChild(opened);
    container.addChild(tool('Bash', { command: 'cat b.txt' }));
    container.toggleGroup(opened);
    const expanded = plain(container.render(100)).split('\n');
    click(container, expanded.findIndex((line) => line.includes('cat a.txt')));
    expect(plain(container.render(100))).toContain('Ran 1 command');

    container.toggleToolOutputExpansion();
    container.toggleToolOutputExpansion();

    const collapsed = plain(container.render(100));
    expect(opened.isExpanded()).toBe(false);
    expect(collapsed).toContain('› Ran 2 commands');
    expect(collapsed).not.toContain('cat a.txt');
  });

  it('collapses the group an opened only member returns to after Ctrl+O collapses everything', () => {
    const { container } = makeContainer();
    const output = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
    const opened = tool('Bash', { command: 'cat only.txt' }, {
      tool_call_id: 'only-member',
      output,
      is_error: false,
    });
    container.addChild(opened);
    container.toggleGroup(opened);
    const expanded = plain(container.render(80)).split('\n');
    click(container, expanded.findIndex((line) => line.includes('cat only.txt')));
    expect(opened.isExpanded()).toBe(true);
    expect(plain(container.render(80))).not.toContain('Ran 1 command');

    container.toggleToolOutputExpansion();
    container.toggleToolOutputExpansion();

    const collapsed = plain(container.render(80));
    expect(opened.isExpanded()).toBe(false);
    expect(collapsed).toContain('› Ran 1 command');
    expect(collapsed).not.toContain('Show less');
    expect(container.toolOutputExpandHint()).toBe('expand');
  });

  it('reuses the summary object when members are unchanged', () => {
    const { container } = makeContainer();
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read'));
    container.render(80);
    const group = container.getRenderedLayout()?.children
      .map((entry) => entry.component)
      .find((component) => component instanceof TranscriptGroupComponent);
    if (!(group instanceof TranscriptGroupComponent)) throw new Error('group not rendered');
    const setModel = vi.spyOn(group, 'setModel');

    container.toggleGroup(thinking);
    container.render(80);
    container.toggleGroup(thinking);
    container.render(80);

    const first = setModel.mock.calls[0]?.[0];
    const second = setModel.mock.calls[1]?.[0];
    expect(first).toBeDefined();
    expect(second?.summary).toBe(first?.summary);
  });
});

describe('TranscriptContainer streaming updates', () => {
  it('stops treating a truncated call as running', () => {
    const { container } = makeContainer();
    const call: ToolCallBlockData = {
      id: 'call-truncated',
      name: 'Read',
      args: { path: '/work/a.ts' },
      streamingArguments: '{"path":"/work/a.ts"}',
    };
    const read = new ToolCallComponent(call, undefined, undefined, '/work');
    container.addChild(read);
    container.setTurnActive(true);
    expect(plain(container.render(100))).toContain('Reading 1 file');

    call.truncated = true;
    read.updateToolCall(call);
    container.setTurnActive(false);

    const text = plain(container.render(100));
    expect(text).toContain('Read 1 file');
    expect(text).not.toContain('Reading');
  });

  it('updates the Bash tail while arguments are still streaming', () => {
    const { container } = makeContainer();
    const bash = runningTool('Bash');
    bash.updateToolCall({ ...bash.toolCallView, streamingArguments: '{' });
    container.addChild(bash);
    container.setTurnActive(true);
    container.render(100);

    bash.updateToolCall({
      ...bash.toolCallView,
      args: { command: 'sleep 30' },
      streamingArguments: '{"command":"sleep 30"}',
    });

    expect(plain(container.render(100))).toContain('└ $ sleep 30');
  });

  it('updates Edit diff counts while arguments are still streaming', () => {
    const { container } = makeContainer(options({ groupTools: 'auto' }));
    const edit = runningTool('Edit', { path: '/work/a.ts' });
    edit.updateToolCall({ ...edit.toolCallView, streamingArguments: '{"path":"/work/a.ts"}' });
    container.addChild(edit);
    container.setTurnActive(true);
    container.render(100);

    edit.updateToolCall({
      ...edit.toolCallView,
      args: { path: '/work/a.ts', old_string: 'a', new_string: 'b' },
      streamingArguments: '{"path":"/work/a.ts","old_string":"a","new_string":"b"}',
    });

    expect(plain(container.render(100))).toContain('+1 -1');
  });
});

describe('TranscriptContainer dense truncation', () => {
  it('expands and collapses older top-level items without destroying sources', () => {
    const { container } = makeContainer(options({ groupTools: 'auto' }));
    const components = [
      tool('Read', { path: '/work/a.ts' }),
      tool('Agent', { description: 'first-agent' }),
      tool('Read', { path: '/work/b.ts' }),
      tool('Agent', { description: 'second-agent' }),
      ...agents(TRANSCRIPT_MAX_VISIBLE - 2),
    ];
    for (const component of components) container.addChild(component);

    const collapsed = plain(container.render(100));
    expect(collapsed).toContain('… 2 more');
    expect(collapsed).not.toContain('first-agent');
    expect(collapsed).toContain('second-agent');
    expect(container.children).toEqual(components);

    click(container, 1);
    const expanded = plain(container.render(100));
    expect(expanded).toContain('Show less');
    expect(expanded).not.toContain('… 2 more');
    expect(expanded).toContain('first-agent');
    expect(container.children).toEqual(components);

    click(container, 1);
    const collapsedAgain = plain(container.render(100));
    expect(collapsedAgain).toContain('… 2 more');
    expect(collapsedAgain).not.toContain('first-agent');
    expect(container.children).toEqual(components);
  });

  it('recolors items hidden behind the more row when the theme changes', () => {
    chalk.level = 3;
    const previousPalette = currentTheme.palette;
    const firstAgentLine = (rendered: readonly string[]) => rendered.find((line) => line.includes('first-agent'));
    try {
      currentTheme.setPalette(darkColors);
      const darkCard = firstAgentLine(tool('Agent', { description: 'first-agent' }).render(100));
      const { container } = makeContainer(options({ groupTools: 'auto' }));
      const components = [
        tool('Read', { path: '/work/a.ts' }),
        tool('Agent', { description: 'first-agent' }),
        tool('Read', { path: '/work/b.ts' }),
        tool('Agent', { description: 'second-agent' }),
        ...agents(TRANSCRIPT_MAX_VISIBLE - 2),
      ];
      for (const component of components) container.addChild(component);
      expect(plain(container.render(100))).toContain('… 2 more');

      currentTheme.setPalette(lightColors);
      container.invalidate();
      click(container, 1);

      const lightCard = firstAgentLine(tool('Agent', { description: 'first-agent' }).render(100));
      expect(lightCard).not.toBe(darkCard);
      expect(firstAgentLine(container.render(100))).toBe(lightCard);
    } finally {
      currentTheme.setPalette(previousPalette);
    }
  });

  it('applies Ctrl+O to every group and card in a dense segment', () => {
    const { container } = makeContainer(options({ groupTools: 'auto' }));
    const components = [
      tool('Read', { path: '/work/a.ts' }),
      tool('Agent', { description: 'first-agent' }),
      tool('Read', { path: '/work/b.ts' }),
      tool('Agent', { description: 'second-agent' }),
      ...agents(TRANSCRIPT_MAX_VISIBLE - 2),
    ];
    for (const component of components) container.addChild(component);

    expect(container.toolOutputExpandHint()).toBe('expand');
    expect(container.toggleToolOutputExpansion()).toBe(true);
    expect(plain(container.render(100))).toContain('⌄ Read 1 file');
    expect(components.every((component) => component.isExpanded())).toBe(true);
    expect(container.toolOutputExpandHint()).toBe('collapse');

    click(container, 1);
    expect(plain(container.render(100)).match(/⌄ Read 1 file/g)).toHaveLength(2);

    expect(container.toggleToolOutputExpansion()).toBe(false);
    expect(plain(container.render(100))).not.toContain('⌄');
    expect(components.every((component) => !component.isExpanded())).toBe(true);
  });

  it('keeps communication, plan, and status rows visible without counting them', () => {
    const { container } = makeContainer(options({ groupTools: 'auto' }));
    const components = [
      tool('Read'),
      tool('NotifyUser', { title: 'update-visible' }),
      tool('Agent'),
      tool('Read'),
      tool('AskUserQuestion'),
      tool('Agent'),
      tool('ExitPlanMode', { plan: 'plan-visible' }),
      new StatusMessageComponent('status-visible'),
      ...agents(TRANSCRIPT_MAX_VISIBLE - 2),
    ];
    for (const component of components) container.addChild(component);

    const text = plain(container.render(120));
    expect(text).toContain('… 2 more');
    expect(text).toContain('update-visible');
    expect(text).toContain('Collected your answers');
    expect(text).toContain('plan-visible');
    expect(text).toContain('status-visible');
    expect(container.getRenderedLayout()?.children
      .filter((entry) => entry.component instanceof TranscriptMoreComponent)).toHaveLength(1);
  });
});

describe('TranscriptContainer interaction', () => {
  it('toggles a group from any summary column with anchoring and telemetry', () => {
    const { container } = makeContainer();
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read'));
    const track = vi.fn();
    const withScrollAnchor = vi.fn((toggle: () => void) => {
      toggle();
    });
    container.setHost({ withScrollAnchor, withBottomAnchor: vi.fn(), track });

    click(container, 1, 60);

    expect(withScrollAnchor).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith('transcript_group_toggle', { expanded: true });
    expect(plain(container.render(80))).toContain('⌄ Thought for 3s');

    click(container, 1, 0);
    expect(track).toHaveBeenCalledWith('transcript_group_toggle', { expanded: false });
    expect(plain(container.render(80))).toContain('› Thought for 3s');
  });

  it('collapses from Show less with bottom anchoring', () => {
    const { container } = makeContainer();
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read'));
    const withScrollAnchor = vi.fn((toggle: () => void) => {
      toggle();
    });
    const withBottomAnchor = vi.fn((toggle: () => void, _removedLines: number) => {
      toggle();
    });
    container.setHost({ withScrollAnchor, withBottomAnchor, track: vi.fn() });
    container.toggleGroup(thinking);
    const expanded = container.render(80);
    const showLess = plain(expanded).split('\n').findIndex((line) => line.includes('Show less'));
    withScrollAnchor.mockClear();

    click(container, showLess);

    expect(withBottomAnchor).toHaveBeenCalledOnce();
    expect(withBottomAnchor.mock.calls[0]?.[1]).toBe(expanded.length - 2);
    expect(withScrollAnchor).not.toHaveBeenCalled();
    expect(plain(container.render(80))).toContain('› Thought for 3s');
  });

  it('lets summary clicks expand old groups but keeps member expansion within three turns', () => {
    const { container } = makeContainer();
    const oldThinking = thought();
    const oldRead = tool('Read');
    container.addChild(oldThinking);
    container.addChild(oldRead);
    for (const text of ['one', 'two', 'three', 'four']) container.addChild(user(text));

    click(container, 1);
    expect(plain(container.render(80))).toContain('⌄ Thought for 3s');
    click(container, 4);
    expect(oldRead.isExpanded()).toBe(false);

    const recentThinking = thought();
    const recentRead = tool('Read');
    container.addChild(recentThinking);
    container.addChild(recentRead);
    const lines = plain(container.render(80)).split('\n');
    const recentSummary = lines.findLastIndex((line) => line.includes('Thought for 3s'));
    expect(recentSummary).toBeGreaterThanOrEqual(0);
    click(container, recentSummary);
    click(container, recentSummary + 4);
    expect(recentRead.isExpanded()).toBe(true);
  });

  it('gives a member component first chance to handle its mouse event', () => {
    const { container } = makeContainer();
    const thinking = thought();
    const read = tool('Read');
    container.addChild(thinking);
    container.addChild(read);
    container.toggleGroup(thinking);
    const memberMouse = vi.spyOn(read, 'handleMouse').mockReturnValue({
      handled: true,
      target: { component: read, originX: 0, originY: 0, width: 80, height: 1 },
    });

    click(container, 4);

    expect(memberMouse).toHaveBeenCalledOnce();
    expect(read.isExpanded()).toBe(false);
  });

  it('expands only recent groups with Ctrl+O and applies global state to new groups', () => {
    const { container } = makeContainer();
    const oldThinking = thought();
    container.addChild(oldThinking);
    container.addChild(tool('Read'));
    for (const text of ['one', 'two', 'three', 'four']) container.addChild(user(text));
    const recentThinking = thought();
    container.addChild(recentThinking);
    container.addChild(tool('Grep'));

    expect(container.toggleToolOutputExpansion()).toBe(true);
    let text = plain(container.render(100));
    expect(text).toContain('› Thought for 3s, read 1 file');
    expect(text).toContain('⌄ Thought for 3s, searched 1 pattern');

    container.addChild(user('next turn'));
    const newThinking = thought();
    container.addChild(newThinking);
    container.addChild(tool('Glob'));
    text = plain(container.render(100));
    expect(text.match(/⌄/g)).toHaveLength(2);

    expect(container.toggleToolOutputExpansion()).toBe(false);
    text = plain(container.render(100));
    expect(text).not.toContain('⌄');
  });

  it('re-derives after configuration changes while preserving group expansion', () => {
    const { container } = makeContainer();
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read'));
    container.addChild(tool('Grep'));
    container.toggleGroup(thinking);
    expect(plain(container.render(80))).toContain('⌄ Thought for 3s');

    container.setPresentationOptions(options({ groupTools: 'off' }));

    const text = plain(container.render(80));
    expect(text).toContain('⌄ Thought');
    expect(text).toContain('Used Read');
    expect(text).toContain('Used Grep');
  });

  it('returns projected layout with user boundaries and group wrappers', () => {
    const { container } = makeContainer();
    const boundary = user('question');
    container.addChild(boundary);
    container.addChild(thought());
    container.addChild(tool('Read'));
    container.render(80);

    const layout = container.getRenderedLayout();
    expect(layout?.children[0]?.component).toBe(boundary);
    expect(layout?.children.some((entry) => entry.component instanceof TranscriptGroupComponent)).toBe(true);
    expect(layout?.children.some((entry) => entry.component instanceof ToolCallComponent)).toBe(false);
  });
});
