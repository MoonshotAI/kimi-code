import type {
  BetaMasterSwitchState,
  ExperimentalFeatureState,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '#/tui/components/dialogs/experiments-selector';

const ANSI = /\u001B\[[0-9;]*m/g;
const ESC = String.fromCodePoint(27);
const ENTER = '\r';
const DOWN = '\u001B[B';

function strip(text: string): string {
  return text.replaceAll(ANSI, '');
}

function feature(
  overrides: Partial<ExperimentalFeatureState> = {},
): ExperimentalFeatureState {
  return {
    id: 'prompt_prediction',
    title: 'Prompt prediction',
    description: 'Predict the next prompt after a completed main-agent turn.',
    stage: 'experimental',
    effectTiming: 'immediate',
    env: 'KIMI_CODE_EXPERIMENTAL_PROMPT_PREDICTION',
    enabled: false,
    active: false,
    source: 'default',
    ...overrides,
  };
}

function betaState(
  overrides: Partial<BetaMasterSwitchState> = {},
): BetaMasterSwitchState {
  return {
    profile: 'cli',
    enabled: false,
    source: 'default',
    env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
    ...overrides,
  };
}

function text(component: ExperimentsSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('ExperimentsSelectorComponent', () => {
  it('renders Beta and Experimental tiers, omits GA features, and shows effect timing hints', () => {
    const selector = new ExperimentsSelectorComponent({
      betaState: betaState(),
      features: [
        feature({
          id: 'notify_user',
          title: 'NotifyUser tool',
          stage: 'ga',
          enabled: true,
          active: true,
        }),
        feature({
          id: 'tower',
          title: 'Tower mode',
          description: 'Coordinate multiple agents on a shared objective.',
          stage: 'experimental',
          effectTiming: 'restart',
          env: 'KIMI_CODE_EXPERIMENTAL_TOWER',
          enabled: true,
          active: false,
          source: 'config',
          configValue: true,
        }),
      ],
      onApply: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(selector);

    expect(out).toContain(' Lab  (type to search)');
    expect(out).toContain(' ↑↓ navigate · Space toggle · Enter apply · Esc cancel');
    expect(out).toContain(' Beta  Coming soon — try them early');
    expect(out).toContain('  ❯ Enable all Beta features  disabled');
    expect(out).toContain(
      ' Experimental  Agent explorations — still evolving, review and enable as needed',
    );
    expect(out).toContain('    Tower mode  enabled');
    expect(out).toContain('    id tower · config · KIMI_CODE_EXPERIMENTAL_TOWER · restart required');
    expect(out).not.toContain('NotifyUser tool');
    expect(out).toContain(' [ Apply changes and reload ]  no changes');
  });

  it('dynamically locks child Beta features without mutating their config when toggling Enable all Beta features', () => {
    const onApply = vi.fn<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const selector = new ExperimentsSelectorComponent({
      betaState: betaState(),
      features: [
        feature({
          id: 'context_preview',
          title: 'Context preview',
          stage: 'beta',
          effectTiming: 'next-session',
          env: 'KIMI_CODE_EXPERIMENTAL_CONTEXT_PREVIEW',
          enabled: false,
          active: false,
          source: 'config',
          configValue: false,
        }),
        feature(),
      ],
      onApply,
      onCancel: vi.fn(),
    });

    selector.handleInput(' ');
    const afterMasterOn = text(selector);
    expect(afterMasterOn).toContain('  ❯ Enable all Beta features  enabled');
    expect(afterMasterOn).toContain('    Context preview  enabled');
    expect(afterMasterOn).toContain(
      '    id context_preview · config · KIMI_CODE_EXPERIMENTAL_CONTEXT_PREVIEW · new sessions',
    );
    expect(afterMasterOn).not.toContain('locked by Enable all Beta features');
    expect(afterMasterOn).toContain('    Prompt prediction  disabled');

    selector.handleInput(DOWN);
    selector.handleInput(' ');
    expect(text(selector)).toContain('  ❯ Context preview  enabled');

    selector.handleInput(ENTER);
    expect(onApply).toHaveBeenCalledWith([{ id: 'beta', enabled: true }]);
  });

  it('does not draft changes for env-locked master or per-feature switches', () => {
    const onApply = vi.fn<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const selector = new ExperimentsSelectorComponent({
      betaState: betaState({ enabled: true, source: 'env' }),
      features: [
        feature({
          enabled: true,
          active: true,
          source: 'env',
        }),
      ],
      onApply,
      onCancel: vi.fn(),
    });

    selector.handleInput(' ');
    selector.handleInput(DOWN);
    selector.handleInput(' ');
    selector.handleInput(ENTER);

    expect(text(selector)).toContain('locked by KIMI_CODE_EXPERIMENTAL_FLAG');
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

    selector.handleInput('p');
    selector.handleInput('r');
    selector.handleInput('o');
    expect(text(selector)).toContain('Search: pro');
    expect(text(selector)).toContain('Prompt prediction');

    selector.handleInput(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    selector.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
