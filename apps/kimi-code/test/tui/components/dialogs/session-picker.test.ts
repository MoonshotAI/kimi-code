import { TuiAltScreen, visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionPickerComponent } from '#/tui/components/dialogs/session-picker';

import { VirtualTerminal } from '../../../../../../packages/pi-tui/test/virtual-terminal';

function stripAnsi(text: string): string {
  return text.replaceAll(/\[[0-?]*[ -/]*[@-~]/g, '');
}

function renderPlain(component: SessionPickerComponent, width = 120): string {
  return stripAnsi(component.render(width).join('\n'));
}

const BACKSPACE = String.fromCodePoint(127);
const ESC = String.fromCodePoint(27);

describe('SessionPickerComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards Ctrl-C and Ctrl-D to optional host shortcuts', () => {
    const onCtrlC = vi.fn();
    const onCtrlD = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onCtrlC,
      onCtrlD,
    });

    component.handleInput('\u0003');
    component.handleInput('\u0004');

    expect(onCtrlC).toHaveBeenCalledOnce();
    expect(onCtrlD).toHaveBeenCalledOnce();
  });

  it('renders millisecond updated_at timestamps as relative times', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_minutes',
          title: 'minutes old',
          work_dir: '/tmp/project',
          updated_at: now - 2 * 60 * 1000,
        },
        {
          id: 'ses_hours',
          title: 'hours old',
          work_dir: '/tmp/project',
          updated_at: now - 3 * 60 * 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('2m ago');
    expect(output).toContain('3h ago');
    expect(output).not.toContain('just now');
  });

  it('renders title, full session id, work_dir, and last_prompt for each session', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_01HXYABCDEFGHIJK',
          title: 'Refactor sessions list',
          last_prompt: 'please redesign the picker UI',
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('Refactor sessions list');
    expect(output).toContain('ses_01HXYABCDEFGHIJK');
    expect(output).not.toMatch(/ses_01\S*…/);
    expect(output).toContain('/tmp/project');
    expect(output).toContain('please redesign the picker UI');
  });

  it('omits the last-prompt row when last_prompt is missing', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_no_prompt',
          title: 'no prompt yet',
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).not.toMatch(/^\s*›/m);
  });

  it('truncates overly long last_prompt content', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const longPrompt = 'a'.repeat(500);
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_long',
          title: 'long prompt',
          last_prompt: longPrompt,
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = component.render(60).map((line) => stripAnsi(line));
    const promptLine = lines.find((line) => line.trimStart().startsWith('›'));
    expect(promptLine).toBeDefined();
    expect(promptLine!.length).toBeLessThanOrEqual(60);
    expect(promptLine!.endsWith('…')).toBe(true);
    expect(promptLine).not.toContain(longPrompt);
  });

  it('marks the current session with a "← current" badge', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_current',
          title: 'this is current',
          work_dir: '/tmp/project',
          updated_at: now,
        },
        {
          id: 'ses_other',
          title: 'not current',
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_current',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = component.render(120).map((line) => stripAnsi(line));
    const currentLine = lines.find((line) => line.includes('this is current'));
    const otherLine = lines.find((line) => line.includes('not current'));
    expect(currentLine).toContain('← current');
    expect(otherLine).not.toContain('← current');
  });

  it('places the relative time on the same line as the title, not right-aligned', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_inline_time',
          title: 'Short title',
          work_dir: '/tmp/project',
          updated_at: now - 5 * 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = component.render(120).map((line) => stripAnsi(line));
    const headerLine = lines.find((line) => line.includes('Short title'));
    expect(headerLine).toBeDefined();
    expect(headerLine).toMatch(/Short title\s{1,4}5m ago/);
    expect(headerLine).not.toMatch(/Short title\s{8,}/);
  });

  it('prepends [imported] badge before the title for sessions migrated from kimi-cli', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_imported',
          title: 'Migrated session',
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
          metadata: { imported_from_kimi_cli: true },
        },
        {
          id: 'ses_native',
          title: 'Fresh session',
          work_dir: '/tmp/project',
          updated_at: now - 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_other',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = component.render(120).map((line) => stripAnsi(line));
    const importedLine = lines.find((line) => line.includes('Migrated session'));
    const nativeLine = lines.find((line) => line.includes('Fresh session'));
    expect(importedLine).toContain('[imported] Migrated session');
    expect(nativeLine).not.toContain('[imported]');
  });

  it('keeps every rendered line within the terminal width even for CJK content', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_cjk_long_session_id_value',
          title: '现在要重构一下 TUI 的 sessions 列表，要渲染几个字段，让 UI 更好看',
          last_prompt:
            '我们要渲染几个：sessionid title lastPrompt。工作目录，修改时间。需要重新设计下 UI。',
          work_dir: '/Users/someone/Desktop/中文目录/very-long-project-folder-name',
          updated_at: now - 5 * 60 * 1000,
        },
      ],
      loading: false,
      currentSessionId: 'ses_cjk_long_session_id_value',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    for (const width of [40, 80, 120, 238]) {
      const lines = component.render(width);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('never renders a line wider than the terminal, even on tiny widths (#240)', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const id = 'ses_fbe574f3-572d-487f-9fa0-d09694f599d4';
    const component = new SessionPickerComponent({
      sessions: [
        {
          id,
          title: 'refactor the sessions list so the UI looks much nicer than before',
          last_prompt: 'please redesign the picker UI to be much nicer than before',
          work_dir: '/Users/getlong/Development/cesiumdb',
          updated_at: now - 5 * 60 * 1000,
          metadata: { imported_from_kimi_cli: true },
        },
      ],
      loading: false,
      currentSessionId: id,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    for (let width = 10; width <= 60; width++) {
      const lines = component.render(width);
      for (const [idx, line] of lines.entries()) {
        expect(visibleWidth(line), `width=${String(width)} line#${String(idx)}`).toBeLessThanOrEqual(
          width,
        );
      }
    }
  });

  it('calls onToggleScope with the selected session id when Ctrl+A is pressed', () => {
    const onToggleScope = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_a',
          title: 'Session A',
          work_dir: '/tmp/project-a',
          updated_at: 1,
        },
        {
          id: 'ses_b',
          title: 'Session B',
          work_dir: '/tmp/project-b',
          updated_at: 2,
        },
      ],
      loading: false,
      currentSessionId: '',
      scope: 'cwd',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onToggleScope,
    });

    component.handleInput('\u001B[B');
    component.handleInput('\u0001');

    expect(onToggleScope).toHaveBeenCalledOnce();
    expect(onToggleScope).toHaveBeenCalledWith('ses_b');
  });

  it('calls onToggleScope with the current session id when Ctrl+A is pressed with no sessions', () => {
    const onToggleScope = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [],
      loading: false,
      currentSessionId: 'ses_current',
      scope: 'cwd',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onToggleScope,
    });

    component.handleInput('\u0001');

    expect(onToggleScope).toHaveBeenCalledOnce();
    expect(onToggleScope).toHaveBeenCalledWith('ses_current');
  });

  it('renders the Ctrl+A all-sessions hint when the current cwd has no sessions', () => {
    const component = new SessionPickerComponent({
      sessions: [],
      loading: false,
      currentSessionId: 'ses_current',
      scope: 'cwd',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onToggleScope: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('No sessions found.');
    expect(output).toContain('Ctrl+A all');
  });

  it('renders all-sessions scope header and Ctrl+A current-cwd hint', () => {
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_all',
          title: 'All scope session',
          work_dir: '/tmp/project',
          updated_at: 1,
        },
      ],
      loading: false,
      currentSessionId: '',
      scope: 'all',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onToggleScope: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('All sessions');
    expect(output).toContain('↑↓ navigate · Ctrl+A current cwd · Enter select · Esc cancel');
  });

  it('selects the full session row on Enter', () => {
    const onSelect = vi.fn();
    const session = {
      id: 'ses_row',
      title: 'Row session',
      work_dir: '/tmp/project-row',
      updated_at: 1,
    };
    const component = new SessionPickerComponent({
      sessions: [session],
      loading: false,
      currentSessionId: '',
      scope: 'cwd',
      onSelect,
      onCancel: vi.fn(),
    });

    component.handleInput('\r');

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(session);
  });

  it('loads the next 50 sessions after moving past the loaded page', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const component = new SessionPickerComponent({
      sessions: Array.from({ length: 120 }, (_, index) => ({
        id: `ses_${String(index).padStart(4, '0')}`,
        title: `Session ${String(index).padStart(4, '0')}`,
        work_dir: '/tmp/project',
        updated_at: now - index * 1000,
      })),
      loading: false,
      currentSessionId: '',
      scope: 'all',
      pageSize: 50,
      maxVisibleSessions: 4,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    for (let i = 0; i < 50; i++) {
      component.handleInput('\u001B[B');
    }

    const output = renderPlain(component);

    expect(output).toContain('Session 0050');
    expect(output).toContain('Showing 49-52 of 100 loaded / 120 sessions');
  });

  it('keeps initial selected session id and loads enough pages for it', () => {
    const component = new SessionPickerComponent({
      sessions: Array.from({ length: 80 }, (_, index) => ({
        id: `ses_${String(index).padStart(4, '0')}`,
        title: `Session ${String(index).padStart(4, '0')}`,
        work_dir: '/tmp/project',
        updated_at: index,
      })),
      loading: false,
      currentSessionId: '',
      scope: 'all',
      initialSelectedSessionId: 'ses_0070',
      pageSize: 50,
      maxVisibleSessions: 4,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('Session 0070');
    expect(output).toContain('Showing 69-72 of 80 sessions');
  });

  it('shows type-to-search copy only when the query is empty', () => {
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_search_copy',
          title: 'Search copy session',
          work_dir: '/tmp/project',
          updated_at: 1,
        },
      ],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const output = renderPlain(component);

    expect(output).toContain('Sessions  (type to search)');
    expect(output).not.toContain('Search:');

    component.handleInput('x');
    const searchOutput = renderPlain(component);

    expect(searchOutput).toContain('Search: x');
    expect(searchOutput).not.toContain('Sessions  (type to search)');
  });

  it('fuzzy-filters by session name only when typing', () => {
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_alpha',
          title: 'Alpha session',
          last_prompt: 'needleprompt do not match',
          work_dir: '/tmp/needleprompt',
          updated_at: 1,
        },
        {
          id: 'ses_beta',
          title: 'Beta session',
          last_prompt: 'other prompt',
          work_dir: '/tmp/other',
          updated_at: 2,
        },
        {
          id: 'ses_fuzzy',
          title: 'N1e2e3d4l5e session',
          last_prompt: 'prompt only',
          work_dir: '/tmp/project',
          updated_at: 3,
        },
      ],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    component.handleInput('n');
    component.handleInput('e');
    component.handleInput('e');
    component.handleInput('d');
    component.handleInput('l');
    component.handleInput('e');

    const output = renderPlain(component);

    expect(output).toContain('Search: needle');
    expect(output).toContain('N1e2e3d4l5e session');
    expect(output).not.toContain('Alpha session');
    expect(output).not.toContain('Beta session');
  });

  it('clears the query on Backspace and cancels on Esc only after the query is empty', () => {
    const onCancel = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_alpha',
          title: 'Alpha session',
          work_dir: '/tmp/project',
          updated_at: 1,
        },
        {
          id: 'ses_beta',
          title: 'Beta session',
          work_dir: '/tmp/project',
          updated_at: 2,
        },
      ],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel,
    });

    component.handleInput('z');
    expect(renderPlain(component)).toContain('Search: z');

    component.handleInput(BACKSPACE);
    expect(renderPlain(component)).not.toContain('Search:');
    expect(onCancel).not.toHaveBeenCalled();

    component.handleInput('z');
    expect(renderPlain(component)).toContain('Search: z');

    component.handleInput(ESC);
    expect(renderPlain(component)).not.toContain('Search:');
    expect(onCancel).not.toHaveBeenCalled();

    component.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('selects the filtered session row on Enter', () => {
    const onSelect = vi.fn();
    const target = {
      id: 'ses_gamma',
      title: 'Gamma session',
      work_dir: '/tmp/project-gamma',
      updated_at: 3,
    };
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_alpha',
          title: 'Alpha session',
          work_dir: '/tmp/project-alpha',
          updated_at: 1,
        },
        {
          id: 'ses_beta',
          title: 'Beta session',
          work_dir: '/tmp/project-beta',
          updated_at: 2,
        },
        target,
      ],
      loading: false,
      currentSessionId: '',
      onSelect,
      onCancel: vi.fn(),
    });

    component.handleInput('g');
    component.handleInput('a');
    component.handleInput('m');
    component.handleInput('\r');

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(target);
  });

  it('loads the next 50 matching sessions after moving past the filtered page', () => {
    const now = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const component = new SessionPickerComponent({
      sessions: [
        ...Array.from({ length: 80 }, (_, index) => ({
          id: `ses_needle_${String(index).padStart(4, '0')}`,
          title: `Needle ${String(index).padStart(4, '0')}`,
          work_dir: '/tmp/project',
          updated_at: now - index * 1000,
        })),
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `ses_other_${String(index).padStart(4, '0')}`,
          title: `Other ${String(index).padStart(4, '0')}`,
          work_dir: '/tmp/project',
          updated_at: now - (80 + index) * 1000,
        })),
      ],
      loading: false,
      currentSessionId: '',
      pageSize: 50,
      maxVisibleSessions: 4,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    component.handleInput('n');
    component.handleInput('e');
    component.handleInput('e');
    component.handleInput('d');
    component.handleInput('l');
    component.handleInput('e');
    for (let i = 0; i < 50; i++) {
      component.handleInput('\u001B[B');
    }

    const output = renderPlain(component);

    expect(output).toContain('Needle 0050');
    expect(output).toContain('Showing 49-52 of 80 loaded / 80 matches');
  });

  it('calls onToggleScope with the selected filtered session id when Ctrl+A is pressed', () => {
    const onToggleScope = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [
        {
          id: 'ses_alpha',
          title: 'Alpha session',
          work_dir: '/tmp/project-a',
          updated_at: 1,
        },
        {
          id: 'ses_beta',
          title: 'Beta session',
          work_dir: '/tmp/project-b',
          updated_at: 2,
        },
      ],
      loading: false,
      currentSessionId: '',
      scope: 'cwd',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onToggleScope,
    });

    component.handleInput('b');
    component.handleInput('e');
    component.handleInput('t');
    component.handleInput('a');
    component.handleInput('\u0001');

    expect(onToggleScope).toHaveBeenCalledOnce();
    expect(onToggleScope).toHaveBeenCalledWith('ses_beta');
  });

  it('fires onLoadMore when the cursor reaches the last fetched row', () => {
    const onLoadMore = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [
        { id: 'ses_a', title: 'Alpha', work_dir: '/tmp/project', updated_at: 1 },
        { id: 'ses_b', title: 'Beta', work_dir: '/tmp/project', updated_at: 2 },
      ],
      loading: false,
      currentSessionId: '',
      hasMore: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onLoadMore,
    });

    component.handleInput('\u001B[B');

    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it('does not fire onLoadMore while a page fetch is in flight', () => {
    const onLoadMore = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [
        { id: 'ses_a', title: 'Alpha', work_dir: '/tmp/project', updated_at: 1 },
        { id: 'ses_b', title: 'Beta', work_dir: '/tmp/project', updated_at: 2 },
      ],
      loading: false,
      currentSessionId: '',
      hasMore: true,
      loadingMore: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onLoadMore,
    });

    component.handleInput('\u001B[B');

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('appendSessions extends the list and keeps the active query', () => {
    const component = new SessionPickerComponent({
      sessions: [{ id: 'ses_alpha', title: 'Alpha session', work_dir: '/tmp/p', updated_at: 1 }],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    component.handleInput('g');
    expect(renderPlain(component)).toContain('No matches');

    component.appendSessions([
      { id: 'ses_gamma', title: 'Gamma session', work_dir: '/tmp/p', updated_at: 2 },
    ]);

    const output = renderPlain(component);
    expect(output).toContain('Search: g');
    expect(output).toContain('Gamma session');
    expect(output).not.toContain('Alpha session');
  });

  it('appendSessions keeps the selected row', () => {
    const onSelect = vi.fn();
    const beta = { id: 'ses_beta', title: 'Beta session', work_dir: '/tmp/p', updated_at: 2 };
    const component = new SessionPickerComponent({
      sessions: [
        { id: 'ses_alpha', title: 'Alpha session', work_dir: '/tmp/p', updated_at: 1 },
        beta,
      ],
      loading: false,
      currentSessionId: '',
      onSelect,
      onCancel: vi.fn(),
    });

    component.handleInput('\u001B[B');
    component.appendSessions([
      { id: 'ses_gamma', title: 'Gamma session', work_dir: '/tmp/p', updated_at: 3 },
    ]);
    component.handleInput('\r');

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(beta);
  });

  it('fires onSearchDrain only when the query becomes active with unfetched pages', () => {
    const onSearchDrain = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [{ id: 'ses_alpha', title: 'Alpha session', work_dir: '/tmp/p', updated_at: 1 }],
      loading: false,
      currentSessionId: '',
      hasMore: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onSearchDrain,
    });

    component.handleInput('a');
    component.handleInput('l');

    expect(onSearchDrain).toHaveBeenCalledOnce();
  });

  it('does not fire onSearchDrain when every page is already fetched', () => {
    const onSearchDrain = vi.fn();
    const component = new SessionPickerComponent({
      sessions: [{ id: 'ses_alpha', title: 'Alpha session', work_dir: '/tmp/p', updated_at: 1 }],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      onSearchDrain,
    });

    component.handleInput('a');

    expect(onSearchDrain).not.toHaveBeenCalled();
  });

  it('announces unfetched pages and in-flight fetches in the footer', () => {
    const component = new SessionPickerComponent({
      sessions: [
        { id: 'ses_a', title: 'Alpha', work_dir: '/tmp/project', updated_at: 1 },
        { id: 'ses_b', title: 'Beta', work_dir: '/tmp/project', updated_at: 2 },
      ],
      loading: false,
      currentSessionId: '',
      hasMore: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(renderPlain(component)).toContain('· scroll for more');

    component.setPaging(true, true);
    expect(renderPlain(component)).toContain('· loading more…');

    component.setPaging(false, false);
    const settled = renderPlain(component);
    expect(settled).not.toContain('· scroll for more');
    expect(settled).not.toContain('· loading more…');
  });

  it('notes the background drain in the footer while searching with unfetched pages', () => {
    const component = new SessionPickerComponent({
      sessions: [{ id: 'ses_alpha', title: 'Alpha session', work_dir: '/tmp/p', updated_at: 1 }],
      loading: false,
      currentSessionId: '',
      hasMore: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    component.handleInput('a');

    expect(renderPlain(component)).toContain('· searching all…');
  });

  describe('session deletion', () => {
    const CTRL_X = '\u0018';

    function deferred(): {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: unknown) => void;
    } {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    async function flushMicrotasks(): Promise<void> {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    }

    const alpha = { id: 'ses_alpha', title: 'Alpha session', work_dir: '/tmp/p', updated_at: 2 };
    const beta = { id: 'ses_beta', title: 'Beta session', work_dir: '/tmp/p', updated_at: 1 };

    it('arms an inline delete confirmation on Ctrl+X for the selected row', () => {
      const onDeleteRequest = vi.fn(async () => {});
      const component = new SessionPickerComponent({
        sessions: [alpha, beta],
        loading: false,
        currentSessionId: '',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onDeleteRequest,
      });

      component.handleInput(CTRL_X);

      expect(renderPlain(component)).toContain('Delete session "Alpha session"? [y/N]');
      expect(onDeleteRequest).not.toHaveBeenCalled();
    });

    it('does nothing on Ctrl+X without a delete handler or a selected row', () => {
      const noHandler = new SessionPickerComponent({
        sessions: [alpha],
        loading: false,
        currentSessionId: '',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });
      noHandler.handleInput(CTRL_X);
      expect(renderPlain(noHandler)).not.toContain('Delete session');

      const noRows = new SessionPickerComponent({
        sessions: [],
        loading: false,
        currentSessionId: '',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onDeleteRequest: vi.fn(async () => {}),
      });
      noRows.handleInput(CTRL_X);
      expect(renderPlain(noRows)).not.toContain('Delete session');
    });

    it('confirms on y, shows a deleting state, and clears it after success', async () => {
      const { promise, resolve } = deferred();
      const onDeleteRequest = vi.fn(() => promise);
      const component = new SessionPickerComponent({
        sessions: [alpha, beta],
        loading: false,
        currentSessionId: '',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onDeleteRequest,
      });

      component.handleInput(CTRL_X);
      component.handleInput('y');

      expect(onDeleteRequest).toHaveBeenCalledOnce();
      expect(onDeleteRequest).toHaveBeenCalledWith(alpha);
      expect(renderPlain(component)).toContain('Deleting session "Alpha session"…');

      resolve();
      await flushMicrotasks();

      const output = renderPlain(component);
      expect(output).not.toContain('Deleting session');
      expect(output).not.toContain('Delete session');
    });

    it('cancels on n and on Esc without calling onDeleteRequest or onCancel', () => {
      const onDeleteRequest = vi.fn(async () => {});
      const onCancel = vi.fn();
      const component = new SessionPickerComponent({
        sessions: [alpha, beta],
        loading: false,
        currentSessionId: '',
        onSelect: vi.fn(),
        onCancel,
        onDeleteRequest,
      });

      component.handleInput(CTRL_X);
      component.handleInput('n');
      expect(renderPlain(component)).not.toContain('Delete session');

      component.handleInput(CTRL_X);
      component.handleInput(ESC);
      expect(renderPlain(component)).not.toContain('Delete session');

      expect(onDeleteRequest).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('ignores all other keys while the confirmation is armed', () => {
      const onDeleteRequest = vi.fn(async () => {});
      const onSelect = vi.fn();
      const component = new SessionPickerComponent({
        sessions: [alpha, beta],
        loading: false,
        currentSessionId: '',
        onSelect,
        onCancel: vi.fn(),
        onDeleteRequest,
      });

      component.handleInput(CTRL_X);
      component.handleInput('\r');
      component.handleInput('\u001B[B');
      component.handleInput('x');
      component.handleInput(CTRL_X);

      expect(renderPlain(component)).toContain('Delete session "Alpha session"? [y/N]');
      expect(onDeleteRequest).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('ignores keys while a delete is in flight', async () => {
      const { promise, resolve } = deferred();
      const onDeleteRequest = vi.fn(() => promise);
      const component = new SessionPickerComponent({
        sessions: [alpha, beta],
        loading: false,
        currentSessionId: '',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onDeleteRequest,
      });

      component.handleInput(CTRL_X);
      component.handleInput('y');
      component.handleInput('y');
      component.handleInput(CTRL_X);
      component.handleInput('\r');
      component.handleInput(ESC);

      expect(onDeleteRequest).toHaveBeenCalledOnce();

      resolve();
      await flushMicrotasks();
    });

    it('returns to the list when the delete fails', async () => {
      const { promise, reject } = deferred();
      const onDeleteRequest = vi.fn(() => promise);
      const component = new SessionPickerComponent({
        sessions: [alpha, beta],
        loading: false,
        currentSessionId: '',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onDeleteRequest,
      });

      component.handleInput(CTRL_X);
      component.handleInput('y');
      reject(new Error('boom'));
      await flushMicrotasks();

      const output = renderPlain(component);
      expect(output).not.toContain('Deleting session');
      expect(output).not.toContain('Delete session');
      expect(onDeleteRequest).toHaveBeenCalledOnce();
    });

    it('adds Ctrl+X delete to the hint when deletion is available', () => {
      const component = new SessionPickerComponent({
        sessions: [alpha],
        loading: false,
        currentSessionId: '',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onDeleteRequest: vi.fn(async () => {}),
      });

      expect(renderPlain(component)).toContain('Ctrl+X delete');
    });

    it('ignores input while a selection is in flight', async () => {
      const { promise, resolve } = deferred();
      const onSelect = vi.fn(() => promise);
      const onDeleteRequest = vi.fn(async () => {});
      const requestRender = vi.fn();
      const component = new SessionPickerComponent({
        sessions: [alpha, beta],
        loading: false,
        currentSessionId: '',
        onSelect,
        onCancel: vi.fn(),
        requestRender,
        onDeleteRequest,
      });

      component.handleInput('\r');
      expect(onSelect).toHaveBeenCalledOnce();
      expect(renderPlain(component)).toContain('Resuming session…');
      expect(requestRender).toHaveBeenCalledOnce();

      component.handleInput(CTRL_X);
      expect(renderPlain(component)).not.toContain('Delete session');
      component.handleInput('y');
      component.handleInput('\r');
      expect(onSelect).toHaveBeenCalledOnce();
      expect(onDeleteRequest).not.toHaveBeenCalled();

      resolve();
      await flushMicrotasks();
      expect(renderPlain(component)).not.toContain('Resuming session…');
      expect(requestRender).toHaveBeenCalledTimes(2);

      component.handleInput(CTRL_X);
      expect(renderPlain(component)).toContain('Delete session "Alpha session"? [y/N]');
    });

    it('unlocks input when the selection fails', async () => {
      const { promise, reject } = deferred();
      const onSelect = vi.fn(() => promise);
      const component = new SessionPickerComponent({
        sessions: [alpha, beta],
        loading: false,
        currentSessionId: '',
        onSelect,
        onCancel: vi.fn(),
        onDeleteRequest: vi.fn(async () => {}),
      });

      component.handleInput('\r');
      expect(onSelect).toHaveBeenCalledOnce();

      reject(new Error('boom'));
      await flushMicrotasks();

      component.handleInput(CTRL_X);
      expect(renderPlain(component)).toContain('Delete session "Alpha session"? [y/N]');
    });

    it('keeps every line within the terminal width with a delete confirmation armed', () => {
      const component = new SessionPickerComponent({
        sessions: [alpha, beta],
        loading: false,
        currentSessionId: '',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onDeleteRequest: vi.fn(async () => {}),
      });
      component.handleInput(CTRL_X);

      for (const width of [10, 20, 24, 40]) {
        for (const line of component.render(width)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    });

    it('keeps the [y/N] confirmation keys visible when the title is truncated', () => {
      const longTitled = {
        id: 'ses_long',
        title: 'A very long session title that cannot fit a narrow terminal',
        work_dir: '/tmp/p',
        updated_at: 2,
      };
      const component = new SessionPickerComponent({
        sessions: [longTitled],
        loading: false,
        currentSessionId: '',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onDeleteRequest: vi.fn(async () => {}),
      });

      component.handleInput(CTRL_X);

      for (const width of [40, 24, 20, 12, 8]) {
        expect(renderPlain(component, width)).toContain('? [y/N]');
      }
    });
  });

  it('tags worktree and missing working directories after the directory', () => {
    const component = new SessionPickerComponent({
      sessions: [
        { id: 'ses_wt', title: 'In a worktree', work_dir: '/tmp/wt/x', worktree: 'x', updated_at: 0 },
        { id: 'ses_gone', title: 'Gone', work_dir: '/tmp/gone', missing: true, updated_at: 0 },
        { id: 'ses_plain', title: 'Plain', work_dir: '/tmp/project', updated_at: 0 },
      ],
      loading: false,
      currentSessionId: '',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = renderPlain(component).split('\n');
    expect(lines.find((line) => line.includes('ses_wt'))).toMatch(/\/tmp\/wt\/x {3}worktree x$/);
    expect(lines.find((line) => line.includes('ses_gone'))).toMatch(/\/tmp\/gone {3}missing$/);
    expect(lines.find((line) => line.includes('ses_plain'))).toMatch(/\/tmp\/project$/);
  });

  describe('three-tab scope navigation and fullscreen mouse', () => {
    const sessions = [
      { id: 'ses_1', title: 'First session', work_dir: '/tmp/project', updated_at: 10 },
      { id: 'ses_2', title: 'Second session', work_dir: '/tmp/wt/feat', worktree: 'feat', updated_at: 20 },
      { id: 'ses_3', title: 'Third session', work_dir: '/tmp/other', updated_at: 30 },
    ];

    it('hides the tab strip for non-git directories and shows Cwd / Project / All tabs for git repos', () => {
      const nonGit = new SessionPickerComponent({
        sessions,
        loading: false,
        currentSessionId: '',
        scope: 'cwd',
        showTabs: false,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onSelectScope: vi.fn(),
      });
      const nonGitOut = renderPlain(nonGit);
      expect(nonGitOut).not.toContain('Project');
      expect(nonGitOut).not.toContain('Tab switch');

      const git = new SessionPickerComponent({
        sessions,
        loading: false,
        currentSessionId: '',
        scope: 'project',
        showTabs: true,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onSelectScope: vi.fn(),
      });
      const gitOut = renderPlain(git);
      expect(gitOut).toContain('Project sessions');
      expect(gitOut).toContain('Cwd');
      expect(gitOut).toContain('Project');
      expect(gitOut).toContain('All');
      expect(gitOut).toContain('Tab switch');
      expect(gitOut).toContain('Ctrl+A all');
    });

    it('cycles Cwd -> Project -> All with Tab/Shift+Tab and keeps Ctrl+A toggling All', () => {
      const onSelectScope = vi.fn();
      const makePicker = (scope: 'cwd' | 'project' | 'all') =>
        new SessionPickerComponent({
          sessions,
          loading: false,
          currentSessionId: '',
          scope,
          showTabs: true,
          onSelect: vi.fn(),
          onCancel: vi.fn(),
          onSelectScope,
        });
      makePicker('cwd').handleInput('\t');
      makePicker('cwd').handleInput('\u001B[Z');
      makePicker('cwd').handleInput('\u0001');

      expect(onSelectScope.mock.calls).toEqual([
        ['project', 'ses_1'],
        ['all', 'ses_1'],
        ['all', 'ses_1'],
      ]);

      onSelectScope.mockClear();
      makePicker('all').handleInput('\u0001');
      expect(onSelectScope).toHaveBeenCalledExactlyOnceWith('cwd', 'ses_1');
    });

    it('switches tabs on mouse click and supports fullscreen ScrollView move/click/wheel', async () => {
      let now = 10_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const onSelectScope = vi.fn();
      const onSelect = vi.fn();
      const picker = new SessionPickerComponent({
        sessions,
        loading: false,
        currentSessionId: '',
        scope: 'cwd',
        showTabs: true,
        layout: { maxBodyRows: 6 },
        onSelect,
        onCancel: vi.fn(),
        onSelectScope,
      });
      const vt = new VirtualTerminal(100, 16);
      const ui = new TuiAltScreen(vt);
      ui.setLayoutRoot(picker);
      ui.start();
      ui.setFocus(picker);
      await vt.waitForRender();
      try {
        let lines = vt.getViewport().map((line) => stripAnsi(line));
        const tabRow = lines.findIndex(
          (line) => line.includes('Cwd') && line.includes('Project') && line.includes('All'),
        );
        expect(tabRow).toBeGreaterThan(0);
        const projectCol = lines[tabRow]!.indexOf('Project') + 1;
        const secondCardRow = lines.findIndex((line) => line.includes('Second session'));
        expect(secondCardRow).toBeGreaterThan(tabRow);

        now += 500;
        vt.sendInput(`\u001B[<0;${String(projectCol + 1)};${String(tabRow + 1)}M`);
        vt.sendInput(`\u001B[<0;${String(projectCol + 1)};${String(tabRow + 1)}m`);
        await vt.waitForRender();
        expect(onSelectScope).toHaveBeenCalledWith('project', 'ses_1');

        vt.sendInput(`\u001B[<35;6;${String(secondCardRow + 1)}M`);
        await vt.waitForRender();
        lines = vt.getViewport().map((line) => stripAnsi(line));
        expect(lines[secondCardRow]).toContain('❯ Second session');

        vt.sendInput(`\u001B[<0;6;${String(secondCardRow + 1)}M`);
        vt.sendInput(`\u001B[<0;6;${String(secondCardRow + 1)}m`);
        await vt.waitForRender();
        expect(onSelect).toHaveBeenCalledWith(sessions[1]);

        vt.sendInput(`\u001B[<65;6;${String(secondCardRow + 1)}M`);
        vt.sendInput(`\u001B[<65;6;${String(secondCardRow + 1)}M`);
        vt.sendInput(`\u001B[<65;6;${String(secondCardRow + 1)}M`);
        await vt.waitForRender();
        lines = vt.getViewport().map((line) => stripAnsi(line));
        const thirdCardRow = lines.findIndex((line) => line.includes('Third session'));
        expect(thirdCardRow).toBeGreaterThan(tabRow);

        vt.sendInput(`\u001B[<0;6;${String(thirdCardRow + 1)}M`);
        vt.sendInput(`\u001B[<0;6;${String(thirdCardRow + 1)}m`);
        await vt.waitForRender();
        expect(onSelect).toHaveBeenLastCalledWith(sessions[2]);
      } finally {
        ui.stop();
      }
    });

    it('reveals newly appended pages when wheel scrolling loads more in fullscreen mode', async () => {
      const page1 = [
        { id: 'ses_1', title: 'Page 1 first', work_dir: '/repo', updated_at: 100 },
        { id: 'ses_2', title: 'Page 1 second', work_dir: '/repo', updated_at: 90 },
        { id: 'ses_3', title: 'Page 1 third', work_dir: '/repo', updated_at: 85 },
      ];
      const page2 = [
        { id: 'ses_4', title: 'Page 2 fourth', work_dir: '/repo', updated_at: 80 },
      ];
      const vt = new VirtualTerminal(100, 14);
      const ui = new TuiAltScreen(vt);
      const onLoadMore = vi.fn(() => {
        picker.appendSessions(page2);
        picker.setPaging(false, false);
        ui.requestRender();
      });
      const picker = new SessionPickerComponent({
        sessions: page1,
        loading: false,
        currentSessionId: '',
        scope: 'cwd',
        showTabs: true,
        pageSize: 3,
        hasMore: true,
        layout: { maxBodyRows: 5 },
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onLoadMore,
        requestRender: () => ui.requestRender(),
      });
      ui.setLayoutRoot(picker);
      ui.start();
      ui.setFocus(picker);
      await vt.waitForRender();
      try {
        const linesBefore = vt.getViewport().map((line) => stripAnsi(line));
        const bodyRow = linesBefore.findIndex((line) => line.includes('Page 1 first'));
        expect(bodyRow).toBeGreaterThan(0);

        vt.sendInput(`\u001B[<65;6;${String(bodyRow + 1)}M`);
        vt.sendInput(`\u001B[<65;6;${String(bodyRow + 1)}M`);
        vt.sendInput(`\u001B[<65;6;${String(bodyRow + 1)}M`);
        await vt.waitForRender();
        expect(onLoadMore).toHaveBeenCalledOnce();

        vt.sendInput(`\u001B[<65;6;${String(bodyRow + 1)}M`);
        vt.sendInput(`\u001B[<65;6;${String(bodyRow + 1)}M`);
        vt.sendInput(`\u001B[<65;6;${String(bodyRow + 1)}M`);
        await vt.waitForRender();
        const linesAfter = vt.getViewport().map((line) => stripAnsi(line)).join('\n');
        expect(linesAfter).toContain('Page 2 fourth');
      } finally {
        ui.stop();
      }
    });

    it('tracks pending scope transitions so rapid Tab presses advance and can cancel back to cwd', () => {
      const onSelectScope = vi.fn();
      const picker = new SessionPickerComponent({
        sessions: [{ id: 'ses_1', title: 'One', work_dir: '/repo', updated_at: 100 }],
        loading: false,
        currentSessionId: 'ses_1',
        scope: 'cwd',
        showTabs: true,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onSelectScope,
      });

      picker.handleInput('\t');
      picker.handleInput('\t');
      picker.handleInput('\t');
      expect(onSelectScope.mock.calls).toEqual([
        ['project', 'ses_1'],
        ['all', 'ses_1'],
        ['cwd', 'ses_1'],
      ]);

      onSelectScope.mockClear();
      picker.handleInput('\t');
      expect(onSelectScope).toHaveBeenCalledWith('project', 'ses_1');
      picker.clearPendingScope();
      picker.handleInput('\t');
      expect(onSelectScope.mock.calls).toEqual([
        ['project', 'ses_1'],
        ['project', 'ses_1'],
      ]);
    });
  });
});
