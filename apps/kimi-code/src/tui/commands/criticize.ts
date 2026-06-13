import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';
import { CriticSelectorComponent } from '../components/dialogs/criticize-selector';

export async function handleCriticizeCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  const models = host.state.appState.availableModels;
  const criticConfig = host.state.appState.criticConfig;

  // If no critic model is configured yet, show the model picker
  if (criticConfig === undefined || criticConfig.modelAlias.length === 0) {
    host.mountEditorReplacement(
      new CriticSelectorComponent({
        models,
        onSelect: async (selection) => {
          host.restoreEditor();
          await runCritique(host, selection.modelAlias);
        },
        onCancel: () => {
          host.restoreEditor();
        },
      }),
    );
    return;
  }

  await runCritique(host, criticConfig.modelAlias);
}

async function runCritique(host: SlashCommandHost, modelAlias: string): Promise<void> {
  const session = host.session;
  if (session === undefined) return;

  // Save the critic model choice
  host.setAppState({ criticConfig: { modelAlias } });

  // Gather context: last transcript entries, plan file if in plan mode
  const planMode = host.state.appState.planMode;
  let context = '';

  if (planMode) {
    try {
      const planData = await session.getPlan();
      if (planData?.content) {
        context += `## Current Plan\n\n${planData.content}\n\n`;
      }
    } catch {
      // ignore plan read errors
    }
  }

  // Show a progress indicator
  host.showStatus('Running critique...', 'primary');
  host.track('input_command', { command: 'criticize', model: modelAlias });

  try {
    const critique = await session.runCritique(context, modelAlias);

    // Append the critique as a system reminder so the main agent sees it
    await session.appendSystemReminder(
      `## Critique from /criticize\n\nThe following critique was produced by a dedicated critic agent using model "${modelAlias}". Review each point carefully. You may accept, rebut, or defend your approach.\n\n${critique}`,
      { kind: 'critique', name: 'criticize' },
    );

    host.showStatus('Critique received. The agent will see it on the next turn.', 'success');
  } catch (error) {
    host.showError(`Critique failed: ${formatErrorMessage(error)}`);
  }
}
