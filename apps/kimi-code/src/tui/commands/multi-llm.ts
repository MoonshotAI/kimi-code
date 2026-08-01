/**
 * /multi-llm command — configure MultiLLM concurrent providers.
 *
 * MultiLLM (Rust engine only) sends the same prompt to several providers
 * concurrently and returns the first successful response ("first past the
 * post"). This command lets the user pick which configured providers race,
 * and toggles `agent.engine = "rust"` on when the first provider is added.
 *
 * Because the TUI has no multi-select component, we reuse the single-select
 * ChoicePicker: each pick toggles a provider in/out of the multiLlm list and
 * reopens the picker with the updated marks. The current set is marked with
 * a ✓ in the label.
 */
// Phase 6.2.5 — the AGENTS.md module forbids direct `@moonshot-ai/agent-core`
// imports in app code. `KimiConfigPatch` is the v1 config patch shape;
// routed through the SDK compatibility layer so this app stays on the
// official public surface.
import type { KimiConfigPatch } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * Toggle a provider in/out of the multiLlm list and persist the config.
 * Reopens the picker afterwards so the user can toggle more providers.
 */
export async function handleMultiLlmCommand(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const providers = config.providers ?? {};
  const providerIds = Object.keys(providers);

  if (providerIds.length === 0) {
    host.showError(t('tui.multiLlm.noProviders'));
    return;
  }

  reopenPicker(host, providerIds, config.agent?.multiLlm ?? []);
}

/**
 * Reopen the MultiLLM picker with the current selection state.
 */
function reopenPicker(
  host: SlashCommandHost,
  providerIds: readonly string[],
  selected: readonly string[],
): void {
  const selectedSet = new Set(selected);
  const options: ChoiceOption[] = providerIds.map((id) => {
    const isOn = selectedSet.has(id);
    return {
      value: id,
      label: `${isOn ? '✓ ' : '  '}${id}`,
      description: isOn
        ? t('tui.multiLlm.providerOn')
        : t('tui.multiLlm.providerOff'),
    };
  });

  // A summary line so the user knows the engine state — always the Rust
  // engine since the v1/v2 migration (the JS engine was removed).
  const notice =
    selected.length === 0
      ? t('tui.multiLlm.noticeOff')
      : t('tui.multiLlm.noticeOn', {
          count: selected.length,
          engine: 'rust',
        });

  const picker = new ChoicePickerComponent({
    title: t('tui.multiLlm.title'),
    notice,
    noticeTone: selected.length === 0 ? 'warning' : 'success',
    options,
    onSelect: (value) => {
      host.restoreEditor();
      void toggleProvider(host, providerIds, selected, value).catch((error: unknown) => {
        host.showError(
          t('tui.multiLlm.toggleFailed', { error: formatErrorMessage(error) }),
        );
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(picker);
}

/**
 * Toggle a single provider in/out of the multiLlm list and persist.
 * When enabling the first provider, also set `agent.engine = "rust"`.
 * When removing the last provider, leave engine as-is (user may still
 * want the Rust engine for other reasons).
 */
async function toggleProvider(
  host: SlashCommandHost,
  providerIds: readonly string[],
  current: readonly string[],
  providerId: string,
): Promise<void> {
  const next = new Set(current);
  if (next.has(providerId)) {
    next.delete(providerId);
  } else {
    next.add(providerId);
  }
  const nextList = [...next];

  const patch: KimiConfigPatch = {
    agent: {
      multiLlm: nextList,
      // Enable the Rust engine when the first provider is added; MultiLLM
      // is a no-op under the JS engine.
      engine: nextList.length > 0 ? 'rust' : undefined,
    },
  };

  await host.harness.setConfig(patch);
  host.track('multi_llm_toggle', { provider: providerId, count: nextList.length });
  host.showStatus(
    nextList.length === 0
      ? t('tui.multiLlm.disabled')
      : t('tui.multiLlm.statusWithProviders', { providers: nextList.join(', ') }),
  );

  reopenPicker(host, providerIds, nextList);
}
