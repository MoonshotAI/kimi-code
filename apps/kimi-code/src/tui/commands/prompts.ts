import {
  catalogModelToAlias,
  resolveCatalogImport,
  type Catalog,
  type CatalogModel,
  type ModelAlias,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { capabilitiesForModel } from '@moonshot-ai/kimi-code-oauth';
import type {
  ManagedKimiCodeModelInfo,
  OpenPlatformDefinition,
} from '@moonshot-ai/kimi-code-oauth';

import { ApiKeyInputDialogComponent, type ApiKeyInputResult } from '../components/dialogs/api-key-input-dialog';
import {
  ChoicePickerComponent,
  PreviewChoicePickerComponent,
  type ChoiceOption,
} from '../components/dialogs/choice-picker';
import { FeedbackInputDialogComponent, type FeedbackInputDialogResult } from '../components/dialogs/feedback-input-dialog';
import { ModelSelectorComponent } from '../components/dialogs/model-selector';
import { PlatformSelectorComponent } from '../components/dialogs/platform-selector';
import { DOCK_PREVIEW_ROWS } from '../constant/rendering';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import type { SlashCommandHost } from './dispatch';

export function promptPlatformSelection(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    const selector = new PlatformSelectorComponent({
      onSelect: (platformId) => {
        host.restoreEditor();
        resolve(platformId);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector, undefined, () => {
      resolve(undefined);
    });
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

export interface FeedbackPromptResult {
  readonly value: string;
}

export function promptFeedbackInput(host: SlashCommandHost): Promise<FeedbackPromptResult | undefined> {
  return new Promise((resolve) => {
    const dialog = new FeedbackInputDialogComponent((result: FeedbackInputDialogResult) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? { value: result.value } : undefined);
    });
    host.mountEditorReplacement(dialog);
  });
}

export type FeedbackAttachmentLevel = 'logs' | 'logs+codebase';

const FEEDBACK_ATTACHMENT_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'logs',
    label: 'Current session logs',
    description: 'Upload the files listed below with your feedback',
  },
  {
    value: 'logs+codebase',
    label: 'Session logs + project code',
    description:
      'Also upload source files from this workspace to help reproduce the issue. Secrets, dependencies, and build outputs are excluded.',
    descriptionTone: 'warning',
  },
];

export interface FeedbackSessionPreview {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly files: readonly string[];
}

export function promptFeedbackAttachment(
  host: SlashCommandHost,
  excludeCodebase = false,
  session?: FeedbackSessionPreview,
): Promise<FeedbackAttachmentLevel | undefined> {
  const options = excludeCodebase
    ? FEEDBACK_ATTACHMENT_OPTIONS.filter((option) => option.value !== 'logs+codebase')
    : FEEDBACK_ATTACHMENT_OPTIONS;
  let scroll = 0;
  const maxScroll = session === undefined ? 0 : Math.max(0, session.files.length - 5);
  return new Promise((resolve) => {
    const picker = new PreviewChoicePickerComponent({
      title: 'Choose what to include with your feedback',
      notice:
        'Your note, session ID, request ID, model, CLI version, OS, and shell are always included. Choose whether to add diagnostics below.',
      options,
      layout:
        host.state.dockContainer === undefined ? undefined : { maxBodyRows: DOCK_PREVIEW_ROWS },
      previewLabel: session === undefined ? ' Session files' : ` Current session · ${session.sessionId}`,
      onPreviewScroll:
        session === undefined
          ? undefined
          : (direction) => {
              scroll = Math.max(0, Math.min(maxScroll, scroll + direction * 5));
            },
      preview: {
        render: () => {
          if (session === undefined) {
            return ['  Session file list unavailable. session.zip is still uploaded on submit.'];
          }
          if (session.files.length === 0) {
            return [
              '  No session files yet.',
              '',
              '  session.zip also includes the application log, which may mention other sessions.',
            ];
          }
          const shown = session.files.slice(scroll, scroll + 5);
          const last = scroll + shown.length;
          return [
            `  ${String(session.files.length)} session files · showing ${String(scroll + 1)}–${String(last)}`,
            ...shown.map((entry) => {
              const absolute = join(session.sessionDir, entry);
              return `  ${toTerminalHyperlink(absolute, pathToFileURL(absolute).href)}`;
            }),
            ...(last < session.files.length
              ? [`  ${String(session.files.length - last)} more files · → next page`]
              : []),
            ...(scroll > 0 ? ['  ← previous page'] : []),
            '',
            '  session.zip also includes the application log, which may mention other sessions.',
          ];
        },
        invalidate: () => {},
        dispose: () => {},
      },
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value as FeedbackAttachmentLevel);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptApiKey(
  host: SlashCommandHost,
  platformName: string,
  subtitleLines: readonly string[] = ['Your key will be saved to ~/.kimi-code/config.toml'],
): Promise<string | undefined> {
  const releaseAuthBlock = host.beginAuthBlock();
  return new Promise<string | undefined>((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      subtitleLines,
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
    );
    host.mountEditorReplacement(dialog, undefined, () => {
      resolve(undefined);
    });
  }).finally(releaseAuthBlock);
}

export function promptSshPassword(host: SlashCommandHost, environmentId: string): Promise<string | undefined> {
  const releaseAuthBlock = host.beginAuthBlock();
  return new Promise<string | undefined>((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      environmentId,
      ['The password is used only in this process and is never saved.'],
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title: `Enter SSH password for ${environmentId}`,
        emptyHint: 'SSH password cannot be empty.',
        trimValue: false,
      },
    );
    host.mountEditorReplacement(dialog, undefined, () => {
      resolve(undefined);
    });
  }).finally(releaseAuthBlock);
}

/**
 * Asks for the provider endpoint the catalog did not declare (or declared
 * only as an env placeholder) — required for catalog imports whose protocol
 * was guessed, where the built-in default endpoint would point at the wrong
 * host. Esc cancels the import.
 */
export function promptBaseUrl(host: SlashCommandHost, platformName: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      ['The catalog declares no endpoint for this provider — enter its base URL.'],
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title: `Enter base URL for ${platformName}`,
        mask: false,
        emptyHint: 'Base URL cannot be empty.',
      },
    );
    host.mountEditorReplacement(dialog);
  });
}

export function promptCatalogProviderSelection(host: SlashCommandHost, catalog: Catalog): Promise<string | undefined> {
  return new Promise((resolve) => {
    const options: ChoiceOption[] = Object.entries(catalog)
      .filter(([, entry]) => resolveCatalogImport(entry).kind !== 'invalid')
      .map(([id, entry]) => ({
        value: id,
        label: entry.name ?? id,
        description:
          typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : undefined,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    if (options.length === 0) {
      host.showError('Catalog has no providers with supported wire types.');
      resolve(undefined);
      return;
    }

    const picker = new ChoicePickerComponent({
      title: 'Select a provider',
      options,
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
): Promise<{ model: ManagedKimiCodeModelInfo; thinking: ThinkingEffort } | undefined> {
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

export async function promptModelSelectionForCatalog(
  host: SlashCommandHost,
  providerId: string,
  models: CatalogModel[],
): Promise<{ model: CatalogModel; thinking: ThinkingEffort } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${providerId}/${m.id}`] = catalogModelToAlias(providerId, m);
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${providerId}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

export function runModelSelector(
  host: SlashCommandHost,
  modelDict: Record<string, ModelAlias>,
): Promise<{ alias: string; thinking: ThinkingEffort } | undefined> {
  return new Promise((resolve) => {
    const firstAlias = Object.keys(modelDict)[0] ?? '';
    const caps = modelDict[firstAlias]?.capabilities ?? [];
    const initialThinking = caps.includes('always_thinking') || caps.includes('thinking');
    const selector = new ModelSelectorComponent({
      models: modelDict,
      currentValue: firstAlias,
      currentThinkingEffort: initialThinking ? 'on' : 'off',
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
