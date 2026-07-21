import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ModelScopeSelectorComponent } from '#/tui/components/dialogs/model-scope-selector';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

const availableModels: Record<string, ModelAlias> = {
  'kimi-k3': {
    provider: 'managed:kimi-code',
    model: 'kimi-k3',
    maxContextSize: 262144,
    displayName: 'Kimi K3',
  },
  'glm-5.2': {
    provider: 'zai',
    model: 'glm-5.2',
    maxContextSize: 131072,
    displayName: 'GLM-5.2',
  },
};

describe('ModelScopeSelectorComponent', () => {
  it('shows resolved display names for both scopes', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new ModelScopeSelectorComponent({
      currentModel: 'kimi-k3',
      currentSubagentModel: 'glm-5.2',
      currentSubagentThinkingEffort: undefined,
      availableModels,
      onSelect,
      onCancel,
    });

    const out = picker.render(120).map(strip);

    expect(out.some((l) => l.includes('Main agent — Kimi K3'))).toBe(true);
    expect(out.some((l) => l.includes('Subagents — GLM-5.2'))).toBe(true);
  });

  it('shows "(inherits main model)" when currentSubagentModel is undefined', () => {
    const picker = new ModelScopeSelectorComponent({
      currentModel: 'kimi-k3',
      currentSubagentModel: undefined,
      currentSubagentThinkingEffort: undefined,
      availableModels,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = picker.render(120).map(strip);

    expect(out.some((l) => l.includes('Subagents — (inherits main model)'))).toBe(true);
  });

  it('appends the effort suffix when currentSubagentThinkingEffort is set', () => {
    const picker = new ModelScopeSelectorComponent({
      currentModel: 'kimi-k3',
      currentSubagentModel: 'glm-5.2',
      currentSubagentThinkingEffort: 'high',
      availableModels,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = picker.render(120).map(strip);

    expect(out.some((l) => l.includes('Subagents — GLM-5.2 (effort: high)'))).toBe(true);
  });

  it('fires onSelect with "main" for the main option and "subagent" for the subagent option', () => {
    const onSelect = vi.fn();
    const picker = new ModelScopeSelectorComponent({
      currentModel: 'kimi-k3',
      currentSubagentModel: 'glm-5.2',
      currentSubagentThinkingEffort: undefined,
      availableModels,
      onSelect,
      onCancel: vi.fn(),
    });

    // First option is "main" and starts selected.
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('main');

    // Move down to the subagent option and select it.
    picker.handleInput('\u001B[B'); // ↓
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('subagent');
  });
});
