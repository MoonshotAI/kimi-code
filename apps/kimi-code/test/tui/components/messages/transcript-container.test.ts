import {
  ANIMATION_FRAME_INTERVAL_MS,
  AnimationFrameScheduler,
  visibleWidth,
  type Component,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { TitleSweep } from '#/tui/components/messages/running-title';
import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { SkillActivationComponent } from '#/tui/components/messages/skill-activation';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { TranscriptContainer } from '#/tui/components/messages/transcript-container';
import { TranscriptGroupComponent } from '#/tui/components/messages/transcript-group';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import type { TranscriptPresentationOptions } from '#/tui/config';
import { DETACH_HINT_TEXT, FOREGROUND_BASH_HINT_DELAY_MS } from '#/tui/constant/rendering';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
import { mixColors } from '#/tui/theme/color-mix';
import type { ToolCallBlockData, ToolResultBlockData, TranscriptEntry } from '#/tui/types';
import { markTranscriptComponent } from '#/tui/utils/transcript-component-metadata';
import { isToolCallId, TurnTimeline } from '#/tui/utils/turn-timeline';

let id = 0;
const defaultChalkLevel = chalk.level;

function options(overrides: Partial<TranscriptPresentationOptions> = {}): TranscriptPresentationOptions {
  return {
    fullscreen: true,
    toolCallDensity: 'detailed',
    thinking: 'grouped',
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

type FrameSource = Pick<AnimationFrameScheduler, 'requestAnimationFrame' | 'cancelAnimationFrame'>;

function makeContainer(presentation = options(), frames: FrameSource = new AnimationFrameScheduler()) {
  const requestRender = vi.fn();
  const container = new TranscriptContainer(0, 0, {
    requestRender,
    requestAnimationFrame: (callback) => frames.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => {
      frames.cancelAnimationFrame(handle);
    },
  });
  container.setPresentationOptions(presentation);
  return { container, requestRender };
}

function manualFrames(): FrameSource & { run(time: number): void } {
  const requests = new Map<number, (time: number) => void>();
  let lastHandle = 0;
  return {
    requestAnimationFrame: (callback) => {
      requests.set(++lastHandle, callback);
      return lastHandle;
    },
    cancelAnimationFrame: (handle) => {
      requests.delete(handle);
    },
    run: (time) => {
      const due = [...requests.values()];
      requests.clear();
      for (const callback of due) callback(time);
    },
  };
}

function plain(lines: readonly string[]): string {
  return lines.join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function glyphColors(line: string): string[] {
  return [...line.matchAll(/\u001B\[38;2;(\d+);(\d+);(\d+)m([^\u001B]*)/g)].flatMap(([, red, green, blue, text = '']) => {
    const color = `#${[red, green, blue].map((channel) => Number(channel).toString(16).padStart(2, '0')).join('')}`;
    return Array.from(text, () => color);
  });
}

interface GroupView {
  readonly title: string;
  readonly expanded: boolean;
  readonly tail: string | undefined;
  readonly body: readonly string[];
  readonly rows: readonly string[];
  readonly showLess: boolean;
}

function groupView(rendered: readonly string[], last: boolean): GroupView {
  const all = plain(rendered).split('\n').map((line) => line.trimEnd());
  const lines = last ? all.slice(0, -1) : all;
  const gap = lines.indexOf('', 1);
  const body = gap > 0 ? lines.slice(gap + 1) : [];
  return {
    title: lines[1] ?? '',
    expanded: gap > 0,
    tail: last ? all.at(-1) : undefined,
    body,
    rows: body.filter((line) => /^[├└] /.test(line) && line !== '└ Show less'),
    showLess: body.at(-1) === '└ Show less',
  };
}

function groupViews(container: TranscriptContainer, width = 80): GroupView[] {
  container.render(width);
  const children = (container.getRenderedLayout()?.children ?? []).map((entry) => entry.component);
  return children.flatMap((component, index) => component instanceof TranscriptGroupComponent
    ? [groupView(component.render(width), index === children.length - 1)]
    : []);
}

function liveTurn(container: TranscriptContainer): TurnTimeline {
  const timeline = new TurnTimeline();
  container.setTimeline(timeline);
  timeline.turnStarted();
  for (const child of container.children) {
    if (!(child instanceof ToolCallComponent) || !isToolCallId(child.toolCallView.id)) continue;
    timeline.callStarted(child.toolCallView.id, child.toolCallView.name);
    if (child.toolResultView !== undefined) timeline.callResult(child.toolCallView.id);
  }
  return timeline;
}

function workingTurn(container: TranscriptContainer): void {
  liveTurn(container).textDelta();
}

function settle(timeline: TurnTimeline, call: ToolCallComponent, output = 'ok'): void {
  call.setResult({ tool_call_id: call.toolCallView.id, output, is_error: false }, { known: true, ms: 1_000 });
  if (isToolCallId(call.toolCallView.id)) timeline.callResult(call.toolCallView.id);
}

function openLiveThought(container: TranscriptContainer, width = 80, presentation = options()): void {
  container.setPresentationOptions({ ...presentation, thinking: 'ungrouped' });
  click(container, plain(container.render(width)).split('\n').length - 1, 0, width);
  container.setPresentationOptions(presentation);
}

function onlyGroup(container: TranscriptContainer, width = 80): GroupView {
  const [group, ...rest] = groupViews(container, width);
  if (group === undefined || rest.length > 0) throw new Error('expected exactly one group');
  return group;
}

function lineOf(container: TranscriptContainer, text: string): number {
  const index = plain(container.render(80)).split('\n').findIndex((line) => line.includes(text));
  if (index < 0) throw new Error(`no line contains ${text}`);
  return index;
}

function host(viewportRows?: number) {
  return {
    withScrollAnchor: vi.fn((toggle: () => void) => {
      toggle();
    }),
    withBottomAnchor: vi.fn((toggle: () => void, _removedLines: number) => {
      toggle();
    }),
    viewportRows: () => viewportRows,
    track: vi.fn(),
    foldingChanged: vi.fn(),
  };
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
}

function click(container: TranscriptContainer, y: number, x = 0, width = 80): TuiMouseDispatchResult | undefined {
  const lines = container.render(width);
  const event: TuiMouseEvent = {
    type: 'click',
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
  return container.handleMouse(event);
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
  it('renders collapsed and expanded groups without rendering member cards', () => {
    const { container } = makeContainer();
    const thinking = thought();
    const read = tool('Read', { path: '/work/a.ts' });
    const memberRender = vi.spyOn(read, 'render');
    container.addChild(thinking);
    container.addChild(read);

    expect(onlyGroup(container)).toMatchObject({
      title: '  Thought for 3s, read 1 file',
      expanded: false,
      tail: '',
    });

    container.toggleGroup(thinking);
    expect(onlyGroup(container)).toMatchObject({
      title: '● Thought for 3s, read 1 file',
      expanded: true,
      rows: ['├ Thought for 3s', '└ Read a.ts'],
      showLess: false,
    });
    expect(plain(container.render(80))).not.toContain('Used Read');
    expect(memberRender).not.toHaveBeenCalled();
  });

  it('keeps regular thinking previews unchanged by grouping preferences', () => {
    const { container } = makeContainer(options({ fullscreen: false, thinking: 'grouped' }));
    const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive', true, 'live');
    container.addChild(thinking);

    const preview = plain(container.render(80));
    expect(preview).not.toContain('one');
    expect(preview).toContain('four');
    expect(preview).toContain('five');

    container.setPresentationOptions(options({ fullscreen: false, thinking: 'ungrouped' }));
    expect(plain(container.render(80))).toBe(preview);
  });

  it('keeps thinking as a visible boundary when grouping is off', () => {
    const { container } = makeContainer(options({ thinking: 'ungrouped' }));
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read', { path: '/work/a.ts' }));

    const text = plain(container.render(80));
    expect(text).toContain('reasoning');
    expect(onlyGroup(container).title).toBe('  Read a.ts');
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

  it('draws one row per member with the stats each row keeps', () => {
    chalk.level = 3;
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Grep', { pattern: 'needle' }, {
      tool_call_id: 'grep-stat',
      output: 'src/a.ts\nsrc/b.ts',
      is_error: false,
    }));
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(tool('Edit', { path: '/work/a.ts', old_string: 'one', new_string: 'two\nthree' }));
    container.addChild(tool('Write', { path: '/work/b.ts', content: 'a\nb\nc\n' }));
    container.addChild(tool('Bash', { command: 'pnpm test' }, {
      tool_call_id: 'bash-stat',
      output: lines(40),
      is_error: false,
    }));
    container.toggleGroup(thinking);

    const group = onlyGroup(container);
    expect(group.title).toBe('● Thought for 3s, read 1 file, searched 1 pattern, ran 1 command, edited … +5 -1');
    expect(group.rows).toEqual([
      '├ Thought for 3s',
      '├ Search "needle" · 2 files',
      '├ Read a.ts',
      '├ Edit a.ts · +2 -1',
      '├ Write b.ts · +3',
      '└ Bash pnpm test',
    ]);
    const raw = container.render(80).join('\n');
    expect(raw).toContain(`${currentTheme.boldFg('textDim', 'Read')} ${currentTheme.dim('a.ts')}`);
    expect(raw).toContain(`${currentTheme.boldFg('textDim', 'Thought')} ${currentTheme.dim('for 3s')}`);
    expect(raw).toContain(`${currentTheme.dim(' ·')} ${currentTheme.fg('diffAdded', '+2')} ${currentTheme.fg('diffRemoved', '-1')}`);
    expect(raw).toContain(`${currentTheme.dim(' ·')} ${currentTheme.fg('diffAdded', '+3')}`);
  });

  it('marks failed and interrupted rows instead of showing their stats', () => {
    chalk.level = 3;
    const { container } = makeContainer();
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read', { path: '/work/missing.ts' }, {
      tool_call_id: 'read-failed',
      output: 'File not found',
      is_error: true,
    }));
    container.addChild(tool('Grep', { pattern: 'needle' }, {
      tool_call_id: 'grep-interrupted',
      output: 'Interrupted by user',
      is_error: true,
    }));
    container.toggleGroup(thinking);

    expect(onlyGroup(container).rows).toEqual([
      '├ Thought for 3s',
      '├ Read missing.ts · failed',
      '└ Search "needle" · interrupted',
    ]);
    const raw = container.render(80).join('\n');
    expect(raw).toContain(`${currentTheme.boldFg('error', 'Read')} ${currentTheme.dim('missing.ts')}${currentTheme.dim(' · failed')}`);
    expect(raw).toContain(`${currentTheme.boldFg('textDim', 'Search')} `);
  });

  it('counts seconds on a running row and swaps in the stat when it finishes', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { container } = makeContainer();
    const read = tool('Read', { path: '/work/a.ts' });
    const grep = runningTool('Grep', { pattern: 'needle' });
    container.addChild(read);
    container.addChild(grep);
    liveTurn(container);
    container.toggleGroup(read);

    expect(onlyGroup(container).rows).toEqual(['├ Read a.ts', '└ Search "needle"']);

    vi.advanceTimersByTime(2_000);
    expect(onlyGroup(container).rows).toEqual(['├ Read a.ts', '└ Search "needle" · 2s']);
    expect(container.render(80).join('\n')).toContain(currentTheme.dim(' · 2s'));

    grep.setResult({ tool_call_id: grep.toolCallView.id, output: 'src/a.ts', is_error: false }, { known: true, ms: 2_000 });
    expect(onlyGroup(container).rows).toEqual(['├ Read a.ts', '└ Search "needle" · 1 file']);
    container.clear();
  });

  it('opens a row in place, drops the repeated command, and closes it from the detail', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const first = tool('Bash', { command: 'cat a.txt' }, {
      tool_call_id: 'bash-a',
      output: lines(40),
      is_error: false,
    });
    const second = tool('Bash', { command: 'cat b.txt' });
    container.addChild(first);
    container.addChild(second);
    container.toggleGroup(first);

    click(container, lineOf(container, 'Bash cat a.txt'));

    expect(first.isExpanded()).toBe(true);
    const group = onlyGroup(container);
    expect(group.title).toBe('● Ran 2 commands');
    expect(group.rows).toEqual(['├ Bash cat a.txt', '└ Bash cat b.txt']);
    expect(group.body[1]).toBe('│   line 1');
    expect(group.body).toContain('│   line 40');
    expect(group.body.some((line) => line.includes('$ cat a.txt'))).toBe(false);

    click(container, lineOf(container, 'line 7'));
    expect(first.isExpanded()).toBe(false);
    expect(onlyGroup(container).body).toEqual(['├ Bash cat a.txt', '└ Bash cat b.txt']);
  });

  it('wraps the whole command of an opened Bash row under its first word', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const heredoc = tool('Bash', { command: "cat <<'EOF' > a.txt\nhello\nEOF" }, {
      tool_call_id: 'bash-heredoc',
      output: 'written',
      is_error: false,
    });
    container.addChild(heredoc);
    container.addChild(tool('Bash', { command: 'ls' }));
    container.toggleGroup(heredoc);

    expect(onlyGroup(container).rows[0]).toBe("├ Bash cat <<'EOF' > a.txt…");
    click(container, lineOf(container, 'Bash cat'));

    expect(onlyGroup(container).body.slice(0, 4)).toEqual([
      "├ Bash cat <<'EOF' > a.txt",
      '│      hello',
      '│      EOF',
      '│   written',
    ]);
  });

  it('drops the Edit diff header and the search samples from opened rows', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const grep = tool('Grep', { pattern: 'needle' }, {
      tool_call_id: 'grep-open',
      output: 'src/a.ts\nsrc/b.ts',
      is_error: false,
    });
    const edit = tool('Edit', { path: '/work/a.ts', old_string: 'one', new_string: 'two' }, {
      tool_call_id: 'edit-open',
      output: 'Replaced 1 occurrence in /work/a.ts',
      is_error: false,
    });
    container.addChild(grep);
    container.addChild(edit);
    container.toggleGroup(grep);
    click(container, lineOf(container, 'Search "needle"'));
    click(container, lineOf(container, 'Edit a.ts'));

    const body = onlyGroup(container).body;
    expect(body).toContain('│     src/a.ts');
    expect(body).toContain('│     src/b.ts');
    expect(body.some((line) => line.includes('src/a.ts, src/b.ts'))).toBe(false);
    expect(body.some((line) => line.includes('1 - one'))).toBe(true);
    expect(body.some((line) => line.includes('/work/a.ts'))).toBe(false);

    edit.setExpanded(false);
    grep.setExpanded(false);
    const card = plain(edit.render(80));
    expect(card).toContain('/work/a.ts');
  });

  it('shows Show less only when the expanded group is taller than the viewport', () => {
    const { container } = makeContainer();
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.toggleGroup(thinking);

    expect(onlyGroup(container).showLess).toBe(false);
    container.setHost(host(40));
    expect(onlyGroup(container).showLess).toBe(false);

    container.setHost(host(4));
    const group = onlyGroup(container);
    expect(group.showLess).toBe(true);
    expect(group.rows).toEqual(['├ Thought for 3s', '├ Read a.ts']);
  });

  it('titles a finished one-item group with the item and opens its detail from the title', () => {
    vi.useFakeTimers();
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const bash = runningTool('Bash', { command: 'ls -la' });
    container.addChild(bash);
    const timeline = liveTurn(container);

    expect(onlyGroup(container)).toMatchObject({ title: '  Running commands', tail: '' });
    vi.advanceTimersByTime(200);
    expect(onlyGroup(container)).toMatchObject({ title: '  Running 1 command', tail: '' });

    click(container, 1);
    expect(onlyGroup(container)).toMatchObject({ title: '● Running 1 command', expanded: true, rows: [] });
    expect(onlyGroup(container).body[0]).toBe('  Bash ls -la');
    expect(bash.isExpanded()).toBe(true);
    click(container, 1);
    expect(bash.isExpanded()).toBe(false);

    settle(timeline, bash, lines(3));
    expect(onlyGroup(container)).toMatchObject({ title: '  $ ls -la', expanded: false, tail: '' });

    click(container, 1);
    expect(onlyGroup(container)).toMatchObject({
      title: '● $ ls -la',
      expanded: true,
      body: ['  line 1', '  line 2', '  line 3'],
    });
    click(container, lineOf(container, 'line 2'));
    expect(onlyGroup(container)).toMatchObject({ title: '  $ ls -la', expanded: false });
    expect(bash.isExpanded()).toBe(false);
    container.clear();
  });

  it('wraps an expanded one-item title and shows a thought in full', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'ungrouped' }));
    const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive\nsix', true, 'finalized');
    thinking.finalize({ known: true, ms: 2_000 });
    container.addChild(thinking);

    expect(onlyGroup(container).title).toBe('  Thought for 2s');
    click(container, 1);
    expect(onlyGroup(container)).toMatchObject({
      title: '● Thought for 2s',
      body: ['  one', '  two', '  three', '  four', '  five', '  six'],
    });
  });

  it('wraps a long expanded one-item title with continuation lines at column 3', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const command = 'pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/components/messages --reporter verbose';
    const bash = tool('Bash', { command }, { tool_call_id: 'long-bash', output: 'ok', is_error: false });
    container.addChild(bash);

    const collapsed = groupViews(container, 40);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.title).toMatch(/^  \$ /);
    expect(collapsed[0]?.title).not.toContain('--reporter verbose');
    expect(collapsed[0]?.expanded).toBe(false);

    container.toggleGroup(bash);
    const lines = plain(container.render(40)).split('\n').map((line) => line.trimEnd());
    const start = lines.findIndex((line) => line.startsWith('● $ '));
    const gap = lines.indexOf('', start);
    const title = lines.slice(start, gap);
    expect(title.length).toBeGreaterThan(1);
    for (const line of title.slice(1)) expect(line).toMatch(/^ {2}\S/);
    expect(title.join(' ').replaceAll(/\s+/g, ' ')).toContain('--reporter verbose');
    expect(lines.slice(gap + 1).join('\n')).toContain('ok');
  });

  it('redraws from its own timer while a command runs in an expanded group of an idle turn', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    const { container, requestRender } = makeContainer();
    const timeline = new TurnTimeline();
    container.setTimeline(timeline);
    const read = tool('Read', { path: '/work/a.ts' });
    const bash = runningTool('Bash', { command: 'sleep 30' });
    container.addChild(read);
    container.addChild(bash);
    if (isToolCallId(bash.toolCallView.id)) timeline.callStarted(bash.toolCallView.id, 'Bash');
    container.toggleGroup(read);
    container.render(80);
    requestRender.mockClear();

    vi.advanceTimersByTime(2_000);

    expect(requestRender).toHaveBeenCalled();
    expect(container.render(80).join('\n')).toContain(currentTheme.dim(' · 2s'));

    settle(timeline, bash, 'done');
    container.render(80);
    vi.advanceTimersByTime(5_000);
    requestRender.mockClear();
    vi.advanceTimersByTime(5_000);
    expect(requestRender).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    container.clear();
  });

  it('keeps a one-item group open with its row open when a second member joins', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const first = tool('Bash', { command: 'cat a.txt' }, {
      tool_call_id: 'joined-a',
      output: lines(2),
      is_error: false,
    });
    container.addChild(first);
    click(container, 1);
    expect(first.isExpanded()).toBe(true);

    container.addChild(tool('Bash', { command: 'cat b.txt' }));

    expect(onlyGroup(container)).toMatchObject({
      title: '● Ran 2 commands',
      expanded: true,
      body: ['├ Bash cat a.txt', '│   line 1', '│   line 2', '└ Bash cat b.txt'],
    });
  });

  it('leaves failed and interrupted edits out of the title diff total', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const ok = tool('Edit', { path: '/work/ok.ts', old_string: 'a', new_string: 'b' });
    container.addChild(ok);
    container.addChild(tool('Edit', { path: '/work/bad.ts', old_string: 'a', new_string: 'b\nc' }, {
      tool_call_id: 'edit-failed',
      output: 'no match',
      is_error: true,
    }));
    container.addChild(tool('Edit', { path: '/work/stop.ts', old_string: 'a', new_string: 'b\nc\nd' }, {
      tool_call_id: 'edit-interrupted',
      output: 'Interrupted by user',
      is_error: true,
    }));
    container.toggleGroup(ok);

    const view = onlyGroup(container);
    expect(view.title).toBe('● Edited 3 files +1 -1 · 1 failed · 1 interrupted');
    expect(view.rows).toEqual([
      '├ Edit ok.ts · +1 -1',
      '├ Edit bad.ts · failed',
      '└ Edit stop.ts · interrupted',
    ]);
  });

  it('keeps diff and failure tails at 70 columns', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
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

  it('sweeps a light title on its running gray, then fades it back to textDim and stops requesting frames', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    const previousPalette = currentTheme.palette;
    currentTheme.setPalette(lightColors);
    currentTheme.setTerminalBackground('#FFFFFF');
    try {
      const { container, requestRender } = makeContainer();
      container.addChild(thought());
      container.addChild(tool('Read', { path: '/work/a.ts' }));
      container.addChild(runningTool('Grep'));
      const timeline = liveTurn(container);

      const initial = container.render(80);
      expect(plain(initial)).toContain('  Thought for 3s');
      expect(plain(initial)).not.toContain('●');
      expect(new Set(glyphColors(initial[1] ?? ''))).toEqual(new Set(['#767676']));
      requestRender.mockClear();
      vi.advanceTimersByTime(1_200);
      const next = container.render(80);
      expect(requestRender).toHaveBeenCalled();
      expect(next).not.toEqual(initial);

      timeline.turnEnded();
      container.render(80);
      for (let frame = 0; frame < 40; frame++) {
        vi.advanceTimersByTime(50);
        container.render(80);
      }
      requestRender.mockClear();
      vi.advanceTimersByTime(1_000);
      expect(requestRender).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(new Set(glyphColors(container.render(80)[1] ?? ''))).toEqual(new Set([lightColors.textDim.toLowerCase()]));
      container.clear();
    } finally {
      currentTheme.setPalette(previousPalette);
    }
  });

  it('fades the highlight in and out by elapsed time whatever the animation frame length', () => {
    const turnEndsAt = 1_200;
    const intensityAt = (time: number, frameMs: number): number => {
      // Every frame length also gets a frame when the turn ends and one at the sampled time, so the
      // three runs turn off at the same moment and are read at the same moment.
      const frames = new Set([time]);
      for (let frame = frameMs; frame < time; frame += frameMs) frames.add(frame);
      if (turnEndsAt < time) frames.add(turnEndsAt);
      const sweep = new TitleSweep();
      sweep.start(0, false);
      for (const frame of [...frames].toSorted((left, right) => left - right)) {
        sweep.advance(frame, 20, frame <= turnEndsAt);
      }
      return sweep.intensity;
    };

    for (let time = 20; time <= 2 * turnEndsAt; time += 20) {
      const levels = [120, 50, 33].map((frameMs) => intensityAt(time, frameMs));
      expect(Math.max(...levels) - Math.min(...levels), `${String(time)} ms`).toBeLessThanOrEqual(0.02);
    }
  });

  it('fades the highlight out within a second of the turn ending on slow animation frames', () => {
    const fadeOutTime = (frameMs: number): number => {
      const sweep = new TitleSweep();
      sweep.start(0, true);
      let time = 0;
      while (sweep.intensity > 0) {
        time += frameMs;
        sweep.advance(time, 20, false);
      }
      return time;
    };

    expect(fadeOutTime(1_000)).toBe(1_000);
    expect(fadeOutTime(500)).toBe(1_000);
    expect(fadeOutTime(120)).toBe(1_080);
  });

  it.each([
    { theme: 'dark', palette: darkColors, background: '#000000', rest: darkColors.textDim.toLowerCase() },
    { theme: 'dark', palette: darkColors, background: '#1E1E1E', rest: darkColors.textDim.toLowerCase() },
    { theme: 'light', palette: lightColors, background: '#FFFFFF', rest: '#767676' },
    { theme: 'light', palette: lightColors, background: '#F0F0F0', rest: '#6d6d6d' },
    { theme: 'custom light', palette: { ...lightColors, text: '#333333' }, background: '#FFFFFF', rest: '#767676' },
  ])('lights a running $theme title on $background from its rest color up to text', ({ palette, background, rest }) => {
    chalk.level = 3;
    const previousPalette = currentTheme.palette;
    currentTheme.setPalette(palette);
    currentTheme.setTerminalBackground(background);
    try {
      const title = 'Read 3 files, ran 2 commands';
      const sweep = new TitleSweep();
      sweep.start(0, true);
      const colorsAt = (time: number): string[] => {
        sweep.advance(time, 2 + title.length, true);
        return glyphColors(sweep.painter()(title, 2));
      };

      expect(colorsAt(0)).toEqual(Array.from(title, () => rest));
      const crossing = colorsAt(1_000);
      expect(crossing[2]).toBe(palette.text.toLowerCase());
      expect(new Set(crossing.slice(0, 7))).not.toContain(rest);
      expect(crossing.slice(8)).toEqual(Array.from(title.slice(8), () => rest));
    } finally {
      currentTheme.setPalette(previousPalette);
    }
  });

  function sweptFramesOverSixSeconds(changeTitleAt?: number) {
    chalk.level = 3;
    vi.useFakeTimers();
    const frames = manualFrames();
    const { container, requestRender } = makeContainer(options(), frames);
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    workingTurn(container);
    container.render(100);
    const swept: number[] = [];
    let redrawsWhileWaiting = 0;
    for (let elapsed = ANIMATION_FRAME_INTERVAL_MS; elapsed <= 6_480; elapsed += ANIMATION_FRAME_INTERVAL_MS) {
      vi.advanceTimersByTime(ANIMATION_FRAME_INTERVAL_MS);
      if (elapsed === changeTitleAt) container.addChild(tool('Read', { path: '/work/b.ts' }));
      requestRender.mockClear();
      frames.run(performance.now());
      if (elapsed >= 2_400 && elapsed < 4_600) redrawsWhileWaiting += requestRender.mock.calls.length;
      if (new Set(glyphColors(container.render(100)[1] ?? '')).size > 1) swept.push(elapsed);
    }
    const title = onlyGroup(container, 100).title;
    container.clear();
    return { swept, redrawsWhileWaiting, title };
  }

  it('waits 600 ms before the first sweep and holds the rest color until the next 4-second cycle', () => {
    const { swept, redrawsWhileWaiting, title } = sweptFramesOverSixSeconds();

    expect(title).toBe('  Read a.ts');
    expect(swept.some((at) => at < 2_200)).toBe(true);
    expect(swept.some((at) => at > 4_600)).toBe(true);
    expect(swept.filter((at) => at <= 600 || (at >= 2_200 && at <= 4_600) || at >= 6_200)).toEqual([]);
    expect(redrawsWhileWaiting).toBe(0);
  });

  it('keeps the sweep rhythm when the title changes in the middle of a sweep', () => {
    const { swept, redrawsWhileWaiting, title } = sweptFramesOverSixSeconds(1_200);

    expect(title).toBe('  Read 2 files');
    expect(swept.some((at) => at < 1_200)).toBe(true);
    expect(swept.some((at) => at > 1_200 && at < 2_200)).toBe(true);
    expect(swept.some((at) => at > 4_600)).toBe(true);
    expect(swept.filter((at) => at <= 600 || (at >= 2_200 && at <= 4_600) || at >= 6_200)).toEqual([]);
    expect(redrawsWhileWaiting).toBe(0);
  });

  it('sweeps every line of an opened multi-line title and keeps it still between sweeps', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    const frames = manualFrames();
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }), frames);
    const heredoc = tool('Bash', { command: "cat <<'EOF' > notes.txt\nhello from the second line\nEOF" }, {
      tool_call_id: 'bash-multi-line-sweep',
      output: 'written',
      is_error: false,
    });
    container.addChild(heredoc);
    workingTurn(container);
    container.toggleGroup(heredoc);
    const titleColors = (): string[] => {
      const rendered = container.render(100);
      const lines = plain(rendered).split('\n').map((line) => line.trimEnd());
      const start = lines.findIndex((line) => line.startsWith('● $ '));
      return rendered.slice(start, lines.indexOf('', start)).map((line) => glyphColors(line).join(' '));
    };
    container.render(100);
    let still: string[] = [];
    const sweptLines = new Set<number>();
    const moving: number[] = [];
    for (let elapsed = ANIMATION_FRAME_INTERVAL_MS; elapsed <= 6_480; elapsed += ANIMATION_FRAME_INTERVAL_MS) {
      vi.advanceTimersByTime(ANIMATION_FRAME_INTERVAL_MS);
      frames.run(performance.now());
      const colors = titleColors();
      if (elapsed === 480) still = colors;
      if (elapsed <= 480) continue;
      for (const [index, line] of colors.entries()) {
        if (line !== still[index]) sweptLines.add(index);
      }
      if (colors.join('\n') !== still.join('\n')) moving.push(elapsed);
    }
    container.clear();

    expect(still).toHaveLength(3);
    expect([...sweptLines].toSorted()).toEqual([0, 1, 2]);
    expect(moving.filter((at) => at <= 600 || (at >= 2_200 && at <= 4_600) || at >= 6_200)).toEqual([]);
  });

  function sweepFrames(container: TranscriptContainer, requestRender: ReturnType<typeof vi.fn>) {
    const frames: { readonly renders: number; readonly drawn: string }[] = [];
    for (let frame = 0; frame < 24; frame++) {
      requestRender.mockClear();
      vi.advanceTimersByTime(ANIMATION_FRAME_INTERVAL_MS / 2);
      const typed = container.render(100).join('\n');
      vi.advanceTimersByTime(ANIMATION_FRAME_INTERVAL_MS / 4);
      expect(container.render(100).join('\n')).toBe(typed);
      vi.advanceTimersByTime(ANIMATION_FRAME_INTERVAL_MS / 4);
      container.invalidate();
      frames.push({ renders: requestRender.mock.calls.length, drawn: container.render(100).join('\n') });
    }
    expect(frames.every((frame) => frame.renders <= 1)).toBe(true);
    expect(new Set(frames.map((frame) => frame.drawn)).size).toBeGreaterThan(3);
    for (const [index, frame] of frames.entries()) {
      if (index > 0 && frame.renders === 0) expect(frame.drawn).toBe(frames[index - 1]?.drawn);
    }
    return frames;
  }

  it('moves the highlight only on animation frames and skips renders while it waits off the title', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    const { container, requestRender } = makeContainer();
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    workingTurn(container);
    container.render(100);

    const frames = sweepFrames(container, requestRender);
    expect(frames.slice(1).some((frame) => frame.renders === 0)).toBe(true);
    container.clear();
  });

  it('skips renders off a title that got shorter than one drawn before', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    const { container, requestRender } = makeContainer(options({ toolCallDensity: 'compact' }));
    container.addChild(tool('Bash', { command: `echo ${'x'.repeat(90)}` }));
    workingTurn(container);
    container.render(100);
    container.addChild(tool('Bash', { command: 'pwd' }));
    expect(onlyGroup(container, 100).title).toBe('  Ran 2 commands');

    const frames = sweepFrames(container, requestRender);
    expect(frames.slice(1).some((frame) => frame.renders === 0)).toBe(true);
    container.clear();
  });

  it('skips renders off a one-line title again after its wrapped command title closes', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    const { container, requestRender } = makeContainer(options({ toolCallDensity: 'compact' }));
    const bash = tool('Bash', { command: `echo first\necho ${'x'.repeat(80)}` });
    container.addChild(bash);
    workingTurn(container);
    container.toggleGroup(bash);
    expect(plain(container.render(100))).toContain('x'.repeat(40));
    container.toggleGroup(bash);
    expect(onlyGroup(container, 100).title).toBe('  $ echo first…');

    const frames = sweepFrames(container, requestRender);
    expect(frames.slice(1).some((frame) => frame.renders === 0)).toBe(true);
    container.clear();
  });

  it('keeps redrawing while the highlight crosses the wrapped lines of an opened command title', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    const { container, requestRender } = makeContainer(options({ toolCallDensity: 'compact' }));
    const bash = tool('Bash', { command: 'echo first\necho a second line' });
    container.addChild(bash);
    workingTurn(container);
    container.toggleGroup(bash);
    expect(plain(container.render(100))).toContain('echo a second line');

    sweepFrames(container, requestRender);
    container.clear();
  });

  it('draws the tail as the last line of the last group, under Show less when expanded', () => {
    chalk.level = 3;
    vi.useFakeTimers();
    currentTheme.setTerminalBackground('#1E1E1E');
    const { container } = makeContainer();
    const read = runningTool('Read', { path: '/work/a.ts' });
    const bash = runningTool('Bash', { command: 'sleep 5' });
    container.addChild(read);
    container.addChild(bash);
    const timeline = liveTurn(container);

    expect(onlyGroup(container, 100).tail).toBe('');
    vi.advanceTimersByTime(1_000);
    expect(onlyGroup(container, 100)).toMatchObject({
      title: '  Reading 1 file, running 1 command',
      tail: '  └ Reading a.ts; running sleep 5',
    });
    vi.advanceTimersByTime(1_000);
    const timed = container.render(100);
    expect(onlyGroup(container, 100).tail).toBe('  └ Reading a.ts; running sleep 5 · 2s');
    expect(timed.join('\n')).toContain(currentTheme.dim('  └ Reading a.ts; running sleep 5 · 2s'));
    expect(onlyGroup(container, 30).tail).toBe('  └ Reading a.ts; runni… · 2s');

    settle(timeline, read);
    settle(timeline, bash);
    vi.advanceTimersByTime(1_000);
    expect(onlyGroup(container, 100).tail).toBe('  └ Waiting for response');

    click(container, 2);
    const expanded = container.render(100);
    expect(onlyGroup(container, 100)).toMatchObject({
      expanded: true,
      rows: ['├ Read a.ts', '└ Bash sleep 5'],
      tail: '  └ Waiting for response',
    });
    const guideColor = mixColors(currentTheme.color('textDim'), '#1E1E1E', 0.60);
    expect(expanded.join('\n')).toContain(chalk.hex(guideColor)('├ '));
    expect(expanded.join('\n')).toContain(chalk.hex(guideColor)('└ '));
    expect(click(container, plain(expanded).split('\n').length - 1)).toBeUndefined();

    container.toggleGroup(read);
    timeline.turnEnded();
    expect(onlyGroup(container, 100).tail).toBe('');
    container.clear();
  });

  it('draws the Show less row in the textDim color and follows theme changes', () => {
    chalk.level = 3;
    const previousPalette = currentTheme.palette;
    currentTheme.setTerminalBackground('#FFFFFF');
    const { container: group } = makeContainer();
    group.setHost(host(2));
    const read = runningTool('Read', { path: '/work/a.ts' });
    group.addChild(read);
    group.toggleGroup(read);
    group.render(100);

    try {
      currentTheme.setPalette(lightColors);
      expect(group.render(100).join('\n')).toContain(chalk.hex(lightColors.textDim)('Show less'));

      currentTheme.setPalette(darkColors);
      expect(group.render(100).join('\n')).toContain(chalk.hex(darkColors.textDim)('Show less'));

      currentTheme.setPalette(lightColors);
      currentTheme.setTerminalBackground('#FAFBFC');
      group.toggleGroup(read);
      expect(group.render(100).join('\n')).toContain(currentTheme.fg('textDim', 'Read a.ts'));
    } finally {
      currentTheme.setPalette(previousPalette);
      group.clear();
    }
  });

  it('recolors an opened row detail when the theme changes', () => {
    chalk.level = 3;
    const previousPalette = currentTheme.palette;
    const { container } = makeContainer();
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.toggleToolOutputExpansion();
    const lightDim = chalk.hex(lightColors.textDim)('reasoning').split('reasoning')[0] ?? '';

    try {
      currentTheme.setPalette(darkColors);
      container.invalidate();
      expect(container.render(80).find((line) => line.includes('reasoning'))).not.toContain(lightDim);

      currentTheme.setPalette(lightColors);
      container.invalidate();
      expect(container.render(80).find((line) => line.includes('reasoning'))).toContain(lightDim);
    } finally {
      currentTheme.setPalette(previousPalette);
    }
  });

  it('streams a live thought into the tail of its group and holds it briefly once written', () => {
    vi.useFakeTimers();
    const { container } = makeContainer();
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    const thinking = new ThinkingComponent('reasoning', true, 'live');
    container.addChild(thinking);
    const timeline = liveTurn(container);
    timeline.thinkingDelta('Check the layout');

    expect(onlyGroup(container, 100)).toMatchObject({ title: '  Thinking, read 1 file', tail: '  └ Check the layout' });

    thinking.finalize({ known: true, ms: 100 });
    timeline.outputEnded();
    expect(onlyGroup(container, 100)).toMatchObject({
      title: '  Thought for 1s, read 1 file',
      tail: '  └ Check the layout',
    });
    vi.advanceTimersByTime(2_000);
    expect(onlyGroup(container, 100).tail).toBe('  └ Waiting for response · 2s');
    container.clear();
  });

  it.each([
    [120, 240],
    [100, 200],
    [50, 150],
  ])('changes the thinking tail on %i ms frames every %i ms, at least 150 ms apart', (frameMs, gap) => {
    vi.useFakeTimers();
    const frames = manualFrames();
    const { container, requestRender } = makeContainer(options(), frames);
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(new ThinkingComponent('reasoning', true, 'live'));
    const timeline = liveTurn(container);
    timeline.thinkingDelta('Idea 0');
    const changes = [{ at: 0, tail: onlyGroup(container, 100).tail }];

    for (let elapsed = 10; elapsed <= 1_200; elapsed += 10) {
      vi.advanceTimersByTime(10);
      timeline.thinkingDelta(`\n\nIdea ${String(elapsed)}`);
      if (elapsed % frameMs !== 0) continue;
      requestRender.mockClear();
      frames.run(performance.now());
      if (requestRender.mock.calls.length === 0) continue;
      const { tail } = onlyGroup(container, 100);
      if (tail !== changes.at(-1)?.tail) changes.push({ at: elapsed, tail });
    }

    const gaps = changes.slice(1).map((change, index) => change.at - (changes[index]?.at ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(150);
    expect(changes).toEqual(Array.from({ length: Math.floor(1_200 / gap) + 1 }, (_, index) => ({
      at: index * gap,
      tail: `  └ Idea ${String(index * gap)}`,
    })));
    container.clear();
  });

  it.each([120, 100, 50])(
    'keeps thinking tail changes 150 ms apart on %i ms frames when renders trail their frames or fall between them',
    (frameMs) => {
      const renderLagMs = 3;
      const streamRenderMs = 70;
      vi.useFakeTimers();
      const frames = manualFrames();
      const { container } = makeContainer(options(), frames);
      container.addChild(tool('Read', { path: '/work/a.ts' }));
      container.addChild(new ThinkingComponent('reasoning', true, 'live'));
      const timeline = liveTurn(container);
      const changes: number[] = [];
      let shown: string | undefined;

      for (let elapsed = 0; elapsed <= 3_000; elapsed++) {
        if (elapsed > 0) vi.advanceTimersByTime(1);
        if (elapsed % 10 === 0) timeline.thinkingDelta(`\n\nIdea ${String(elapsed)}`);
        if (elapsed % frameMs === 0) frames.run(performance.now());
        if (elapsed % frameMs !== renderLagMs && elapsed % streamRenderMs !== 0) continue;
        const { tail } = onlyGroup(container, 100);
        if (tail === shown) continue;
        changes.push(elapsed);
        shown = tail;
      }

      const gaps = changes.slice(1).map((at, index) => at - (changes[index] ?? 0));
      expect(gaps.length).toBeGreaterThan(10);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(150);
      container.clear();
    },
  );

  it('cuts a held thinking tail to a new width at once', () => {
    vi.useFakeTimers();
    const { container } = makeContainer();
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(new ThinkingComponent('reasoning', true, 'live'));
    const timeline = liveTurn(container);
    timeline.thinkingDelta('Check the layout of every group');
    expect(onlyGroup(container, 100).tail).toBe('  └ Check the layout of every group');

    vi.advanceTimersByTime(50);
    timeline.thinkingDelta('\n\nThen the tail');
    expect(onlyGroup(container, 24).tail).toBe('  └ Check the layout of…');
    vi.advanceTimersByTime(100);
    expect(onlyGroup(container, 24).tail).toBe('  └ Then the tail');
    container.clear();
  });

  it('keeps a slow Bash in the tail after a finished thought', () => {
    vi.useFakeTimers();
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    container.addChild(runningTool('Bash', { command: 'sleep 5' }));
    container.addChild(thought());
    liveTurn(container);
    vi.advanceTimersByTime(1_000);

    expect(onlyGroup(container, 100).tail).toBe('  └ Running sleep 5');
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
  ])('titles a finished %s call with its item text', (name, args, expected) => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    container.addChild(runningTool(name, args));

    expect(onlyGroup(container, 100).title).toBe(`  ${expected}`);
    container.clear();
  });

  it('keeps a clicked streaming thought outside after it finishes and restores it on collapse', () => {
    const { container } = makeContainer();
    const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive', true, 'live');
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(thinking);

    expect(onlyGroup(container).title).toBe('  Thinking, read 1 file');
    openLiveThought(container);
    expect(thinking.isExpanded()).toBe(true);

    thinking.finalize({ known: true, ms: 3000 });
    const finished = plain(container.render(80));
    expect(onlyGroup(container).title).toBe('  Read a.ts');
    expect(finished).toContain('  Thought for 3s');
    expect(finished).toContain('one');

    click(container, plain(container.render(80)).split('\n').length - 1);
    expect(thinking.isExpanded()).toBe(false);
    expect(onlyGroup(container).title).toBe('  Thought for 3s, read 1 file');
  });

  it.each([
    ['  Thought for 5s', { known: true, ms: 5000 }],
    ['  Thought', { known: false }],
  ] as const)('titles a finished opened thought "%s" exactly like its one-item group', (title, elapsed) => {
    chalk.level = 3;
    const { container } = makeContainer();
    const thinking = new ThinkingComponent(lines(5), true, 'live');
    container.addChild(thinking);
    openLiveThought(container);

    thinking.finalize(elapsed);
    const opened = container.render(80);
    const narrow = container.render(12);
    expect(plain(opened).split('\n').map((line) => line.trimEnd())).toEqual([
      '',
      title,
      '  line 1',
      '  line 2',
      '  line 3',
      '  line 4',
      '  line 5',
    ]);

    click(container, 1);
    expect(onlyGroup(container)).toMatchObject({ title, expanded: false });
    expect(container.render(80)[1]).toBe(opened[1]);
    expect(container.render(12)[1]).toBe(narrow[1]);
  });

  it.each([
    ['three lines', 'one\ntwo\nthree', 80],
    ['one line', 'one two three four five six seven', 12],
  ])('folds a finished opened thought of %s back into its group on click', (_name, text, openWidth) => {
    const { container } = makeContainer();
    const thinking = new ThinkingComponent(text, true, 'live');
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(thinking);
    openLiveThought(container, openWidth);
    expect(thinking.isExpanded()).toBe(true);

    thinking.finalize({ known: true, ms: 3000 });
    expect(onlyGroup(container).title).toBe('  Read a.ts');
    click(container, lineOf(container, 'three'));

    expect(onlyGroup(container).title).toBe('  Thought for 3s, read 1 file');
    expect(plain(container.render(80))).not.toContain('three');
  });

  it('folds an opened thought back on click after Ctrl+O passes over its old turn', () => {
    const { container } = makeContainer();
    const thinking = new ThinkingComponent(lines(5), true, 'live');
    container.addChild(thinking);
    openLiveThought(container);
    thinking.finalize({ known: true, ms: 3000 });
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    for (const text of ['one', 'two', 'three', 'four']) container.addChild(user(text));
    container.toggleToolOutputExpansion();

    click(container, lineOf(container, 'Thought for 3s'));

    expect(groupViews(container).map((group) => group.title)).toEqual(['  Thought for 3s, read 1 file']);
  });

  const ungroupedThinking = [
    ['grouping is off', options({ toolCallDensity: 'ungrouped', thinking: 'ungrouped' })],
    ['thinking does not fold', options({ thinking: 'ungrouped' })],
    ['the transcript is regular', options({ fullscreen: false })],
  ] as const;

  it.each(ungroupedThinking)('keeps the untitled finished form of an opened thought when %s', (_name, presentation) => {
    const { container } = makeContainer(presentation);
    const thinking = new ThinkingComponent(lines(5), true, 'live');
    container.addChild(thinking);
    click(container, plain(container.render(80)).split('\n').length - 1);
    thinking.finalize({ known: true, ms: 5000 });

    const rows = (): string[] => plain(container.render(80)).split('\n').map((line) => line.trimEnd());
    expect(rows()).toEqual(['', '● line 1', '  line 2', '  line 3', '  line 4', '  line 5']);
    click(container, 1);
    expect(rows()).toEqual(['', '● line 1', '  line 2', '  … (3 more lines, ctrl+o to expand)']);
  });

  it.each(ungroupedThinking)('leaves clicks on a short finished opened thought unhandled when %s', (_name, presentation) => {
    const { container } = makeContainer(presentation);
    const thinking = new ThinkingComponent('one\ntwo\nthree', true, 'live');
    container.addChild(thinking);
    click(container, plain(container.render(80)).split('\n').length - 1);
    thinking.finalize({ known: true, ms: 5000 });

    expect(click(container, 1)).toBeUndefined();
    expect(plain(container.render(80)).split('\n').map((line) => line.trimEnd())).toEqual(['', '● one', '  two', '  three']);
  });

  it('keeps an opened thought before tools that arrived after it', () => {
    const { container } = makeContainer();
    const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive', true, 'live');
    container.addChild(thinking);
    openLiveThought(container);
    thinking.finalize({ known: true, ms: 3000 });
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(tool('Bash', { command: 'ls' }));

    expect(lineOf(container, 'one')).toBeLessThan(lineOf(container, 'Read 1 file'));
  });

  it('keeps an opened thought between the tools that ran before and after it', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive', true, 'live');
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(thinking);
    openLiveThought(container, 80, options({ toolCallDensity: 'compact' }));
    thinking.finalize({ known: true, ms: 3000 });
    container.addChild(tool('Bash', { command: 'ls' }));
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/b.ts' }));

    expect(groupViews(container).map((group) => group.title)).toEqual([
      '  Thought for 3s, read 1 file',
      '  Thought for 3s, read 1 file, ran 1 command',
    ]);
    expect(lineOf(container, 'read 1 file')).toBeLessThan(lineOf(container, 'one'));
    expect(lineOf(container, 'one')).toBeLessThan(lineOf(container, 'ran 1 command'));

    click(container, lineOf(container, 'one'));
    expect(thinking.isExpanded()).toBe(false);
    expect(onlyGroup(container).title).toBe('  Thought for 9s, read 2 files, ran 1 command');
  });

  it('keeps the group below an opened thought expanded when the thought closes', () => {
    const { container } = makeContainer();
    const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive', true, 'live');
    container.addChild(thinking);
    openLiveThought(container);
    thinking.finalize({ known: true, ms: 3000 });
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(tool('Bash', { command: 'ls' }));
    click(container, lineOf(container, 'Read 1 file'));
    expect(groupViews(container).map((group) => group.expanded)).toEqual([true]);

    click(container, lineOf(container, 'one'));

    expect(onlyGroup(container)).toMatchObject({
      title: '● Thought for 3s, read 1 file, ran 1 command',
      expanded: true,
    });
  });

  it('keeps the group below an opened thought expanded when a silent tool call before the thought joins it', () => {
    const { container } = makeContainer();
    const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive', true, 'live');
    container.addChild(tool('select_tools', { names: ['Read'] }));
    container.addChild(thinking);
    openLiveThought(container);
    thinking.finalize({ known: true, ms: 3000 });
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(tool('Bash', { command: 'ls' }));
    click(container, lineOf(container, 'Read 1 file'));
    expect(groupViews(container).map((group) => group.expanded)).toEqual([true]);

    click(container, lineOf(container, 'one'));

    expect(onlyGroup(container)).toMatchObject({
      title: '● Thought for 3s, read 1 file, ran 1 command',
      expanded: true,
    });
    expect(plain(container.render(80))).toContain('Bash ls');
  });

  it('keeps an expanded group on either side of an opened thought when it closes', () => {
    for (const expandedSide of [0, 1]) {
      const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
      const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive', true, 'live');
      container.addChild(thought());
      container.addChild(tool('Read', { path: '/work/a.ts' }));
      container.addChild(thinking);
      openLiveThought(container, 80, options({ toolCallDensity: 'compact' }));
      thinking.finalize({ known: true, ms: 3000 });
      container.addChild(tool('Bash', { command: 'ls' }));
      container.addChild(thought());
      container.addChild(tool('Read', { path: '/work/b.ts' }));
      click(container, lineOf(container, expandedSide === 0 ? 'read 1 file' : 'ran 1 command'));

      click(container, lineOf(container, 'one'));

      expect(onlyGroup(container).expanded).toBe(true);
    }
  });

  it('keeps a collapsed group collapsed when a card between groups closes', () => {
    const { container } = makeContainer();
    const card = tool('Bash', { command: 'pnpm test' }, { tool_call_id: 'bash-card', output: lines(40), is_error: false });
    const rows = (): string[] => plain(container.render(80)).split('\n');
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(card);
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/b.ts' }));
    click(container, rows().findLastIndex((line) => line.includes('read 1 file')));
    expect(groupViews(container).map((group) => group.expanded)).toEqual([false, true]);

    click(container, rows().findIndex((line) => line.includes('pnpm test')));
    expect(card.isExpanded()).toBe(true);
    click(container, rows().findIndex((line) => line.includes('pnpm test')));

    expect(card.isExpanded()).toBe(false);
    expect(groupViews(container).map((group) => group.expanded)).toEqual([false, true]);
  });

  it('collapses the merged group with Ctrl+O even when a half was expanded', () => {
    const { container } = makeContainer();
    const thinking = new ThinkingComponent('one\ntwo\nthree\nfour\nfive', true, 'live');
    container.addChild(thinking);
    openLiveThought(container);
    thinking.finalize({ known: true, ms: 3000 });
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(tool('Bash', { command: 'ls' }));
    click(container, lineOf(container, 'Read 1 file'));

    container.toggleToolOutputExpansion();
    container.toggleToolOutputExpansion();

    expect(onlyGroup(container)).toMatchObject({ expanded: false });
    expect(thinking.isExpanded()).toBe(false);
  });

  it('opens every row in recent groups with Ctrl+O and closes them again', () => {
    const { container } = makeContainer();
    const first = tool('Read', { path: '/work/a.ts' });
    const second = tool('Read', { path: '/work/b.ts' });
    container.addChild(first);
    container.addChild(second);

    container.toggleToolOutputExpansion();

    const group = onlyGroup(container);
    expect(group.title).toBe('● Read 2 files');
    expect(group.rows).toEqual(['├ Read a.ts', '└ Read b.ts']);
    expect(group.body.filter((line) => line.endsWith('first'))).toHaveLength(2);

    container.toggleToolOutputExpansion();
    expect(onlyGroup(container)).toMatchObject({ title: '  Read 2 files', expanded: false });
    expect(first.isExpanded() || second.isExpanded()).toBe(false);
  });

  it('closes rows opened by a click when Ctrl+O collapses everything', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const opened = tool('Bash', { command: 'cat a.txt' }, {
      tool_call_id: 'opened-by-user',
      output: lines(40),
      is_error: false,
    });
    container.addChild(opened);
    container.addChild(tool('Bash', { command: 'cat b.txt' }));
    container.toggleGroup(opened);
    click(container, lineOf(container, 'Bash cat a.txt'));
    expect(opened.isExpanded()).toBe(true);

    container.toggleToolOutputExpansion();
    container.toggleToolOutputExpansion();

    expect(opened.isExpanded()).toBe(false);
    expect(onlyGroup(container)).toMatchObject({ title: '  Ran 2 commands', expanded: false, tail: '' });
  });

  it('collapses a one-item group and its member after Ctrl+O collapses everything', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const opened = tool('Bash', { command: 'cat only.txt' }, {
      tool_call_id: 'only-member',
      output: lines(40),
      is_error: false,
    });
    container.addChild(opened);
    container.toggleGroup(opened);
    expect(opened.isExpanded()).toBe(true);
    expect(onlyGroup(container)).toMatchObject({ title: '● $ cat only.txt', expanded: true });

    container.toggleToolOutputExpansion();
    container.toggleToolOutputExpansion();

    expect(opened.isExpanded()).toBe(false);
    expect(onlyGroup(container)).toMatchObject({ title: '  $ cat only.txt', expanded: false, showLess: false });
    expect(container.toolOutputExpandHint()).toBe('expand');
  });

});

describe('TranscriptGroupComponent layout', () => {
  it('keeps a collapsed last group at three lines while it works, after it finishes and after the turn ends', () => {
    vi.useFakeTimers();
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const bash = runningTool('Bash', { command: 'sleep 5' });
    container.addChild(thought());
    container.addChild(bash);
    const timeline = liveTurn(container);
    const heights: number[] = [];
    const sample = (): void => {
      for (let step = 0; step < 30; step++) {
        vi.advanceTimersByTime(100);
        heights.push(container.render(80).length);
      }
    };

    sample();
    settle(timeline, bash);
    sample();
    timeline.turnEnded();
    sample();

    expect(new Set(heights)).toEqual(new Set([3]));
    expect(plain(container.render(80)).split('\n')).toEqual(['', '  Thought for 3s, ran 1 command', '']);
    container.clear();
  });

  it('hands the tail line to the next block in the same render, so the height stays the same', () => {
    vi.useFakeTimers();
    const { container } = makeContainer();
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    liveTurn(container);
    vi.advanceTimersByTime(1_500);
    const before = container.render(80);
    expect(plain(before).split('\n').at(-1)).toBe('  └ Waiting for response');

    const text = new AssistantMessageComponent();
    text.updateContent('Done.');
    container.addChild(text);
    const after = container.render(80);

    expect(after.length).toBe(before.length - 1 + text.render(80).length);
    expect(plain(after.slice(0, before.length - 1))).toBe(plain(before.slice(0, -1)));
    expect(visibleWidth(after[before.length - 1] ?? 'not blank')).toBe(0);
    container.clear();
  });

  it('keeps the title on its line when the group expands', () => {
    const { container } = makeContainer();
    container.addChild(user('go'));
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    const line = lineOf(container, 'Thought for 3s, read 1 file');

    click(container, line);

    expect(onlyGroup(container).expanded).toBe(true);
    expect(lineOf(container, 'Thought for 3s, read 1 file')).toBe(line);
  });

  it('adds no lines for a pending command until it is placed', () => {
    const { container } = makeContainer();
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    const before = plain(container.render(80));
    const bash = runningTool('Bash');
    bash.updateToolCall({ ...bash.toolCallView, streamingArguments: '{"command":"npm' });
    container.addChild(bash);

    expect(plain(container.render(80))).toBe(before);

    bash.updateToolCall({ ...bash.toolCallView, args: { command: 'npm install' }, streamingArguments: undefined });
    expect(groupViews(container)).toMatchObject([{ title: '  Thought for 3s, read 1 file', tail: undefined }]);
    expect(plain(container.render(80))).toContain('npm install');
  });

  it.each([
    ['balanced', 'abandoned', 'Bash rm -rf ./dist'],
    ['balanced', 'truncated', 'Bash rm -rf ./dist'],
    ['detailed', 'abandoned', 'rm -rf ./dist'],
    ['detailed', 'truncated', 'Truncated Bash'],
  ] as const)('places a %s command cut off mid-arguments once it is %s', (toolCallDensity, ending, shown) => {
    const { container } = makeContainer(options({ toolCallDensity }));
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    const timeline = liveTurn(container);
    const bash = runningTool('Bash');
    const callId = bash.toolCallView.id;
    if (!isToolCallId(callId)) throw new Error('a tool call id is never empty');
    bash.updateToolCall({
      ...bash.toolCallView,
      args: { command: 'rm -rf ./dist' },
      streamingArguments: '{"command":"rm -rf ./dist',
    });
    container.addChild(bash);
    timeline.callDelta(callId, 'Bash');
    expect(plain(container.render(80))).not.toContain('rm -rf ./dist');

    if (ending === 'abandoned') timeline.abandonUnstarted();
    else bash.updateToolCall({ ...bash.toolCallView, truncated: true });

    expect(plain(container.render(80))).toContain(shown);
    expect(groupViews(container)).toMatchObject([{ title: '  Thought for 3s, read 1 file' }]);
  });
});

describe('TranscriptRowComponent', () => {
  it('draws a balanced call as one row and keeps that row above the card body when it opens', () => {
    chalk.level = 3;
    const { container } = makeContainer(options({ toolCallDensity: 'balanced' }));
    const edit = tool('Edit', { path: '/work/a.ts', old_string: 'one', new_string: 'two' });
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(edit);
    const closed = container.render(80);

    expect(plain(closed).split('\n')).toEqual(['', '  Thought for 3s, read 1 file', '', '● Edit a.ts · +1 -1']);
    expect(closed[3]).toContain(`${currentTheme.fg('success', '● ')}${currentTheme.boldFg('textDim', 'Edit')} `);

    click(container, 3);
    expect(edit.isExpanded()).toBe(true);
    const opened = container.render(80);
    const body = opened.slice(closed.length);
    expect(opened.slice(0, closed.length)).toEqual(closed);
    expect(body).toEqual(edit.renderRowDetail(80));
    expect(plain(body)).toContain('two');
    expect(edit.render(80).slice(2)).toEqual(expect.arrayContaining(body));

    click(container, 3);
    expect(edit.isExpanded()).toBe(false);
    expect(container.render(80)).toEqual(closed);

    container.toggleToolOutputExpansion();
    const expanded = container.render(80);
    const row = expanded.indexOf(closed[3] ?? 'the row');
    expect(row).toBeGreaterThan(3);
    expect(expanded.slice(row + 1)).toEqual(edit.renderRowDetail(80));
    container.toggleToolOutputExpansion();
    expect(container.render(80)).toEqual(closed);
  });

  it('opens a command that fits onto the exact row it showed closed', () => {
    chalk.level = 3;
    const { container } = makeContainer(options({ toolCallDensity: 'balanced' }));
    const bash = tool('Bash', { command: 'npm test' });
    container.addChild(bash);
    const closed = container.render(80);

    click(container, 1);
    const opened = container.render(80);

    expect(plain(closed).split('\n')).toEqual(['', '● Bash npm test']);
    expect(opened.slice(0, closed.length)).toEqual(closed);
    expect(opened.slice(closed.length)).toEqual(bash.renderRowDetail(80));
  });

  it.each([
    [
      'wider than the terminal',
      'pnpm --filter kimi-code exec vitest run test/tui --reporter verbose --coverage',
      40,
      '● Bash pnpm --filter kimi-code exec vit…',
      ['● Bash pnpm --filter kimi-code exec', '       vitest run test/tui --reporter', '       verbose --coverage'],
    ],
    [
      'written over several lines',
      "cat <<'EOF' > notes.txt\nfirst note\nsecond note\nEOF",
      80,
      "● Bash cat <<'EOF' > notes.txt…",
      ["● Bash cat <<'EOF' > notes.txt", '       first note', '       second note', '       EOF'],
    ],
  ] as const)('opens a command %s into all of its lines under the row and closes it back to one row', (_shape, command, width, row, wrapped) => {
    const { container } = makeContainer(options({ toolCallDensity: 'balanced' }));
    const bash = tool('Bash', { command });
    container.addChild(bash);
    const closed = container.render(width);
    expect(plain(closed).split('\n')).toEqual(['', row]);

    click(container, 1, 0, width);
    const opened = container.render(width);
    expect(plain(opened.slice(1, 1 + wrapped.length)).split('\n')).toEqual(wrapped);
    expect(opened.slice(1 + wrapped.length)).toEqual(bash.renderRowDetail(width));

    click(container, 1, 0, width);
    expect(container.render(width)).toEqual(closed);
  });

  it('leaves the member rows of an expanded balanced group on their tree guides', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'balanced' }));
    container.addChild(thought());
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    container.addChild(tool('Edit', { path: '/work/a.ts', old_string: 'one', new_string: 'two' }));

    click(container, 1);

    const [group] = groupViews(container);
    expect(group?.rows).toEqual(['├ Thought for 3s', '└ Read a.ts']);
    expect(plain(container.render(80)).split('\n').at(-1)).toBe('● Edit a.ts · +1 -1');
  });

  const interrupted: ToolResultBlockData = { tool_call_id: 'call-interrupted', output: 'Interrupted by user', is_error: true };
  const failed: ToolResultBlockData = { tool_call_id: 'call-failed', output: 'exit code 1', is_error: true };
  const timedOut: ToolResultBlockData = {
    tool_call_id: 'call-timed-out',
    output: 'wait_status: timed_out\ntask_id: task-1\nwaited_ms: 1000\ntimeout_ms: 1000',
    is_error: false,
  };
  const goalUpdated: ToolResultBlockData = { tool_call_id: 'call-goal', output: 'Goal marked complete.', is_error: false };
  const truncated = (): ToolCallComponent => {
    const call = runningTool('Bash', { command: 'rm -rf ./dist' });
    call.updateToolCall({ ...call.toolCallView, truncated: true });
    return call;
  };

  it.each([
    ['running', () => runningTool('Bash', { command: 'npm install' }), 'text', '● '],
    ['finished', () => tool('Bash', { command: 'npm test' }), 'success', '● '],
    ['failed', () => tool('Bash', { command: 'npm test' }, failed), 'error', '✗ '],
    ['interrupted', () => tool('Bash', { command: 'npm test' }, interrupted), 'error', '✗ '],
    ['truncated', truncated, 'error', '✗ '],
    ['timed-out wait', () => tool('WaitFor', { task_id: 'task-1' }, timedOut), 'warning', '● '],
    ['goal report', () => tool('UpdateGoal', { status: 'complete' }, goalUpdated), 'primary', '● '],
  ] as const)('marks a %s row with the bullet its ungrouped and detailed cards draw', (_state, make, token, glyph) => {
    chalk.level = 3;
    const marker = currentTheme.fg(token, glyph);
    for (const toolCallDensity of ['ungrouped', 'detailed', 'balanced'] as const) {
      const { container } = makeContainer(options({ toolCallDensity }));
      container.addChild(make());
      liveTurn(container);
      expect(container.render(80)[1]?.startsWith(marker), toolCallDensity).toBe(true);
      container.clear();
    }
  });

  it('draws the bullet of its ungrouped card on the row of a call cut off mid-arguments', () => {
    chalk.level = 3;
    const cutOff = (toolCallDensity: 'balanced' | 'ungrouped'): string | undefined => {
      const { container } = makeContainer(options({ toolCallDensity }));
      const timeline = liveTurn(container);
      const bash = runningTool('Bash');
      const callId = bash.toolCallView.id;
      if (!isToolCallId(callId)) throw new Error('a tool call id is never empty');
      bash.updateToolCall({
        ...bash.toolCallView,
        args: { command: 'rm -rf ./dist' },
        streamingArguments: '{"command":"rm -rf ./dist',
      });
      container.addChild(bash);
      timeline.callDelta(callId, 'Bash');
      timeline.abandonUnstarted();
      return container.render(80)[1];
    };

    const cardBullet = currentTheme.fg('text', '● ');
    const row = cutOff('balanced') ?? '';
    expect(plain([row])).toBe('● Bash rm -rf ./dist · interrupted');
    expect(row.startsWith(cardBullet)).toBe(true);
    expect(cutOff('ungrouped')?.startsWith(cardBullet)).toBe(true);
  });

  it('draws the card bullet on the row of a resumed call that never got a result', () => {
    chalk.level = 3;
    const { container } = makeContainer(options({ toolCallDensity: 'balanced' }));
    container.setTimeline(new TurnTimeline());
    const bash = runningTool('Bash', { command: 'npm test' });
    container.addChild(bash);

    const row = container.render(80)[1] ?? '';

    expect(plain([row])).toBe('● Bash npm test');
    expect(row.startsWith(bash.statusMarker())).toBe(true);
    expect(row.startsWith(currentTheme.fg('text', '● '))).toBe(true);
  });

  it('updates an opened running row while its command streams output', () => {
    vi.useFakeTimers();
    const { container } = makeContainer(options({ toolCallDensity: 'balanced' }));
    const bash = runningTool('Bash', { command: 'npm install' });
    container.addChild(bash);
    liveTurn(container);
    click(container, 1);
    const row = container.render(80)[1];

    bash.appendLiveOutput('added 1 package\n');
    expect(plain(container.render(80))).toContain('added 1 package');
    bash.appendLiveOutput('added 2 packages\n');

    const lines = container.render(80);
    expect(lines[1]).toBe(row);
    expect(plain(lines)).toContain('added 2 packages');
    container.clear();
  });

  it('counts a running row and keeps its Bash hint in the activity bar even when the row is open', () => {
    vi.useFakeTimers();
    const { container } = makeContainer(options({ toolCallDensity: 'balanced' }));
    const ui = { requestRender: vi.fn() };
    const bash = new ToolCallComponent({ id: `call-${++id}`, name: 'Bash', args: { command: 'npm install' } }, undefined, ui as never, '/work');
    container.addChild(bash);
    liveTurn(container);

    expect(plain(container.render(80)).split('\n')).toEqual(['', '● Bash npm install']);
    vi.advanceTimersByTime(2_000);
    expect(plain(container.render(80)).split('\n')).toEqual(['', '● Bash npm install · 2s']);
    expect(container.foldedBashHintAt()).toBeDefined();

    click(container, 1);
    vi.advanceTimersByTime(FOREGROUND_BASH_HINT_DELAY_MS);
    expect(plain(bash.render(80))).toContain(DETACH_HINT_TEXT);
    expect(plain(container.render(80))).not.toContain(DETACH_HINT_TEXT);
    expect(container.foldedBashHintAt()).toBeDefined();
    container.clear();
  });
});

describe('Ctrl+O expansion across presentation changes', () => {
  function sameStepReads(): { group: ReadGroupComponent; reads: ToolCallComponent[] } {
    const reads = [
      tool('Read', { path: '/work/a.ts' }),
      tool('Read', { path: '/work/b.ts' }),
    ];
    const group = new ReadGroupComponent(undefined);
    reads.forEach((read, index) => {
      group.attach(`read-${index}`, read);
    });
    return { group, reads };
  }

  const groupingOff = options({ toolCallDensity: 'ungrouped', thinking: 'ungrouped' });

  it('keeps the read group card expanded when grouping is turned off after Ctrl+O', () => {
    const { container } = makeContainer();
    const { group } = sameStepReads();
    container.addChild(group);

    container.toggleToolOutputExpansion();
    container.setPresentationOptions(groupingOff);

    expect(plain(container.render(80))).toContain('a.ts');
    expect(group.isExpanded()).toBe(true);

    container.toggleToolOutputExpansion();
    expect(group.isExpanded()).toBe(false);
    expect(plain(container.render(80))).not.toContain('a.ts');
  });

  it('expands the rows of a split read group when grouping is turned on after Ctrl+O', () => {
    const { container } = makeContainer(groupingOff);
    const { group, reads } = sameStepReads();
    container.addChild(group);

    container.toggleToolOutputExpansion();
    container.setPresentationOptions(options());

    expect(onlyGroup(container)).toMatchObject({ title: '● Read 2 files', expanded: true });
    expect(reads.map((read) => read.isExpanded())).toEqual([true, true]);
  });

  it('leaves expansion alone when the presentation changes without Ctrl+O', () => {
    const { container } = makeContainer();
    const { group } = sameStepReads();
    const opened = tool('Bash', { command: 'ls' });
    container.addChild(group);
    container.addChild(opened);
    opened.setExpanded(true);

    container.setPresentationOptions(groupingOff);

    expect(group.isExpanded()).toBe(false);
    expect(opened.isExpanded()).toBe(true);
    expect(container.toolOutputExpanded).toBe(false);
  });
});

describe('skill activation cards in grouped transcripts', () => {
  function skillCalls(container: TranscriptContainer, card: Component): void {
    container.addChild(tool('Skill', { skill: 'foo' }));
    container.addChild(card);
    container.addChild(tool('TodoList', { todos: [] }));
    container.addChild(tool('Bash', { command: 'pnpm test' }));
  }

  it('hides model-triggered cards and keeps the group in one piece', () => {
    for (const trigger of ['model-tool', 'nested-skill'] as const) {
      const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
      skillCalls(container, new SkillActivationComponent('foo', undefined, trigger));
      container.toggleGroup(container.children[0] as Component);

      expect(onlyGroup(container).rows).toHaveLength(3);
      expect(plain(container.render(80))).not.toContain('Activated skill');
    }
  });

  it('shows the card when tools are not grouped', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'ungrouped' }));
    skillCalls(container, new SkillActivationComponent('foo', undefined, 'model-tool'));

    expect(plain(container.render(80))).toContain('Activated skill: foo');
  });

  it('shows a user-triggered card in a grouped transcript', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    skillCalls(container, new SkillActivationComponent('foo', undefined, 'user-slash'));

    expect(plain(container.render(80))).toContain('Activated skill: foo');
  });

  it('shows the card in the regular transcript', () => {
    const { container } = makeContainer(options({ fullscreen: false, toolCallDensity: 'compact' }));
    skillCalls(container, new SkillActivationComponent('foo', undefined, 'model-tool'));

    expect(plain(container.render(80))).toContain('Activated skill: foo');
  });
});

describe('Ctrl+O turn counting with skill activation cards', () => {
  function skillCard(trigger: 'user-slash' | 'model-tool' | 'nested-skill'): SkillActivationComponent {
    const card = new SkillActivationComponent('foo', undefined, trigger);
    const entry: TranscriptEntry = {
      id: `entry-${++id}`,
      kind: 'skill_activation',
      turnId: undefined,
      renderMode: 'plain',
      content: 'Activated skill: foo',
      skillTrigger: trigger,
    };
    markTranscriptComponent(card, entry);
    return card;
  }

  function history(container: TranscriptContainer): void {
    for (const text of ['one', 'two', 'three']) container.addChild(user(text));
  }

  it('expands a group spanning model skill cards in the latest turn', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    history(container);
    container.addChild(user('latest'));
    container.addChild(tool('Read', { path: '/work/a.ts' }));
    for (const name of ['a', 'b', 'c']) {
      container.addChild(tool('Skill', { skill: name }));
      container.addChild(skillCard('model-tool'));
    }
    container.addChild(tool('Read', { path: '/work/b.ts' }));

    expect(container.toolOutputExpandHint()).toBe('expand');
    expect(container.toggleToolOutputExpansion()).toBe(true);

    expect(onlyGroup(container).expanded).toBe(true);
    expect(container.toolOutputExpandHint()).toBe('collapse');
  });

  it('expands cards before model skill cards in the regular transcript', () => {
    const { container } = makeContainer(options({ fullscreen: false, toolCallDensity: 'ungrouped' }));
    history(container);
    container.addChild(user('latest'));
    const read = tool('Read', { path: '/work/a.ts' });
    container.addChild(read);
    for (const trigger of ['model-tool', 'nested-skill', 'model-tool'] as const) {
      container.addChild(skillCard(trigger));
    }

    container.toggleToolOutputExpansion();

    expect(read.isExpanded()).toBe(true);
  });

  it('still counts a user-triggered skill card as the start of a turn', () => {
    const { container } = makeContainer(options({ fullscreen: false, toolCallDensity: 'ungrouped' }));
    for (const text of ['one', 'two']) container.addChild(user(text));
    const read = tool('Read', { path: '/work/a.ts' });
    container.addChild(read);
    container.addChild(skillCard('user-slash'));
    container.addChild(skillCard('user-slash'));
    container.addChild(skillCard('user-slash'));

    container.toggleToolOutputExpansion();

    expect(read.isExpanded()).toBe(false);
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
    const timeline = liveTurn(container);
    expect(plain(container.render(100))).toContain('Reading files');

    call.truncated = true;
    read.updateToolCall(call);
    timeline.turnEnded();

    expect(onlyGroup(container, 100).title).toBe('  Read a.ts');
    expect(plain(container.render(100))).not.toContain('Reading');
  });

  it('updates the Bash title while arguments are still streaming', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const bash = runningTool('Bash');
    bash.updateToolCall({ ...bash.toolCallView, streamingArguments: '{' });
    container.addChild(bash);
    container.render(100);

    bash.updateToolCall({
      ...bash.toolCallView,
      args: { command: 'sleep 30' },
      streamingArguments: '{"command":"sleep 30"}',
    });

    expect(onlyGroup(container, 100).title).toBe('  $ sleep 30');
  });

  it('adds a streaming Edit diff to the title once the call counts', () => {
    vi.useFakeTimers();
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const edit = runningTool('Edit', { path: '/work/a.ts' });
    edit.updateToolCall({ ...edit.toolCallView, streamingArguments: '{"path":"/work/a.ts"}' });
    container.addChild(edit);
    const timeline = new TurnTimeline();
    container.setTimeline(timeline);
    timeline.turnStarted();
    if (isToolCallId(edit.toolCallView.id)) timeline.callDelta(edit.toolCallView.id, 'Edit');
    container.render(100);

    edit.updateToolCall({
      ...edit.toolCallView,
      args: { path: '/work/a.ts', old_string: 'a', new_string: 'b' },
      streamingArguments: '{"path":"/work/a.ts","old_string":"a","new_string":"b"}',
    });
    expect(onlyGroup(container, 100).title).toBe('  Editing files');

    if (isToolCallId(edit.toolCallView.id)) timeline.callStarted(edit.toolCallView.id, 'Edit');
    vi.advanceTimersByTime(200);
    expect(onlyGroup(container, 100).title).toBe('  Editing 1 file +1 -1');
    container.clear();
  });
});

describe('TranscriptContainer dense segments', () => {
  it('shows every group and card in a dense segment and applies Ctrl+O to all of them', () => {
    const { container } = makeContainer(options({ toolCallDensity: 'compact' }));
    const components = [
      tool('Read', { path: '/work/a.ts' }),
      tool('Agent', { description: 'first-agent' }),
      tool('Read', { path: '/work/b.ts' }),
      tool('Agent', { description: 'second-agent' }),
      ...agents(8),
    ];
    for (const component of components) container.addChild(component);

    const text = plain(container.render(100));
    expect(text).toContain('first-agent');
    expect(text).toContain('second-agent');
    expect(groupViews(container, 100).map((group) => [group.title, group.expanded])).toEqual([
      ['  Read a.ts', false],
      ['  Read b.ts', false],
    ]);

    expect(container.toggleToolOutputExpansion()).toBe(true);
    expect(groupViews(container, 100).map((group) => [group.title, group.expanded])).toEqual([
      ['● Read a.ts', true],
      ['● Read b.ts', true],
    ]);
    expect(components.every((component) => component.isExpanded())).toBe(true);

    expect(container.toggleToolOutputExpansion()).toBe(false);
    expect(groupViews(container, 100).some((group) => group.expanded)).toBe(false);
    expect(components.every((component) => !component.isExpanded())).toBe(true);
  });
});

describe('TranscriptContainer interaction', () => {
  it('toggles a group from any summary column with anchoring and telemetry', () => {
    const { container } = makeContainer();
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read'));
    const grouping = host();
    container.setHost(grouping);

    click(container, 1, 60);

    expect(grouping.withScrollAnchor).toHaveBeenCalledOnce();
    expect(grouping.track).toHaveBeenCalledWith('transcript_group_toggle', { expanded: true });
    expect(onlyGroup(container)).toMatchObject({ title: '● Thought for 3s, read 1 file', expanded: true });

    click(container, 1, 0);
    expect(grouping.track).toHaveBeenCalledWith('transcript_group_toggle', { expanded: false });
    expect(onlyGroup(container).expanded).toBe(false);
  });

  it('collapses from Show less with bottom anchoring', () => {
    const { container } = makeContainer();
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read'));
    const grouping = host(3);
    container.setHost(grouping);
    container.toggleGroup(thinking);
    const expanded = container.render(80);
    const showLess = plain(expanded).split('\n').findIndex((line) => line.includes('Show less'));
    grouping.withScrollAnchor.mockClear();

    click(container, showLess);

    expect(grouping.withBottomAnchor).toHaveBeenCalledOnce();
    expect(grouping.withBottomAnchor.mock.calls[0]?.[1]).toBe(expanded.length - 3);
    expect(grouping.withScrollAnchor).not.toHaveBeenCalled();
    expect(onlyGroup(container).expanded).toBe(false);
  });

  it('opens rows of old groups on click while Ctrl+O stays within three turns', () => {
    const { container } = makeContainer();
    const oldThinking = thought();
    const oldRead = tool('Read', { path: '/work/old.ts' });
    container.addChild(oldThinking);
    container.addChild(oldRead);
    for (const text of ['one', 'two', 'three', 'four']) container.addChild(user(text));

    click(container, 1);
    expect(onlyGroup(container).expanded).toBe(true);
    click(container, lineOf(container, 'Read old.ts'));
    expect(oldRead.isExpanded()).toBe(true);

    click(container, lineOf(container, 'Read old.ts'));
    expect(oldRead.isExpanded()).toBe(false);
    container.toggleToolOutputExpansion();
    expect(oldRead.isExpanded()).toBe(false);
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
    expect(groupViews(container, 100).map((group) => [group.title, group.expanded])).toEqual([
      ['  Thought for 3s, read 1 file', false],
      ['● Thought for 3s, searched 1 pattern', true],
    ]);

    container.addChild(user('next turn'));
    const newThinking = thought();
    container.addChild(newThinking);
    container.addChild(tool('Glob'));
    expect(groupViews(container, 100).filter((group) => group.expanded)).toHaveLength(2);

    expect(container.toggleToolOutputExpansion()).toBe(false);
    expect(groupViews(container, 100).some((group) => group.expanded)).toBe(false);
  });

  it('re-derives after configuration changes while preserving group expansion', () => {
    const { container } = makeContainer();
    const thinking = thought();
    container.addChild(thinking);
    container.addChild(tool('Read'));
    container.addChild(tool('Grep'));
    container.toggleGroup(thinking);
    expect(onlyGroup(container).expanded).toBe(true);

    container.setPresentationOptions(options({ toolCallDensity: 'ungrouped' }));

    expect(onlyGroup(container)).toMatchObject({
      title: '● Thought for 3s',
      expanded: true,
      body: ['  reasoning'],
    });
    const text = plain(container.render(80));
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
