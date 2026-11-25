import type { ExperimentalFeatureState } from '@moonshot-ai/kimi-code-sdk';
import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '#/tui/components/dialogs/experiments-selector';


const ANSI = /\u001B\[[0-9;]*m/g;
const ESC = String.fromCodePoint(27);
const ENTER = '\r';

function strip(text: string): string {
  return text.replaceAll(ANSI, '');
}

function feature(
  overrides: Partial<ExperimentalFeatureState> = {},
): ExperimentalFeatureState {
  return {
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older tool results.',
    surface: 'core',
    env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    defaultEnabled: true,
    enabled: true,
    source: 'default',
    ...overrides,
  };
}

function text(component: ExperimentsSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('ExperimentsSelectorComponent', () => {
  it('renders searchable feature toggles with source details', () => {
    const selector = new ExperimentsSelectorComponent({
      features: [
        feature({ enabled: true, source: 'config', configValue: true }),
      ],
      onApply: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(selector);

    expect(out).toContain(' Experimental features  (type to search)');
    expect(out).toContain(' ↑↓ navigate · Space toggle · Enter apply · Esc cancel');
    expect(out).toContain('  ❯ Micro compaction  enabled');
    expect(out).toContain('    id micro_compaction · config · KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION');
    expect(out).toContain('    Trim older tool results.');
    expect(out).toContain(' [ Apply changes and reload ]  no changes');
  });

  it('drafts changes with Space and applies them with Enter', () => {
    const onApply = vi.fn<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const first = feature();
    const selector = new ExperimentsSelectorComponent({
      features: [first],
      onApply,
      onCancel: vi.fn(),
    });

    selector.handleInput(' ');

    expect(onApply).not.toHaveBeenCalled();
    expect(text(selector)).toContain('  ❯ Micro compaction  disabled');
    expect(text(selector)).toContain(
      '    id micro_compaction · default · KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION · modified',
    );
    expect(text(selector)).toContain(' [ Apply changes and reload ]  1 change');

    selector.handleInput(ENTER);

    expect(onApply).toHaveBeenCalledWith([
      { id: 'micro_compaction', enabled: false },
    ]);
  });

  it('does not draft changes for env-locked features', () => {
    const onApply = vi.fn<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const selector = new ExperimentsSelectorComponent({
      features: [
        feature({
          enabled: true,
          source: 'env',
        }),
      ],
      onApply,
      onCancel: vi.fn(),
    });

    selector.handleInput(' ');
    selector.handleInput(ENTER);

    expect(text(selector)).toContain('  ❯ Micro compaction  enabled');
    expect(text(selector)).toContain(' [ Apply changes and reload ]  no changes');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('filters by typing and clears the query before cancelling', () => {
    const onCancel = vi.fn();
    const selector = new ExperimentsSelectorComponent({
      features: [feature()],
      onApply: vi.fn(),
      onCancel,
    });

    selector.handleInput('m');
    selector.handleInput('i');
    selector.handleInput('c');
    expect(text(selector)).toContain('Search: mic');
    expect(text(selector)).toContain('Micro compaction');

    selector.handleInput(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    selector.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  function pointerEvent(
    type: TuiMouseEvent['type'],
    y: number,
    wheelDelta?: number,
  ): TuiMouseEvent {
    return {
      type,
      button: type === 'move' || type === 'wheel' ? 'none' : 'left',
      x: 6,
      y,
      screenX: 6,
      screenY: y,
      width: 120,
      height: 30,
      shift: false,
      alt: false,
      ctrl: false,
      ...(wheelDelta !== undefined ? { wheelDelta } : {}),
    };
  }

  function enableFakeDate(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }

  it('supports hover, row toggle clicks, apply button click, and unfocused/settling guards', () => {
    enableFakeDate();
    const onApply = vi.fn<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const selector = new ExperimentsSelectorComponent({
      features: [
        feature({ id: 'first', title: 'First Feature', enabled: true }),
        feature({ id: 'second', title: 'Second Feature', enabled: false }),
        feature({ id: 'locked', title: 'Locked Feature', enabled: true, source: 'env' }),
      ],
      onApply,
      onCancel: vi.fn(),
    });
    const lines = selector.render(120).map(strip);
    const secondRow = lines.findIndex((line) => line.includes('Second Feature'));
    const lockedRow = lines.findIndex((line) => line.includes('Locked Feature'));
    const applyRow = lines.findIndex((line) => line.includes('[ Apply changes and reload ]'));

    expect(selector.handleMouse(pointerEvent('press', secondRow))).toEqual({ handled: true });
    expect(selector.handleMouse(pointerEvent('click', secondRow))).toEqual({
      handled: true,
      focus: true,
    });
    expect(onApply).not.toHaveBeenCalled();

    selector.focused = true;
    expect(selector.handleMouse(pointerEvent('click', secondRow))).toEqual({ handled: true });
    expect(text(selector)).toContain('Second Feature  disabled');

    vi.advanceTimersByTime(300);
    expect(selector.handleMouse(pointerEvent('move', secondRow + 1))).toEqual({
      handled: true,
      render: true,
    });
    expect(selector.render(120).map(strip)[secondRow]).toContain('❯ Second Feature');

    selector.handleMouse(pointerEvent('press', applyRow));
    selector.handleMouse(pointerEvent('click', applyRow));
    expect(onApply).not.toHaveBeenCalled();

    selector.handleMouse(pointerEvent('press', secondRow));
    expect(selector.handleMouse(pointerEvent('click', lockedRow))).toEqual({ handled: true });
    expect(text(selector)).toContain('Second Feature  disabled');

    selector.handleMouse(pointerEvent('press', lockedRow));
    selector.handleMouse(pointerEvent('click', lockedRow));
    expect(text(selector)).toContain('Locked Feature  enabled');

    selector.handleMouse(pointerEvent('press', secondRow + 2));
    selector.handleMouse(pointerEvent('click', secondRow + 2));
    expect(text(selector)).toContain('Second Feature  enabled');
    expect(text(selector)).toContain('[ Apply changes and reload ]  1 change');

    selector.handleMouse(pointerEvent('press', applyRow));
    selector.handleMouse(pointerEvent('click', applyRow));
    expect(onApply).toHaveBeenCalledWith([{ id: 'second', enabled: true }]);
  });

  it('pages long lists on wheel and consumes wheel on short lists', () => {
    const shortSelector = new ExperimentsSelectorComponent({
      features: [feature()],
      onApply: vi.fn(),
      onCancel: vi.fn(),
    });
    shortSelector.focused = true;
    shortSelector.render(120);
    expect(shortSelector.handleMouse(pointerEvent('wheel', 4, 1))).toEqual({
      handled: true,
      render: false,
    });

    const many = Array.from({ length: 10 }, (_, idx) =>
      feature({ id: `feat_${String(idx + 1)}`, title: `Feature ${String(idx + 1)}` }),
    );
    const longSelector = new ExperimentsSelectorComponent({
      features: many,
      onApply: vi.fn(),
      onCancel: vi.fn(),
    });
    longSelector.focused = true;
    longSelector.render(120);
    expect(longSelector.handleMouse(pointerEvent('wheel', 4, 1))).toEqual({
      handled: true,
      render: true,
    });
    expect(text(longSelector)).toContain('Feature 9');
    expect(longSelector.handleMouse(pointerEvent('wheel', 4, -1))).toEqual({
      handled: true,
      render: true,
    });
    expect(text(longSelector)).toContain('Feature 1');
  });
});
