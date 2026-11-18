import type {
  ModelAlias,
  RefreshProviderModelsResponse,
  ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  defaultThinkingEffortFor,
  modelDisplayName,
  segmentsFor,
  thinkingAvailability,
} from '../components/dialogs/model-selector';
import type { SlashCommandHost } from '../commands/dispatch';
import {
  effectiveModelForHost,
  hasConversationHistory,
  lazyModelSelection,
  MODEL_SWITCH_CACHE_WARNING,
  performModelSwitch,
} from '../utils/model-switch';
import { sanitizeShellOutput } from '../utils/shell-output';
import {
  acknowledgeModelMigration,
  readModelMigrationAcknowledgements,
} from '#/utils/model-migration-state';

interface ModelMigration {
  readonly fromAlias: string;
  readonly fromModel: string;
  readonly toAlias: string;
  readonly toModel: string;
  readonly displayName: string;
  readonly effort: ThinkingEffort;
  readonly effortHint?: string;
  readonly migrationMarkdown: string;
  readonly retirementAt?: string | null;
}

type RetiredDefault = NonNullable<RefreshProviderModelsResponse['retired_default']>;

function migrationEffort(host: SlashCommandHost, from: ModelAlias, to: ModelAlias): ThinkingEffort {
  const targetModel = effectiveModelForHost(host, to);
  const liveEffort = host.state.appState.thinkingEffort;
  return thinkingAvailability(effectiveModelForHost(host, from)) !== 'unsupported' &&
    segmentsFor(targetModel).includes(liveEffort)
    ? liveEffort
    : defaultThinkingEffortFor(targetModel);
}

function findModelMigration(
  host: SlashCommandHost,
  acknowledged: Readonly<Record<string, string>>,
): ModelMigration | undefined {
  const { model: fromAlias, availableModels } = host.state.appState;
  const from = availableModels[fromAlias];
  const upgrade = from?.upgrade;
  if (from === undefined || upgrade === undefined || upgrade.model === fromAlias) return;

  const target = Object.entries(availableModels).find(
    ([alias, candidate]) =>
      alias !== fromAlias && candidate.provider === from.provider && alias === upgrade.model,
  );
  if (target === undefined) return;
  const [toAlias, to] = target;
  if (acknowledged[fromAlias] === to.model) return;
  const targetModel = effectiveModelForHost(host, to);
  const effort = migrationEffort(host, from, to);
  const migrationMarkdown = upgrade.migrationMarkdown.trim();
  return {
    fromAlias,
    fromModel: from.model,
    toAlias,
    toModel: to.model,
    displayName: sanitizeShellOutput(modelDisplayName(toAlias, targetModel)),
    effort,
    effortHint:
      thinkingAvailability(targetModel) === 'unsupported' ? undefined : `thinking ${effort}`,
    migrationMarkdown: sanitizeShellOutput(
      migrationMarkdown.length > 0
        ? migrationMarkdown
        : `We recommend switching from ${from.model} to ${to.model}.`,
    ),
    retirementAt: upgrade.retirementAt,
  };
}

function canShowModelMigrationPrompt(host: SlashCommandHost): boolean {
  return (
    host.state.activeDialog === null &&
    !host.state.editorReplacementMounted &&
    !host.sessionReplacementInFlight &&
    !host.state.appState.isCompacting &&
    !host.state.appState.isReplaying &&
    host.state.appState.streamingPhase === 'idle' &&
    !host.state.externalEditorRunning &&
    host.state.queuedMessages.length === 0 &&
    !host.state.queuedMessageDispatchPending &&
    host.state.editor.getText().length === 0
  );
}

export class ModelMigrationController {
  private pending = false;
  private scheduled = false;
  private retired: RetiredDefault | undefined;
  private acknowledged: Promise<Readonly<Record<string, string>>> = Promise.resolve({});

  constructor(private readonly host: SlashCommandHost & { readonly aborted: boolean }) {}

  request(): void {
    this.pending = true;
    this.acknowledged = readModelMigrationAcknowledgements();
    this.retry();
  }

  async retire(retired: RetiredDefault): Promise<void> {
    this.retired = retired;
    this.request();
    const onRetiredSelection = () =>
      this.host.session === undefined && this.host.state.appState.model === retired.from;
    if (!onRetiredSelection()) return;
    const config = await this.host.harness.getConfig();
    if (!onRetiredSelection()) return;
    const { lazySessionThinking } = this.host.state.appState;
    const selection = lazyModelSelection(config, retired.to);
    this.host.setAppState(
      lazySessionThinking === undefined
        ? selection
        : { ...selection, thinkingEffort: lazySessionThinking },
    );
  }

  retry(): void {
    if (!this.pending || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      void Promise.all([this.host.waitForSessionAssembly(), this.acknowledged])
        .then(([, acknowledged]) => {
          setImmediate(() => {
            this.scheduled = false;
            if (this.host.aborted || this.host.state.appState.model.length === 0) return;
            const retired = this.retired;
            if (
              retired !== undefined &&
              this.host.state.activeDialog === null &&
              !this.host.state.editorReplacementMounted
            ) {
              this.retired = undefined;
              showRetiredDefaultNotice(this.host, retired);
            }
            if (!canShowModelMigrationPrompt(this.host)) return;
            this.pending = false;
            void maybeShowModelMigrationPrompt(this.host, acknowledged, () => {
              this.request();
            });
          });
        })
        .catch(() => {
          this.scheduled = false;
          this.host.showError('Failed to check model migration.');
        });
    });
  }
}

export async function maybeShowModelMigrationPrompt(
  host: SlashCommandHost,
  acknowledged: Readonly<Record<string, string>>,
  onDisplaced?: () => void,
): Promise<void> {
  const migration = findModelMigration(host, acknowledged);
  if (migration === undefined || !canShowModelMigrationPrompt(host)) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (switchModel: boolean) => {
      if (settled) return;
      settled = true;
      host.restoreEditor();
      void (async () => {
        if (switchModel) {
          if (host.state.appState.availableModels[migration.toAlias] === undefined) {
            resolve();
            return;
          }
          const switched = await performModelSwitch(
            host,
            migration.toAlias,
            migration.effort,
            'model-and-effort',
          );
          if (!switched) {
            resolve();
            return;
          }
        }
        await acknowledgeModelMigration(migration.fromAlias, migration.toModel);
        resolve();
      })().catch(() => {
        host.showError('Failed to save model migration preference.');
        resolve();
      });
    };

    const notice = migrationNotice(migration);
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'Model migration available',
        notice: {
          markdown: hasConversationHistory(host)
            ? `${notice}\n\n${MODEL_SWITCH_CACHE_WARNING}`
            : notice,
        },
        options: [
          {
            value: 'switch',
            label: `Switch to ${migration.displayName}`,
            description: migration.effortHint,
          },
          { value: 'keep', label: 'Keep current model' },
        ],
        currentValue: 'keep',
        initialValue: 'switch',
        spaceSelect: false,
        onSelect: (value) => finish(value === 'switch'),
        onCancel: () => {
          if (settled) return;
          settled = true;
          host.restoreEditor();
          resolve();
        },
      }),
      () => {
        if (settled) return;
        settled = true;
        onDisplaced?.();
        resolve();
      },
    );
  });
}

function showRetiredDefaultNotice(host: SlashCommandHost, retired: RetiredDefault): void {
  const fromName = sanitizeShellOutput(retired.from_display_name);
  const toName = sanitizeShellOutput(
    modelDisplayName(retired.to, host.state.appState.availableModels[retired.to]),
  );
  host.showStatus(
    `${fromName} is no longer offered by its provider; the default model is now ${toName}.`,
    'warning',
  );
}

function migrationNotice(migration: ModelMigration): string {
  const retirementAt = migration.retirementAt;
  if (retirementAt === undefined || retirementAt === null) return migration.migrationMarkdown;
  const timestamp = Date.parse(retirementAt);
  if (!Number.isFinite(timestamp)) return migration.migrationMarkdown;
  return `${migration.migrationMarkdown}\n\nRetirement date: ${new Date(timestamp).toLocaleDateString()}`;
}
