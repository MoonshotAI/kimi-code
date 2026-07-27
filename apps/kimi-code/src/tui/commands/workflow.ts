import { TextViewerComponent } from '../components/dialogs/text-viewer';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { showWorkflowsBrowser, workflowsBrowserOpen } from '../controllers/workflows-browser';
import { formatErrorMessage } from '../utils/event-payload';
import { WorkflowV2Client } from '../workflow-v2-client';
import type { SlashCommandHost } from './dispatch';

const USAGE =
  'Usage: /workflow [list] | run <name> [args…] | runs | show <name> | cancel <runId> | save <runId> [--user] | reload | on | off';

export async function handleWorkflowCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const client = new WorkflowV2Client(host.requireSession());
  const trimmed = args.trim();
  // No args → open the runs browser (like /tasks), so the user sees active runs immediately.
  if (trimmed === '') {
    if (workflowsBrowserOpen()) return;
    await showWorkflowsBrowser(host, client);
    return;
  }
  if (trimmed === 'list') {
    await listWorkflows(host, client);
    return;
  }

  const [subcommand, ...rest] = trimmed.split(/\s+/);
  const subArgs = rest.join(' ');
  switch (subcommand) {
    case 'run':
      await runWorkflow(host, client, subArgs, `/workflow ${trimmed}`);
      return;
    case 'runs':
      if (workflowsBrowserOpen()) return;
      await showWorkflowsBrowser(host, client);
      return;
    case 'show':
      await showWorkflowScript(host, client, subArgs);
      return;
    case 'cancel':
      await cancelWorkflowRun(host, client, subArgs);
      return;
    case 'save':
      await saveWorkflowRun(host, client, subArgs);
      return;
    case 'reload':
      await reloadWorkflows(host, client);
      return;
    case 'on':
    case 'off':
      await toggleWorkflowMode(host, client, subcommand === 'on');
      return;
    default:
      // `/workflow <name> [args…]` is shorthand for `/workflow run <name> [args…]`.
      if (subcommand !== undefined && !subcommand.startsWith('-')) {
        await runWorkflow(host, client, trimmed, `/workflow ${trimmed}`);
        return;
      }
      host.showError(USAGE);
  }
}

async function listWorkflows(host: SlashCommandHost, client: WorkflowV2Client): Promise<void> {
  try {
    const { workflows, skipped } = await client.listWorkflows();
    const lines = workflows.map(
      (workflow) =>
        `• ${workflow.name} (${workflow.source}, ${String(workflow.phases.length)} phases) — ${workflow.description}`,
    );
    if (skipped.length > 0) {
      lines.push('', 'Skipped (invalid):');
      for (const entry of skipped) lines.push(`• ${entry.path}: ${entry.reason}`);
    }
    host.showNotice(
      `Workflows (${String(workflows.length)})`,
      lines.length > 0 ? lines.join('\n') : 'No workflows discovered.',
    );
  } catch (error) {
    showWorkflowError(host, error);
  }
}

async function runWorkflow(
  host: SlashCommandHost,
  client: WorkflowV2Client,
  input: string,
  commandText: string,
): Promise<void> {
  const name = input.split(/\s+/)[0];
  if (name === undefined || name === '') {
    host.showError(USAGE);
    return;
  }
  const runArgs = input.slice(name.length).trim();
  await startRun(host, client, name, runArgs);
}

async function startRun(
  host: SlashCommandHost,
  client: WorkflowV2Client,
  name: string,
  runArgs: string,
): Promise<void> {
  try {
    const started = await client.runWorkflow({ name, args: runArgs });
    host.showStatus(
      `Workflow "${started.workflowName}" started (run ${started.runId}). Track with /workflow runs or /tasks.`,
    );
  } catch (error) {
    showWorkflowError(host, error);
  }
}

async function showWorkflowScript(
  host: SlashCommandHost,
  client: WorkflowV2Client,
  name: string,
): Promise<void> {
  if (name === '') {
    host.showError(USAGE);
    return;
  }
  try {
    const { workflow } = await client.getWorkflow(name);
    if (workflow === null) {
      host.showError(`Workflow "${name}" not found.`);
      return;
    }
    openScriptViewer(host, `Workflow script: ${workflow.name}`, workflow.script ?? '', () => {});
  } catch (error) {
    showWorkflowError(host, error);
  }
}

function openScriptViewer(
  host: SlashCommandHost,
  title: string,
  content: string,
  onClose: () => void,
): void {
  const { ui } = host.state;
  const savedChildren = [...ui.children];
  const viewer = new TextViewerComponent(
    {
      title,
      content,
      onClose: () => {
        ui.clear();
        for (const child of savedChildren) ui.addChild(child);
        ui.setFocus(host.state.editor);
        ui.requestRender(true);
        onClose();
      },
    },
    host.state.terminal,
  );
  ui.clear();
  ui.addChild(viewer);
  ui.setFocus(viewer);
  ui.requestRender(true);
}

async function cancelWorkflowRun(
  host: SlashCommandHost,
  client: WorkflowV2Client,
  prefix: string,
): Promise<void> {
  if (prefix === '') {
    host.showError(USAGE);
    return;
  }
  try {
    const runId = await resolveRunId(host, client, prefix);
    if (runId === undefined) return;
    const { cancelled } = await client.cancelWorkflowRun(runId);
    host.showStatus(
      cancelled ? `Workflow run ${runId} cancelled.` : `Workflow run ${runId} is not running — nothing to cancel.`,
    );
  } catch (error) {
    showWorkflowError(host, error);
  }
}

async function saveWorkflowRun(
  host: SlashCommandHost,
  client: WorkflowV2Client,
  input: string,
): Promise<void> {
  const useUserScope = input.split(/\s+/).includes('--user');
  const prefix = input.replace(/--user\b/g, '').trim();
  if (prefix === '') {
    host.showError(USAGE);
    return;
  }
  try {
    const runId = await resolveRunId(host, client, prefix);
    if (runId === undefined) return;
    const { run } = await client.getWorkflowRun(runId);
    if (run === null) {
      host.showError(`Workflow run ${runId} not found.`);
      return;
    }
    const saved = await client.saveWorkflow({
      script: run.script,
      scope: useUserScope ? 'user' : 'project',
    });
    host.showStatus(`Workflow "${saved.name}" saved to ${useUserScope ? 'user' : 'project'} scope: ${saved.path}`);
  } catch (error) {
    showWorkflowError(host, error);
  }
}

async function reloadWorkflows(host: SlashCommandHost, client: WorkflowV2Client): Promise<void> {
  try {
    const { workflows, skipped } = await client.reloadWorkflows();
    const skippedNote =
      skipped.length > 0 ? ` (${String(skipped.length)} invalid skipped)` : '';
    host.showStatus(`Reloaded workflows: ${String(workflows.length)} discovered${skippedNote}.`);
  } catch (error) {
    showWorkflowError(host, error);
  }
}

async function resolveRunId(
  host: SlashCommandHost,
  client: WorkflowV2Client,
  prefix: string,
): Promise<string | undefined> {
  const { runs } = await client.listWorkflowRuns();
  const exact = runs.find((run) => run.runId === prefix);
  if (exact !== undefined) return exact.runId;
  const matches = runs.filter((run) => run.runId.startsWith(prefix));
  if (matches.length === 1) return matches[0]!.runId;
  if (matches.length === 0) {
    host.showError(`No workflow run matches "${prefix}". Run /workflow runs to see active runs.`);
  } else {
    host.showError(`"${prefix}" matches ${String(matches.length)} workflow runs — be more specific.`);
  }
  return undefined;
}

function showWorkflowError(host: SlashCommandHost, error: unknown): void {
  const message = formatErrorMessage(error);
  if (message.includes('request.invalid') || message.includes('dynamic-workflows')) {
    host.showError(
      `Dynamic workflows are experimental — enable them with KIMI_CODE_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1 or /experiments. (${message})`,
    );
    return;
  }
  host.showError(message);
}

async function toggleWorkflowMode(
  host: SlashCommandHost,
  client: WorkflowV2Client,
  enabled: boolean,
): Promise<void> {
  try {
    await client.setWorkflowMode(enabled, 'command');
    host.setAppState({ workflowMode: enabled });
    host.showStatus(enabled ? 'Dynamic Workflow mode enabled.' : 'Dynamic Workflow mode disabled.');
  } catch (error) {
    showWorkflowError(host, error);
  }
}
