import {
  catalogModelToAlias,
  inferWireType,
  type Catalog,
  type CatalogModel,
  type KimiConfig,
  type ModelAlias,
} from '@moonshot-ai/kimi-code-sdk';
import { capabilitiesForModel } from '@moonshot-ai/kimi-code-oauth';
import type {
  ManagedKimiCodeModelInfo,
  OpenPlatformDefinition,
} from '@moonshot-ai/kimi-code-oauth';

import {
  ApiKeyInputDialogComponent,
  type ApiKeyInputDialogOptions,
  type ApiKeyInputResult,
} from '../components/dialogs/api-key-input-dialog';
import {
  CatalogModelMultiSelectComponent,
  type ModelMultiSelection,
} from '../components/dialogs/catalog-model-multi-select';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { FeedbackInputDialogComponent, type FeedbackInputDialogResult } from '../components/dialogs/feedback-input-dialog';
import { ModelSelectorComponent } from '../components/dialogs/model-selector';
import { PlatformSelectorComponent } from '../components/dialogs/platform-selector';
import {
  catalogModelSelectionInitialState,
  configuredProviderModelCounts,
  type CatalogModelSelectionInitialState,
} from '../utils/connect-catalog';
import type { SlashCommandHost } from './dispatch';

export function promptPlatformSelection(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    const selector = new PlatformSelectorComponent({
      colors: host.state.theme.colors,
      onSelect: (platformId) => {
        host.restoreEditor();
        resolve(platformId);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector);
  });
}

export function promptLogoutProviderSelection(
  host: SlashCommandHost,
  options: readonly ChoiceOption[],
  currentValue: string | undefined,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Select a provider to log out',
      options,
      currentValue,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptFeedbackInput(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new FeedbackInputDialogComponent((result: FeedbackInputDialogResult) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? result.value : undefined);
    }, host.state.theme.colors);
    host.mountEditorReplacement(dialog);
  });
}

export function promptApiKey(
  host: SlashCommandHost,
  platformName: string,
  options: ApiKeyInputDialogOptions = {},
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      host.state.theme.colors,
      options,
    );
    host.mountEditorReplacement(dialog);
  });
}

export function promptCatalogProviderSelection(
  host: SlashCommandHost,
  catalog: Catalog,
  config: KimiConfig,
): Promise<string | undefined> {
  const counts = configuredProviderModelCounts(config);
  const formatBadge = (count: number): string =>
    `← configured · ${String(count)} model${count === 1 ? '' : 's'}`;

  const options: ChoiceOption[] = Object.entries(catalog)
    .filter(([, entry]) => inferWireType(entry) !== undefined)
    .map(([id, entry]) => {
      const count = counts.get(id);
      return {
        value: id,
        label: entry.name ?? id,
        description:
          typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : undefined,
        badge: count !== undefined ? formatBadge(count) : undefined,
      };
    })
    .toSorted((a, b) => {
      const aConfigured = a.badge !== undefined;
      const bConfigured = b.badge !== undefined;
      if (aConfigured !== bConfigured) return aConfigured ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

  if (options.length === 0) {
    host.showError('Catalog has no providers with supported wire types.');
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Select a provider',
      options,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export async function promptModelSelectionForOpenPlatform(
  host: SlashCommandHost,
  models: ManagedKimiCodeModelInfo[],
  platform: OpenPlatformDefinition,
): Promise<{ model: ManagedKimiCodeModelInfo; thinking: boolean } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${platform.id}/${m.id}`] = {
      provider: platform.id,
      model: m.id,
      maxContextSize: m.contextLength,
      capabilities: capabilitiesForModel(m),
      displayName: m.displayName,
    };
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${platform.id}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

/**
 * Outcome of the /connect model picker for an already-resolved provider.
 * `select` carries the models to write; `remove` means the user cleared every
 * model on an already-configured provider and wants the channel removed.
 * `undefined` (from the caller) means the picker was cancelled.
 */
export type ConnectModelSelection =
  | { kind: 'select'; models: CatalogModel[]; defaultModelId: string; thinking: boolean }
  | { kind: 'remove' };

export async function promptModelSelectionForCatalog(
  host: SlashCommandHost,
  providerId: string,
  models: CatalogModel[],
  config: KimiConfig,
): Promise<ConnectModelSelection | undefined> {
  // Clearing every model only removes a provider that is already configured;
  // for a fresh provider an empty selection is a no-op (Esc cancels instead).
  const removable = config.providers[providerId] !== undefined;
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${providerId}/${m.id}`] = catalogModelToAlias(providerId, m);
  }
  const initialSelection = catalogModelSelectionInitialState(providerId, models, config);
  const selection = await runCatalogModelMultiSelect(host, modelDict, initialSelection, removable);
  if (selection === undefined) return undefined;

  const byAlias = new Map(models.map((m) => [`${providerId}/${m.id}`, m]));
  const selectedModels = selection.aliases
    .map((alias) => byAlias.get(alias))
    .filter((m): m is CatalogModel => m !== undefined);
  const defaultModel =
    selection.defaultAlias !== undefined ? byAlias.get(selection.defaultAlias) : undefined;
  if (selectedModels.length === 0 || defaultModel === undefined) {
    // The picker only emits an empty selection when `removable`, so this is the
    // remove path; for a non-removable provider it is unreachable, but treat a
    // degenerate selection as a cancel rather than writing nothing.
    return removable ? { kind: 'remove' } : undefined;
  }

  return {
    kind: 'select',
    models: selectedModels,
    defaultModelId: defaultModel.id,
    thinking: selection.thinking,
  };
}

function runCatalogModelMultiSelect(
  host: SlashCommandHost,
  modelDict: Record<string, ModelAlias>,
  initialSelection: CatalogModelSelectionInitialState,
  removable: boolean,
): Promise<ModelMultiSelection | undefined> {
  return new Promise((resolve) => {
    const selector = new CatalogModelMultiSelectComponent({
      models: modelDict,
      currentThinking: initialSelection.thinking ?? true,
      selectedAliases: initialSelection.selectedAliases,
      defaultAlias: initialSelection.defaultAlias,
      removable,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: (selection) => {
        host.restoreEditor();
        resolve(selection);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector);
  });
}

export function runModelSelector(
  host: SlashCommandHost,
  modelDict: Record<string, ModelAlias>,
): Promise<{ alias: string; thinking: boolean } | undefined> {
  return new Promise((resolve) => {
    const firstAlias = Object.keys(modelDict)[0] ?? '';
    const caps = modelDict[firstAlias]?.capabilities ?? [];
    const initialThinking = caps.includes('always_thinking') || caps.includes('thinking');
    const selector = new ModelSelectorComponent({
      models: modelDict,
      currentValue: firstAlias,
      currentThinking: initialThinking,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        resolve({ alias, thinking });
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector);
  });
}
