import { appendFile, mkdir } from 'node:fs/promises';
import { release as osRelease, type as osType } from 'node:os';
import { join } from 'node:path';

import type { McpServerInfo, SessionStatus, SessionUsage } from '@moonshot-ai/kimi-code-sdk';

import { buildMcpStatusReportLines } from '../components/messages/mcp-status-panel';
import { buildStatusReportLines } from '../components/messages/status-panel';
import { buildUsageReportLines, UsagePanelComponent, type ManagedUsageReport } from '../components/messages/usage-panel';
import {
  FEEDBACK_ISSUE_URL,
  FEEDBACK_STATUS_CANCELLED,
  FEEDBACK_STATUS_FALLBACK,
  FEEDBACK_STATUS_NOT_SIGNED_IN,
  FEEDBACK_STATUS_SUBMITTING,
  FEEDBACK_STATUS_SUCCESS,
  FEEDBACK_STATUS_UPLOAD_FAILED,
  FEEDBACK_TELEMETRY_EVENT,
  feedbackIdLine,
  feedbackSessionLine,
  withFeedbackVersionPrefix,
} from '../constant/feedback';
import { isManagedUsageProvider } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { getLogDir } from '#/utils/paths';
import {
  packageCurrentCodebase,
  packageCurrentSession,
  removePackagedCodebaseArchive,
  scanCodebase,
  uploadPackagedCodebase,
  CODEBASE_ARCHIVE_FILENAME,
  SESSION_ARCHIVE_FILENAME,
  type FeedbackCodebaseArchive,
  type FeedbackCodebaseScanResult,
  type FeedbackUploadUrlApi,
} from '../../feedback/codebase-upload';
import { openUrl } from '#/utils/open-url';
import { promptFeedbackAttachment, promptFeedbackInput } from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

const CODEBASE_SCAN_TIMEOUT_MS = 3000;

export async function handleFeedbackCommand(host: SlashCommandHost): Promise<void> {
  const fallback = (reason: string): void => {
    host.showStatus(reason);
    host.showStatus(FEEDBACK_ISSUE_URL);
    openUrl(FEEDBACK_ISSUE_URL);
  };

  const providerKey = host.state.appState.availableModels[host.state.appState.model]?.provider;
  if (!isManagedUsageProvider(providerKey)) {
    fallback(FEEDBACK_STATUS_NOT_SIGNED_IN);
    return;
  }

  // Stage 1: collect the free-form feedback text.
  const input = await promptFeedbackInput(host);
  if (input === undefined) {
    host.showStatus(FEEDBACK_STATUS_CANCELLED);
    return;
  }

  // Stage 2: ask whether to attach diagnostics (logs / codebase).
  const level = await promptFeedbackAttachment(host);
  if (level === undefined) {
    host.showStatus(FEEDBACK_STATUS_CANCELLED);
    return;
  }

  const version = withFeedbackVersionPrefix(host.state.appState.version);
  const spinner = host.showLoginProgressSpinner(FEEDBACK_STATUS_SUBMITTING);
  const res = await host.harness.auth.submitFeedback({
    content: input.value,
    sessionId: host.state.appState.sessionId,
    version,
    os: `${osType()} ${osRelease()}`,
    model: host.state.appState.model.length > 0 ? host.state.appState.model : null,
  });

  if (res.kind !== 'ok') {
    spinner.stop({ ok: false, label: res.message });
    fallback(FEEDBACK_STATUS_FALLBACK);
    return;
  }

  // Stage 3: prepare and upload each requested attachment independently.
  // Attachment failures are non-fatal because the text feedback already exists,
  // but any requested artifact that cannot be prepared/uploaded is reported as
  // a partial attachment failure instead of silently downgrading the request.
  let attachmentFailed = false;
  const api = createFeedbackUploadApi(host);

  if (level === 'logs') {
    const uploaded = await prepareAndUploadSessionArchive(host, api, res.feedbackId);
    attachmentFailed = !uploaded;
  } else if (level === 'logs+codebase') {
    const [sessionDir, scan] = await Promise.all([
      resolveCurrentSessionDir(host),
      scanCodebaseForFeedback(host.state.appState.workDir),
    ]);
    const [uploadedSession, uploadedCodebase] = await Promise.all([
      prepareAndUploadSessionArchive(host, api, res.feedbackId, sessionDir),
      prepareAndUploadCodebaseArchive(api, res.feedbackId, scan),
    ]);
    attachmentFailed = !uploadedSession || !uploadedCodebase;
  }

  spinner.stop({ ok: true, label: FEEDBACK_STATUS_SUCCESS });
  host.showStatus(feedbackSessionLine(host.state.appState.sessionId));
  host.showStatus(feedbackIdLine(res.feedbackId));
  host.track(FEEDBACK_TELEMETRY_EVENT);
  if (attachmentFailed) {
    host.showStatus(FEEDBACK_STATUS_UPLOAD_FAILED);
  }
}

async function prepareAndUploadSessionArchive(
  host: SlashCommandHost,
  api: FeedbackUploadUrlApi,
  feedbackId: number,
  knownSessionDir?: string,
): Promise<boolean> {
  const sessionDir = knownSessionDir ?? (await resolveCurrentSessionDir(host));
  if (sessionDir === undefined) {
    await logFeedbackUploadError(new Error('cannot locate the current session directory'));
    return false;
  }

  let archive: FeedbackCodebaseArchive | undefined;
  try {
    archive = await packageCurrentSession(sessionDir);
    await uploadPackagedCodebase(api, archive, feedbackId, { filename: SESSION_ARCHIVE_FILENAME });
    return true;
  } catch (error) {
    await logFeedbackUploadError(error);
    return false;
  } finally {
    if (archive !== undefined) {
      await removePackagedCodebaseArchive(archive).catch(() => {});
    }
  }
}

async function prepareAndUploadCodebaseArchive(
  api: FeedbackUploadUrlApi,
  feedbackId: number,
  scan: FeedbackCodebaseScanResult | undefined,
): Promise<boolean> {
  if (scan === undefined) return false;

  let archive: FeedbackCodebaseArchive | undefined;
  try {
    archive = await packageCurrentCodebase(scan);
    await uploadPackagedCodebase(api, archive, feedbackId, { filename: CODEBASE_ARCHIVE_FILENAME });
    return true;
  } catch (error) {
    await logFeedbackUploadError(error);
    return false;
  } finally {
    if (archive !== undefined) {
      await removePackagedCodebaseArchive(archive).catch(() => {});
    }
  }
}

async function resolveCurrentSessionDir(host: SlashCommandHost): Promise<string | undefined> {
  try {
    const sessions = await host.harness.listSessions({ workDir: host.state.appState.workDir });
    return sessions.find((session) => session.id === host.state.appState.sessionId)?.sessionDir;
  } catch {
    return undefined;
  }
}

async function scanCodebaseForFeedback(workDir: string): Promise<FeedbackCodebaseScanResult | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, CODEBASE_SCAN_TIMEOUT_MS);
  try {
    return await scanCodebase(workDir, { signal: controller.signal });
  } catch (error) {
    await logFeedbackUploadError(error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function logFeedbackUploadError(error: unknown): Promise<void> {
  try {
    const logDir = getLogDir();
    await mkdir(logDir, { recursive: true });
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await appendFile(join(logDir, 'feedback-upload.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // best-effort logging only
  }
}

function createFeedbackUploadApi(host: SlashCommandHost): FeedbackUploadUrlApi {
  return {
    async createUploadUrl(input) {
      const res = await host.harness.auth.createFeedbackUploadUrl(input);
      if (res.kind !== 'ok') throw new Error(res.message);
      return {
        uploadId: res.upload_id,
        parts: res.parts.map((part) => ({
          partNumber: part.part_number,
          url: part.url,
          method: part.method,
          size: part.size,
        })),
      };
    },
    async completeUpload(input) {
      const res = await host.harness.auth.completeFeedbackUpload({
        uploadId: input.uploadId,
        parts: input.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
      });
      if (res.kind !== 'ok') throw new Error(res.message);
    },
  };
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
    thinking: appState.thinking,
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
    host.showError(`Failed to load MCP servers: ${formatErrorMessage(error)}`);
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
  return { usage: { summary: res.summary, limits: res.limits } };
}
