/**
 * ModelScopeSelectorComponent — a small picker that lets the user choose
 * which model scope to configure when the `dual-model-routing` experimental
 * feature is active:
 *
 *   - "main"     → configure the main agent's model
 *   - "subagent" → configure the subagent model (used by spawned subagents)
 *
 * It is a thin wrapper around ChoicePickerComponent, mirroring
 * PermissionSelectorComponent. Mounted via `mountEditorReplacement`.
 */

import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { modelDisplayName } from './model-selector';

export type ModelScope = 'main' | 'subagent';

export interface ModelScopeSelectorOptions {
  /** Current main-agent model alias. */
  readonly currentModel: string;
  /** Current subagent model alias, or undefined when unset. */
  readonly currentSubagentModel: string | undefined;
  /** Current subagent thinking effort, or undefined when unset. */
  readonly currentSubagentThinkingEffort: string | undefined;
  /** Catalog of available models (alias → definition) for display names. */
  readonly availableModels: Record<string, ModelAlias>;
  readonly onSelect: (scope: ModelScope) => void;
  readonly onCancel: () => void;
}

function isModelScope(value: string): value is ModelScope {
  return value === 'main' || value === 'subagent';
}

export class ModelScopeSelectorComponent extends ChoicePickerComponent {
  constructor(opts: ModelScopeSelectorOptions) {
    const mainName = modelDisplayName(opts.currentModel, opts.availableModels[opts.currentModel]);
    const effort = opts.currentSubagentThinkingEffort;
    const hasEffort = effort !== undefined && effort.length > 0;
    let subagentName: string;
    if (opts.currentSubagentModel !== undefined && opts.currentSubagentModel.length > 0) {
      const model = modelDisplayName(
        opts.currentSubagentModel,
        opts.availableModels[opts.currentSubagentModel],
      );
      subagentName = hasEffort ? `${model} (effort: ${effort})` : model;
    } else {
      // The model is inherited, but a configured subagent effort still
      // applies — show it so the label reflects the effective settings.
      subagentName = hasEffort ? `(inherits main model, effort: ${effort})` : '(inherits main model)';
    }

    const options: readonly ChoiceOption[] = [
      {
        value: 'main',
        label: `Main agent — ${mainName}`,
        description: 'The model that runs your conversation and owns the main turn.',
      },
      {
        value: 'subagent',
        label: `Subagents — ${subagentName}`,
        description:
          'The model used by delegated subagents (task, explore, swarm). When set, subagents run on this model instead of the main model.',
      },
    ];

    super({
      title: 'Select model scope',
      options,
      onSelect: (value) => {
        if (isModelScope(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
