import { t } from '#/i18n';
import { getLlmNotSetMessage, getNoActiveSessionMessage } from '../constant/kimi-tui';
import type { SlashCommandHost } from './dispatch';

/**
 * `/workflow` slash command — CLI entry point for the Workflow tool.
 *
 * Usage:
 *   /workflow                    → show usage
 *   /workflow list               → ask model to list built-in workflows
 *   /workflow <name> [args...]   → ask model to run a workflow
 *   /workflow status <runId>     → ask model to check workflow status
 *   /workflow cancel <runId>    → ask model to cancel a workflow run
 */
export async function handleWorkflowCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }
const trimmed = args.trim();

  // No args → show usage.
  if (trimmed.length === 0) {
    host.showNotice(
      t('tui.slashCommands.workflow'),
      [
        t('tui.slashCommands.workflowHelp.usage'),
        t('tui.slashCommands.workflowHelp.list'),
        t('tui.slashCommands.workflowHelp.run'),
        t('tui.slashCommands.workflowHelp.status'),
        t('tui.slashCommands.workflowHelp.cancel'),
        '',
        t('tui.slashCommands.workflowHelp.example'),
        t('tui.messages.workflowSearchExample'),
      ].join('\n'),
    );
    return;
  }

  // Subcommands that don't need a model.
  const lower = trimmed.toLowerCase();

  if (lower === 'list') {
    if (host.state.appState.model.trim().length === 0) {
      host.showError(getLlmNotSetMessage());
      return;
    }
    host.sendNormalUserInput(t('tui.messages.workflowListHint'));
    return;
  }

  if (lower.startsWith('status ')) {
    const runId = trimmed.slice(7).trim();
    if (runId.length === 0) {
      host.showError(t('tui.slashCommands.workflowStatusUsage'));
      return;
    }
    if (host.state.appState.model.trim().length === 0) {
      host.showError(getLlmNotSetMessage());
      return;
    }
    host.sendNormalUserInput(t('tui.messages.workflowStatusHintPattern', { runId }));
    return;
  }

  if (lower.startsWith('cancel ')) {
    const runId = trimmed.slice(7).trim();
    if (runId.length === 0) {
      host.showError(t('tui.slashCommands.workflowCancelUsage'));
      return;
    }
    if (host.state.appState.model.trim().length === 0) {
      host.showError(getLlmNotSetMessage());
      return;
    }
    host.sendNormalUserInput(t('tui.messages.workflowCancelHintPattern', { runId }));
    return;
  }

  // Otherwise: treat as workflow name + args.
  if (host.state.appState.model.trim().length === 0) {
    host.showError(getLlmNotSetMessage());
    return;
  }

  const spaceIdx = trimmed.indexOf(' ');
  const workflowName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const workflowArgs = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  const prompt = workflowArgs.length > 0
    ? t('tui.messages.workflowRunHintPattern', { name: workflowName }) + ` ${workflowArgs}`
    : t('tui.messages.workflowRunHintPattern', { name: workflowName });

  host.sendNormalUserInput(prompt);
}
