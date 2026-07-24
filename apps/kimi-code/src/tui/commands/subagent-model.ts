import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';

const INHERIT_VALUE = '__inherit__';

/**
 * `/subagent-model` — manage per-workspace model bindings for subagent types
 * (stored in `.kimi-code/local.toml`, applied mechanically at spawn when the
 * subagent-model-selection experiment is enabled).
 *
 *   /subagent-model [list]     show current bindings
 *   /subagent-model set <type> pick a model (and effort) for a subagent type
 *   /subagent-model clear <type> remove a binding
 */
export async function handleSubagentModelCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const [actionRaw, typeRaw] = args.trim().split(/\s+/, 2);
  const action = (actionRaw ?? '').toLowerCase() || 'list';
  const agentType = (typeRaw ?? '').trim();

  if (action === 'list') {
    const bindings = await session.getSubagentBindings();
    const entries = Object.entries(bindings);
    if (entries.length === 0) {
      host.showStatus(
        'No subagent model bindings in this workspace.\n' +
          'Use /subagent-model set <type> to bind a model, or spawn a subagent to be asked once.',
      );
      return;
    }
    host.showStatus(
      [
        'Subagent model bindings (workspace):',
        ...entries.map(
          ([type, binding]) =>
            `  ${type}: ${formatBinding(binding)}`,
        ),
      ].join('\n'),
    );
    return;
  }

  if (action === 'clear') {
    if (agentType.length === 0) {
      host.showError('Usage: /subagent-model clear <type>');
      return;
    }
    try {
      const result = await session.setSubagentBinding(agentType, undefined);
      host.showStatus(`Cleared model binding for "${agentType}".\nSaved to:\n  ${result.configPath}`, 'success');
    } catch (error) {
      host.showError(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (action === 'set') {
    if (agentType.length === 0) {
      host.showError('Usage: /subagent-model set <type>');
      return;
    }
    const aliases = Object.keys(host.state.appState.availableModels).toSorted();
    if (aliases.length === 0) {
      host.showError('No models configured. Run /login or /provider first.');
      return;
    }
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: `Bind model for subagent "${agentType}"`,
        hint: '↑↓ navigate · Enter confirm · Esc cancel',
        options: [
          {
            value: INHERIT_VALUE,
            label: 'Keep inheriting from the main agent',
          },
          ...aliases.map((alias) => ({ value: alias, label: alias })),
        ],
        onSelect: (value) => {
          if (value === INHERIT_VALUE) {
            host.restoreEditor();
            void persistBinding(host, agentType, { inherit: true });
            return;
          }
          void pickThinkingEffort(host, agentType, value);
        },
        onCancel: () => {
          host.restoreEditor();
        },
      }),
    );
    return;
  }

  host.showError('Usage: /subagent-model [list] | set <type> | clear <type>');
}

function formatBinding(binding: {
  model?: string;
  thinkingEffort?: string;
  inherit?: boolean;
}): string {
  if (binding.inherit === true) return 'inherit from main agent';
  const parts = [binding.model ?? 'inherit model'];
  if (binding.thinkingEffort !== undefined) parts.push(`thinking ${binding.thinkingEffort}`);
  return parts.join(', ');
}

async function pickThinkingEffort(
  host: SlashCommandHost,
  agentType: string,
  model: string,
): Promise<void> {
  const supportEfforts =
    host.state.appState.availableModels[model]?.supportEfforts?.filter(
      (effort) => effort.length > 0,
    ) ?? [];
  if (supportEfforts.length === 0) {
    host.restoreEditor();
    await persistBinding(host, agentType, { model });
    return;
  }
  host.restoreEditor();
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Thinking effort for subagent "${agentType}" on ${model}`,
      hint: '↑↓ navigate · Enter confirm · Esc skip (inherit effort)',
      options: [
        { value: INHERIT_VALUE, label: 'Inherit the main agent thinking effort' },
        ...supportEfforts.map((effort) => ({ value: effort, label: effort })),
      ],
      onSelect: (value) => {
        host.restoreEditor();
        void persistBinding(
          host,
          agentType,
          value === INHERIT_VALUE ? { model } : { model, thinkingEffort: value },
        );
      },
      onCancel: () => {
        host.restoreEditor();
        void persistBinding(host, agentType, { model });
      },
    }),
  );
}

async function persistBinding(
  host: SlashCommandHost,
  agentType: string,
  binding: { model?: string; thinkingEffort?: string; inherit?: boolean },
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  try {
    const result = await session.setSubagentBinding(agentType, binding);
    host.showStatus(
      `Subagent "${agentType}" binding: ${formatBinding(binding)}\nSaved to:\n  ${result.configPath}`,
      'success',
    );
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
  }
}
