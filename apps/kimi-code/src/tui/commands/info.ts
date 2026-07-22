import { release as osRelease, type as osType } from 'node:os';

import type { McpServerInfo, SessionStatus, SessionUsage } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import { buildMcpStatusReportLines } from '../components/messages/mcp-status-panel';
import { buildStatusReportLines } from '../components/messages/status-panel';
import { buildUsageReportLines, UsagePanelComponent, type ManagedUsageReport } from '../components/messages/usage-panel';
import {
  FEEDBACK_ISSUE_URL,
  FEEDBACK_TELEMETRY_EVENT,
  feedbackIdLine,
  feedbackSessionLine,
  getFeedbackStatusCancelled,
  getFeedbackStatusFallback,
  getFeedbackStatusNetworkError,
  getFeedbackStatusNotSignedIn,
  getFeedbackStatusSubmitting,
  getFeedbackStatusSuccess,
  getFeedbackStatusUploadFailed,
  withFeedbackVersionPrefix,
} from '../constant/feedback';
import { isManagedUsageProvider } from '../constant/kimi-tui';
import { submitFeedbackWithAttachments } from '../../feedback/feedback-attachments';
import { formatErrorMessage } from '../utils/event-payload';
import { openUrl } from '#/utils/open-url';
import { promptFeedbackAttachment, promptFeedbackInput } from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export async function handleFeedbackCommand(host: SlashCommandHost): Promise<void> {
  const fallback = (reason: string): void => {
    host.showStatus(reason);
    host.showStatus(FEEDBACK_ISSUE_URL);
    openUrl(FEEDBACK_ISSUE_URL);
  };

  const providerKey = host.state.appState.availableModels[host.state.appState.model]?.provider;
  if (!isManagedUsageProvider(providerKey)) {
    fallback(getFeedbackStatusNotSignedIn());
    return;
  }

  // Stage 1: collect the free-form feedback text.
  const input = await promptFeedbackInput(host);
  if (input === undefined) {
    host.showStatus(getFeedbackStatusCancelled());
    return;
  }

  // Stage 2: ask whether to attach diagnostics (logs / codebase).
  const level = await promptFeedbackAttachment(host);
  if (level === undefined) {
    host.showStatus(getFeedbackStatusCancelled());
    return;
  }

  const version = withFeedbackVersionPrefix(host.state.appState.version);
  const spinner = host.showLoginProgressSpinner(getFeedbackStatusSubmitting());
  // Guarantee the spinner's underlying setInterval is always cleared, even when
  // submitFeedback or submitFeedbackWithAttachments throws — otherwise the
  // interval (and its per-frame requestRender) leaks for the rest of the session.
  let stopped = false;
  const stopSpinner = (opts: { ok: boolean; label: string }): void => {
    if (stopped) return;
    stopped = true;
    spinner.stop(opts);
  };
  try {
    const res = await host.harness.auth.submitFeedback({
      content: input.value,
      sessionId: host.state.appState.sessionId,
      version,
      os: `${osType()} ${osRelease()}`,
      model: host.state.appState.model.length > 0 ? host.state.appState.model : null,
    });

    if (res.kind !== 'ok') {
      stopSpinner({ ok: false, label: res.message });
      fallback(getFeedbackStatusFallback());
      return;
    }

    // Stage 3: prepare and upload each requested attachment independently.
    const attachmentFailed = await submitFeedbackWithAttachments(host, res.feedbackId, level);

    stopSpinner({ ok: true, label: getFeedbackStatusSuccess() });
    host.showStatus(feedbackSessionLine(host.state.appState.sessionId));
    host.showStatus(feedbackIdLine(res.feedbackId));
    host.track(FEEDBACK_TELEMETRY_EVENT);
    if (attachmentFailed) {
      host.showStatus(getFeedbackStatusUploadFailed());
    }
  } catch (error) {
    stopSpinner({ ok: false, label: getFeedbackStatusNetworkError() });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Info commands
// ---------------------------------------------------------------------------

interface SessionUsageResult {
  readonly usage?: SessionUsage;
  readonly error?: string;
}

interface RuntimeStatusResult {
  readonly status?: SessionStatus;
  readonly error?: string;
}

interface ManagedUsageResult {
  readonly usage?: ManagedUsageReport;
  readonly error?: string;
}

export async function showUsage(host: SlashCommandHost): Promise<void> {
  const sessionUsage = await loadSessionUsageReport(host);
  const managedUsage = await loadManagedUsageReport(host);
  const reportArgs = {
    sessionUsage: sessionUsage.usage,
    sessionUsageError: sessionUsage.error,
    contextUsage: host.state.appState.contextUsage,
    contextTokens: host.state.appState.contextTokens,
    maxContextTokens: host.state.appState.maxContextTokens,
    managedUsage: managedUsage?.usage,
    managedUsageError: managedUsage?.error,
  };
  const panel = new UsagePanelComponent(() => buildUsageReportLines(reportArgs), 'primary');
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

export async function showStatusReport(host: SlashCommandHost): Promise<void> {
  const [runtimeStatus, managedUsage] = await Promise.all([
    loadRuntimeStatusReport(host),
    loadManagedUsageReport(host),
  ]);
  const appState = host.state.appState;
  const reportArgs = {
    version: appState.version,
    model: appState.model,
    workDir: appState.workDir,
    sessionId: appState.sessionId,
    sessionTitle: appState.sessionTitle,
    thinkingEffort: appState.thinkingEffort,
    permissionMode: appState.permissionMode,
    planMode: appState.planMode,
    contextUsage: appState.contextUsage,
    contextTokens: appState.contextTokens,
    maxContextTokens: appState.maxContextTokens,
    availableModels: appState.availableModels,
    status: runtimeStatus.status,
    statusError: runtimeStatus.error,
    managedUsage: managedUsage?.usage,
    managedUsageError: managedUsage?.error,
  };
  const panel = new UsagePanelComponent(() => buildStatusReportLines(reportArgs), 'primary', ' Status ');
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

export async function showMcpServers(host: SlashCommandHost): Promise<void> {
  let servers: readonly McpServerInfo[];
  try {
    servers = await host.requireSession().listMcpServers();
  } catch (error) {
    host.showError(t('tui.messages.infoMcpLoadFailed', { error: formatErrorMessage(error) }));
    return;
  }

  const title = servers.length > 0 ? ` MCP (${servers.length}) ` : ' MCP ';
  const panel = new UsagePanelComponent(
    () => buildMcpStatusReportLines({ servers }),
    'primary',
    title,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function loadSessionUsageReport(host: SlashCommandHost): Promise<SessionUsageResult> {
  try {
    return { usage: await host.requireSession().getUsage() };
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
}

async function loadRuntimeStatusReport(host: SlashCommandHost): Promise<RuntimeStatusResult> {
  try {
    return { status: await host.requireSession().getStatus() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadManagedUsageReport(host: SlashCommandHost): Promise<ManagedUsageResult | undefined> {
  const alias = host.state.appState.model;
  const providerKey = host.state.appState.availableModels[alias]?.provider;
  if (!isManagedUsageProvider(providerKey)) return undefined;

  let res;
  try {
    res = await host.harness.auth.getManagedUsage(providerKey);
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
  if (res.kind === 'error') {
    return { error: res.message };
  }
  return { usage: { summary: res.summary, limits: res.limits, extraUsage: res.extraUsage } };
}
