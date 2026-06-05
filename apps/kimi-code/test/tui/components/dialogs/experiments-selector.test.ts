import type { ExperimentalFeatureState } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '#/tui/components/dialogs/experiments-selector';
import { darkColors } from '#/tui/theme/colors';

const ANSI = /\u001B\[[0-9;]*m/g;
const ESC = String.fromCodePoint(27);
const DOWN = `${ESC}[B`;
const ENTER = '\r';

function strip(text: string): string {
  return text.replaceAll(ANSI, '');
}

function feature(
  overrides: Partial<ExperimentalFeatureState> = {},
): ExperimentalFeatureState {
  return {
    id: 'goal_command',
    title: 'Goal command',
    description: 'Enable goal mode.',
    surface: 'both',
    env: 'KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND',
    defaultEnabled: false,
    enabled: false,
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
        feature({
          id: 'background_ask',
          title: 'Background questions',
          description: 'Ask questions without blocking the current turn.',
          env: 'KIMI_CODE_EXPERIMENTAL_BACKGROUND_ASK',
          enabled: false,
          source: 'env',
        }),
      ],
      colors: darkColors,
      onApply: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(selector);

    expect(out).toContain(' Experimental features  (type to search)');
    expect(out).toContain(' ↑↓ navigate · Space toggle · Enter apply · Esc cancel');
    expect(out).toContain('  ❯ Goal command  enabled');
    expect(out).toContain('    id goal_command · config · KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND');
    expect(out).toContain('    Enable goal mode.');
    expect(out).toContain('    Background questions  disabled');
    expect(out).toContain('    id background_ask · locked by KIMI_CODE_EXPERIMENTAL_BACKGROUND_ASK');
    expect(out).toContain(' [ Apply changes and reload ]  no changes');
  });

  it('drafts changes with Space and applies them with Enter', () => {
    const onApply = vi.fn<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const first = feature({ id: 'goal_command', title: 'Goal command' });
    const second = feature({
      id: 'micro_compaction',
      title: 'Micro compaction',
      env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    });
    const selector = new ExperimentsSelectorComponent({
      features: [first, second],
      colors: darkColors,
      onApply,
      onCancel: vi.fn(),
    });

    selector.handleInput(' ');

    expect(onApply).not.toHaveBeenCalled();
    expect(text(selector)).toContain('  ❯ Goal command  enabled');
    expect(text(selector)).toContain(
      '    id goal_command · default · KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND · modified',
    );
    expect(text(selector)).toContain(' [ Apply changes and reload ]  1 change');

    selector.handleInput(DOWN);
    selector.handleInput(' ');
    selector.handleInput(ENTER);

    expect(onApply).toHaveBeenCalledWith([
      { id: 'goal_command', enabled: true },
      { id: 'micro_compaction', enabled: true },
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
      colors: darkColors,
      onApply,
      onCancel: vi.fn(),
    });

    selector.handleInput(' ');
    selector.handleInput(ENTER);

    expect(text(selector)).toContain('  ❯ Goal command  enabled');
    expect(text(selector)).toContain(' [ Apply changes and reload ]  no changes');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('filters by typing and clears the query before cancelling', () => {
    const onCancel = vi.fn();
    const selector = new ExperimentsSelectorComponent({
      features: [
        feature({ id: 'goal_command', title: 'Goal command' }),
        feature({
          id: 'background_ask',
          title: 'Background questions',
          env: 'KIMI_CODE_EXPERIMENTAL_BACKGROUND_ASK',
        }),
      ],
      colors: darkColors,
      onApply: vi.fn(),
      onCancel,
    });

    selector.handleInput('b');
    selector.handleInput('a');
    selector.handleInput('c');
    selector.handleInput('k');
    expect(text(selector)).toContain('Search: back');
    expect(text(selector)).toContain('Background questions');
    expect(text(selector)).not.toContain('Goal command');

    selector.handleInput(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    selector.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
