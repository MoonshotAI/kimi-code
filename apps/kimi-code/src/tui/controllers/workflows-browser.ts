/**
 * WorkflowsBrowserController — mounts the full-screen workflow-runs browser.
 * Self-contained (no TUIState field): one browser at a time per process,
 * opened by `/workflow runs` and closed with Esc. Polling refreshes the run
 * list once a second; the selected run's detail (logs, script) loads on
 * demand.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import type { WorkflowRunDetail, WorkflowRunSnapshot } from '@moonshot-ai/kimi-code-sdk';

import type { SlashCommandHost } from '../commands/dispatch';
import { TextViewerComponent } from '../components/dialogs/text-viewer';
import { WorkflowsBrowserApp } from '../components/dialogs/workflows-browser';
import { formatErrorMessage } from '../utils/event-payload';
import { WorkflowV2Client } from '../workflow-v2-client';

interface BrowserState {
  component: WorkflowsBrowserApp;
  savedChildren: readonly Component[];
  selectedRunId: string | undefined;
  detail: WorkflowRunDetail | undefined;
  detailLoading: boolean;
  detailRequestId: number;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  pollTimer: NodeJS.Timeout;
  viewer:
    | {
        component: TextViewerComponent;
        savedChildren: readonly Component[];
      }
    | undefined;
}

let active:
  | { host: SlashCommandHost; client: WorkflowV2Client; browser: BrowserState }
  | undefined;

export function workflowsBrowserOpen(): boolean {
  return active !== undefined;
}

export async function showWorkflowsBrowser(
  host: SlashCommandHost,
  client: WorkflowV2Client,
): Promise<void> {
  if (active !== undefined) return;

  let runs: readonly WorkflowRunSnapshot[];
  try {
    runs = (await client.listWorkflowRuns()).runs;
  } catch (error) {
    host.showError(`Failed to load workflow runs: ${formatErrorMessage(error)}`);
    return;
  }
  if (active !== undefined) return;

  const selectedRunId = runs.find((run) => run.status === 'running')?.runId ?? runs[0]?.runId;
  const component = new WorkflowsBrowserApp(
    {
      runs,
      selectedRunId,
      detail: undefined,
      detailLoading: false,
      flashMessage: undefined,
      onSelect: (runId) => handleSelect(runId),
      onCancel: () => closeWorkflowsBrowser(),
      onCancelRun: (runId) => void handleCancelRun(runId),
      onSaveRun: (runId, scope) => void handleSaveRun(runId, scope),
      onViewScript: (runId) => void handleViewScript(runId),
      onRefresh: () => void refresh(false),
    },
    host.state.terminal,
  );

  const { ui } = host.state;
  const savedChildren = [...ui.children];
  ui.clear();
  ui.addChild(component);
  ui.setFocus(component);
  ui.requestRender(true);

  const pollTimer = setInterval(() => {
    void refresh(true);
  }, 1000);

  active = {
    host,
    client,
    browser: {
      component,
      savedChildren,
      selectedRunId,
      detail: undefined,
      detailLoading: false,
      detailRequestId: 0,
      flashMessage: undefined,
      flashTimer: undefined,
      pollTimer,
      viewer: undefined,
    },
  };

  if (selectedRunId !== undefined) loadDetail(selectedRunId);
}

export function closeWorkflowsBrowser(): void {
  if (active === undefined) return;
  const { host, browser } = active;
  if (browser.viewer !== undefined) closeScriptViewer();
  clearInterval(browser.pollTimer);
  if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);

  const { ui } = host.state;
  ui.clear();
  for (const child of browser.savedChildren) ui.addChild(child);
  active = undefined;
  ui.setFocus(host.state.editor);
  ui.requestRender(true);
}

async function refresh(silent: boolean): Promise<void> {
  if (active === undefined) return;
  const { host, client, browser } = active;
  let runs: readonly WorkflowRunSnapshot[];
  try {
    runs = (await client.listWorkflowRuns()).runs;
  } catch (error) {
    if (!silent) flash(`Refresh failed: ${formatErrorMessage(error)}`);
    return;
  }
  if (active === undefined || active.browser !== browser) return;
  pushProps(runs);
  if (browser.selectedRunId !== undefined) {
    void refreshDetail(browser.selectedRunId);
  }
}

function pushProps(runs: readonly WorkflowRunSnapshot[]): void {
  if (active === undefined) return;
  const { host, browser } = active;
  browser.component.setProps({
    runs,
    selectedRunId: browser.selectedRunId,
    detail: browser.detail,
    detailLoading: browser.detailLoading,
    flashMessage: browser.flashMessage,
    onSelect: (runId) => handleSelect(runId),
    onCancel: () => closeWorkflowsBrowser(),
    onCancelRun: (runId) => void handleCancelRun(runId),
    onSaveRun: (runId, scope) => void handleSaveRun(runId, scope),
    onViewScript: (runId) => void handleViewScript(runId),
    onRefresh: () => void refresh(false),
  });
  host.state.ui.requestRender();
}

function handleSelect(runId: string): void {
  if (active === undefined) return;
  const { browser } = active;
  if (browser.selectedRunId === runId) return;
  browser.selectedRunId = runId;
  browser.detail = undefined;
  browser.detailLoading = true;
  loadDetail(runId);
}

function loadDetail(runId: string): void {
  if (active === undefined) return;
  const { client, browser } = active;
  const requestId = ++browser.detailRequestId;
  void client
    .getWorkflowRun(runId)
    .then(({ run }) => {
      if (active === undefined || active.browser !== browser) return;
      if (browser.detailRequestId !== requestId || browser.selectedRunId !== runId) return;
      browser.detail = run ?? undefined;
      browser.detailLoading = false;
      void refresh(true);
    })
    .catch(() => {
      if (active === undefined || active.browser !== browser) return;
      if (browser.detailRequestId !== requestId) return;
      browser.detail = undefined;
      browser.detailLoading = false;
      void refresh(true);
    });
}

async function refreshDetail(runId: string): Promise<void> {
  if (active === undefined) return;
  const { client, browser } = active;
  if (browser.detail === undefined) return;
  const requestId = ++browser.detailRequestId;
  try {
    const { run } = await client.getWorkflowRun(runId);
    if (active === undefined || active.browser !== browser) return;
    if (browser.detailRequestId !== requestId || browser.selectedRunId !== runId) return;
    if (run !== null) browser.detail = run;
  } catch {
    // Silent: the next poll retries.
  }
}

async function handleCancelRun(runId: string): Promise<void> {
  if (active === undefined) return;
  const { client } = active;
  try {
    const { cancelled } = await client.cancelWorkflowRun(runId);
    flash(cancelled ? `Cancelling ${runId}…` : `${runId} is not running — nothing to cancel.`);
    await refresh(true);
  } catch (error) {
    flash(`Cancel failed: ${formatErrorMessage(error)}`);
  }
}

async function handleSaveRun(runId: string, scope: 'project' | 'user'): Promise<void> {
  if (active === undefined) return;
  const { client } = active;
  try {
    const { run } = await client.getWorkflowRun(runId);
    if (run === null) {
      flash(`Run ${runId} not found.`);
      return;
    }
    const saved = await client.saveWorkflow({ script: run.script, scope });
    flash(`Saved "${saved.name}" to ${scope} scope: ${saved.path}`, 4000);
  } catch (error) {
    flash(`Save failed: ${formatErrorMessage(error)}`);
  }
}

async function handleViewScript(runId: string): Promise<void> {
  if (active === undefined) return;
  const { host, client, browser } = active;
  if (browser.viewer !== undefined) return;
  try {
    const { run } = await client.getWorkflowRun(runId);
    if (active === undefined || active.browser !== browser) return;
    if (run === null) {
      flash(`Run ${runId} not found.`);
      return;
    }
    const { ui } = host.state;
    const viewer = new TextViewerComponent(
      {
        title: `Workflow script: ${run.workflowName}`,
        content: run.script,
        onClose: () => closeScriptViewer(),
      },
      host.state.terminal,
    );
    const savedChildren = [...ui.children];
    ui.clear();
    ui.addChild(viewer);
    ui.setFocus(viewer);
    ui.requestRender(true);
    browser.viewer = { component: viewer, savedChildren };
  } catch (error) {
    flash(`Cannot open script: ${formatErrorMessage(error)}`);
  }
}

function closeScriptViewer(): void {
  if (active === undefined) return;
  const { host, browser } = active;
  if (browser.viewer === undefined) return;
  const { savedChildren } = browser.viewer;
  browser.viewer = undefined;
  const { ui } = host.state;
  ui.clear();
  for (const child of savedChildren) ui.addChild(child);
  ui.setFocus(browser.component);
  ui.requestRender(true);
}

function flash(message: string, durationMs = 2500): void {
  if (active === undefined) return;
  const { browser } = active;
  if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
  browser.flashMessage = message;
  browser.flashTimer = setTimeout(() => {
    if (active === undefined || active.browser !== browser) return;
    browser.flashMessage = undefined;
    browser.flashTimer = undefined;
    void refresh(true);
  }, durationMs);
  void refresh(true);
}
