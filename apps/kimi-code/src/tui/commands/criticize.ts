import { isKimiError } from '@moonshot-ai/kimi-code-sdk';
import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';
import { CriticSelectorComponent } from '../components/dialogs/criticize-selector';

export async function handleCriticizeCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  const models = host.state.appState.availableModels;
  const lastCriticModel = host.state.appState.criticConfig?.modelAlias;

  // Always show the model picker so the user can switch models (e.g., when
  // the previously chosen model hits a rate limit or is no longer suitable).
  host.mountEditorReplacement(
    new CriticSelectorComponent({
      models,
      currentValue: lastCriticModel,
      onSelect: async (selection) => {
        host.restoreEditor();
        await runCritique(host, selection.modelAlias);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function runCritique(host: SlashCommandHost, modelAlias: string): Promise<void> {
  const session = host.session;
  if (session === undefined) return;

  // Save the critic model choice
  host.setAppState({ criticConfig: { modelAlias } });

  // Gather context: recent transcript, plan file if in plan mode
  const planMode = host.state.appState.planMode;
  let context = '';

  const transcript = host.state.transcriptEntries;
  const recentEntries = transcript.slice(-30);
  if (recentEntries.length > 0) {
    context += '## Recent conversation\n\n';
    for (const entry of recentEntries) {
      if (entry.content.trim().length === 0) continue;
      context += `[${entry.kind}] ${entry.content}\n\n`;
    }
  }

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

    // Show the critique to the user in the transcript so they can read it
    host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      turnId: undefined,
      renderMode: 'markdown',
      content: `## Critique from /criticize\n\n${critique}`,
    });

    // Append the critique as a system reminder so the main agent sees it
    await session.appendSystemReminder(
      `## Critique from /criticize\n\nThe following critique was produced by a dedicated critic agent using model "${modelAlias}". Review each point carefully. You may accept, rebut, or defend your approach.\n\n${critique}`,
      { kind: 'system_trigger', name: 'criticize' },
    );

    host.showStatus('Critique received. The agent will see it on the next turn.', 'success');
  } catch (error) {
    if (isKimiError(error) && error.code === 'provider.rate_limit') {
      host.showError(
        `Critique failed: the selected model hit a rate limit. Run /criticize again and choose a different model.`,
      );
      return;
    }
    host.showError(`Critique failed: ${formatErrorMessage(error)}`);
  }
}
