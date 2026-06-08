import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionPickerComponent } from '#/tui/components/dialogs/session-picker';
import { getColorPalette } from '#/tui/theme/colors';

function stripAnsi(text: string): string {
  return text.replaceAll(/\[[0-?]*[ -/]*[@-~]/g, '');
}

function renderPlain(component: SessionPickerComponent, width = 120): string {
  return stripAnsi(component.render(width).join('\n'));
}

describe('SessionPickerComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
      colors: getColorPalette('dark'),
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
      colors: getColorPalette('dark'),
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
      colors: getColorPalette('dark'),
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
      colors: getColorPalette('dark'),
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
      colors: getColorPalette('dark'),
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
      colors: getColorPalette('dark'),
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
      colors: getColorPalette('dark'),
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
      colors: getColorPalette('dark'),
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
      colors: getColorPalette('dark'),
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
});
