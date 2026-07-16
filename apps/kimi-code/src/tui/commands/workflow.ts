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
        'Usage:',
        '  /workflow list              — list available workflows',
        '  /workflow <name> [args...]  — run a workflow by name',
        '  /workflow status <runId>    — check status of a workflow run',
        '  /workflow cancel <runId>    — cancel a running workflow',
        '',
        'Example:',
        '  /workflow deep-research "latest advances in RAG"',
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
    host.sendNormalUserInput('Use the Workflow tool to list all available built-in workflows. Show their names, descriptions, and when to use them.');
    return;
  }

  if (lower.startsWith('status ')) {
    const runId = trimmed.slice(7).trim();
    if (runId.length === 0) {
      host.showError('Usage: /workflow status <runId>');
      return;
    }
    if (host.state.appState.model.trim().length === 0) {
      host.showError(getLlmNotSetMessage());
      return;
    }
    host.sendNormalUserInput(`Use the Workflow tool to check the status of workflow run "${runId}".`);
    return;
  }

  if (lower.startsWith('cancel ')) {
    const runId = trimmed.slice(7).trim();
    if (runId.length === 0) {
      host.showError('Usage: /workflow cancel <runId>');
      return;
    }
    if (host.state.appState.model.trim().length === 0) {
      host.showError(getLlmNotSetMessage());
      return;
    }
    host.sendNormalUserInput(`Use the Workflow tool to cancel workflow run "${runId}".`);
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
    ? `Use the Workflow tool to run the "${workflowName}" workflow with these args: ${workflowArgs}`
    : `Use the Workflow tool to run the "${workflowName}" workflow.`;

  host.sendNormalUserInput(prompt);
}
