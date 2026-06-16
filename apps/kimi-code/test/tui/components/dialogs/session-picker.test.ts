import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionPickerComponent } from '#/tui/components/dialogs/session-picker';

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
    // Session id is rendered in full, never abbreviated with an ellipsis.
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
    // Title and time sit side-by-side with only the small inline separator.
    expect(headerLine).toMatch(/Short title\s{1,4}5m ago/);
    // No long run of trailing spaces, i.e. not right-aligned.
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

  // Regression for #240: a long session id, the inline time + "(current)"
  // badge, and a long prompt all used to be appended past the terminal edge,
  // which crashed the renderer with "Rendered line exceeds terminal width" on
  // very narrow terminals.
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
});
