
import type {
  AppCapabilityInstallProgress,
  AppCapabilityStatus,
  AppCatalogProvider,
  AppConfig,
  AppEvent,
  AppHost,
  AppAgentState,
  AppGoal,
  AppMcpAuthBeginResult,
  AppMcpAuthStatus,
  AppMcpServerLocator,
  AppModel,
  AppPluginCapabilities,
  AppPluginMarketplaceEntry,
  AppPluginMcpServerInfo,
  AppPluginSkillInfo,
  AppPluginSummary,
  AppProvider,
  FsEntry,
  AppMessageContent,
  AppSession,
  AppSessionRatingReport,
  AppSessionRatingOffer,
  AppSessionUsage,
  AppSessionWorktree,
  AppWorkspace,
  AppWorktree,
  AppWorktreeRisk,
  AppWorktreeSessionRef,
  AppWorktreeSetupRequest,
  ApprovalResponse,
  DeleteSessionResult,
  GitStatusBatchResult,
  GitStatusEntry,
  PromptSubmission,
  PullRequestBatchResult,
  PullRequestResult,
  SessionWorktreeAction,
  SessionWorktreeRetryInput,
  WorkspaceGitBranches,
  WorktreeInspection,
  WorktreeList,
  WorktreeLookup,
  WorktreeSetupScript,
  QuestionAnswer,
  QuestionItem,
  QuestionOption,
  QuestionResponse,
  SessionTask,
} from '../types';

import type {
  WireApprovalResponse,
  WireCapabilityInstallProgress,
  WireCapabilityStatus,
  WireCatalogProvider,
  WireAgentStateFrame,
  WireMcpAuthBeginResult,
  WireMcpAuthStatus,
  WireMcpServerLocator,
  WirePluginCapabilities,
  WirePluginMarketplaceEntry,
  WirePluginMcpServerInfo,
  WirePluginSkillInfo,
  WirePluginSummary,
  WireTaskState,
  WireFsEntry,
  WireImageSource,
  WireMessageContent,
  WireModel,
  WirePromptSubmission,
  WireProvider,
  WireQuestionAnswer,
  WireQuestionItem,
  WireQuestionOption,
  WireQuestionResponse,
  WireSession,
  WireSessionRatingReport,
  WireSessionRatingResult,
  WireSessionWorktree,
  WireWorkspace,
  WireWorkspaceGitBranches,
  WireWorktree,
  WireWorktreeRisk,
  WireWorktreeSessionRef,
  WireWorktreeSetupRequest,
  WireDeleteSessionResponse,
  WireGitStatusBatchResult,
  WireGitStatusResult,
  WireInspectWorktreesResponse,
  WireListWorktreesResponse,
  WireLookupWorktreeResponse,
  WirePullRequest,
  WirePullRequestBatchResult,
  WirePullRequestLookupStatus,
  WireWorktreeSetupScript,
  WireEvent,
  WireHost,
  WireConfig,
  WireInteraction,
} from './wire';

export function isPlaceholderSessionUsage(usage: AppSessionUsage): boolean {
  return (
    usage.contextTokens === 0 &&
    usage.contextLimit === 0 &&
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.turnCount === 0
  );
}

export function toAppSession(wire: WireSession): AppSession {
  return {
    id: wire.id,
    title: wire.title,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
    busy: wire.activity !== 'idle',
    mainTurnActive: wire.activity === 'turn',
    pendingInteraction: wire.pending_interaction,
    lastTurnReason: wire.last_turn_outcome === 'interrupted' ? 'cancelled' : wire.last_turn_outcome,
    archived: wire.archived ?? false,
    archivedAt: wire.archived_at,
    lastPrompt: wire.last_prompt,
    cwd: wire.cwd,
    model: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    workspaceId: wire.workspace_id && wire.workspace_id.length > 0 ? wire.workspace_id : undefined,
    parentSessionId:
      typeof wire.metadata?.['parent_session_id'] === 'string'
        ? wire.metadata['parent_session_id']
        : undefined,
    pullRequest: wire.git === undefined ? undefined : (wire.git.pull_request ?? null),
    hostId: wire.host_id,
    ...(wire.worktree === undefined ? {} : { worktree: toAppSessionWorktree(wire.worktree) }),
  };
}

export function toAppWorktreeSetupRequest(wire: WireWorktreeSetupRequest): AppWorktreeSetupRequest {
  return {
    sourceBranch: wire.source_branch,
    includeLocalChanges: wire.include_local_changes,
    useRemote: wire.use_remote,
    runSetupScript: wire.run_setup_script,
  };
}

export function toWireWorktreeSetupRequest(app: AppWorktreeSetupRequest): WireWorktreeSetupRequest {
  const wire: WireWorktreeSetupRequest = { source_branch: app.sourceBranch };
  if (app.includeLocalChanges !== undefined) wire.include_local_changes = app.includeLocalChanges;
  if (app.useRemote !== undefined) wire.use_remote = app.useRemote;
  if (app.runSetupScript !== undefined) wire.run_setup_script = app.runSetupScript;
  return wire;
}

export function toAppSessionWorktree(wire: WireSessionWorktree): AppSessionWorktree {
  const setup = wire.setup;
  return {
    path: wire.path,
    branch: wire.branch,
    base: wire.base === undefined ? undefined : { ref: wire.base.ref, remote: wire.base.remote, commit: wire.base.commit },
    includedLocalChanges: wire.included_local_changes,
    missing: wire.missing,
    branchMissing: wire.branch_missing,
    setup: {
      status: setup.status,
      purpose: setup.purpose,
      request: toAppWorktreeSetupRequest(setup.request),
      steps: setup.steps.map((step) => ({
        kind: step.kind,
        state: step.state,
        ref: step.ref,
        command: step.command,
        output: step.output,
        timedOut: step.timed_out,
      })),
      commandsRan: setup.commands_ran,
      startedAt: setup.started_at,
      endedAt: setup.ended_at,
      stoppedStep: setup.stopped_step,
      failure:
        setup.failure === undefined
          ? undefined
          : {
              kind: setup.failure.kind,
              remoteRef: setup.failure.remote_ref,
              conflictFiles: setup.failure.conflict_files,
              exitCode: setup.failure.exit_code,
              timeoutSeconds: setup.failure.timeout_seconds,
            },
      script: setup.script,
      scriptContent: setup.script_content,
    },
  };
}

const SESSION_WORKTREE_ACTION_SEGMENTS: Record<SessionWorktreeAction, string> = {
  retry: 'retry',
  cancel: 'cancel',
  useLocal: 'use_local',
  skipScript: 'skip_script',
  runScript: 'run_script',
  recreate: 'recreate',
};

export function sessionWorktreeActionSegment(action: SessionWorktreeAction): string {
  return SESSION_WORKTREE_ACTION_SEGMENTS[action];
}

export function toWireSessionWorktreeRetry(input: SessionWorktreeRetryInput | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input?.includeLocalChanges !== undefined) body['include_local_changes'] = input.includeLocalChanges;
  if (input?.useRemote !== undefined) body['use_remote'] = input.useRemote;
  return body;
}

function toAppWorktreeSessionRef(wire: WireWorktreeSessionRef): AppWorktreeSessionRef {
  return { id: wire.id, title: wire.title, archived: wire.archived, busy: wire.busy };
}

export function toAppWorktree(wire: WireWorktree): AppWorktree {
  return {
    path: wire.path,
    name: wire.name,
    repoRoot: wire.repo_root,
    workspaceId: wire.workspace_id,
    workspaceName: wire.workspace_name,
    branch: wire.branch,
    origin: wire.origin,
    createdAt: wire.created_at,
    sizeBytes: wire.size_bytes,
    sessions: (wire.sessions ?? []).map(toAppWorktreeSessionRef),
  };
}

export function toWorktreeList(wire: WireListWorktreesResponse): WorktreeList {
  return {
    items: (wire.items ?? []).map(toAppWorktree),
    totalSizeBytes: wire.total_size_bytes,
  };
}

export function toAppWorktreeRisk(wire: WireWorktreeRisk): AppWorktreeRisk {
  return {
    path: wire.path,
    branch: wire.branch,
    uncommittedFiles: wire.uncommitted_files,
    unpushedCommits: wire.unpushed_commits,
    sessions: (wire.sessions ?? []).map(toAppWorktreeSessionRef),
  };
}

export function toWorktreeInspection(wire: WireInspectWorktreesResponse): WorktreeInspection {
  return {
    items: (wire.items ?? []).map(toAppWorktreeRisk),
    errors: wire.errors ?? {},
  };
}

export function toWorktreeLookup(wire: WireLookupWorktreeResponse): WorktreeLookup | null {
  const found = wire.worktree;
  if (found === null || found === undefined) return null;
  return {
    repoRoot: found.repo_root,
    branch: found.branch,
    workspace: found.workspace === undefined ? undefined : toAppWorkspace(found.workspace),
    sessionCount: found.session_count,
  };
}

export function toWorkspaceGitBranches(wire: WireWorkspaceGitBranches): WorkspaceGitBranches {
  return {
    isRepo: wire.is_repo,
    headBranch: wire.head_branch,
    dirty: wire.dirty,
    remotes: wire.remotes,
    branches: (wire.branches ?? []).map((branch) => ({
      name: branch.name,
      committedAt: branch.committed_at,
      remoteRef: branch.remote_ref,
      remote: branch.remote,
      remoteSource: branch.remote_source,
    })),
  };
}

export function toDeleteSessionResult(wire: WireDeleteSessionResponse): DeleteSessionResult {
  if (wire.worktree === undefined) return { deleted: true };
  return {
    deleted: true,
    worktree: {
      outcome: wire.worktree.outcome,
      branchDeleted: wire.worktree.branch_deleted,
      otherSessions: wire.worktree.other_sessions,
      output: wire.worktree.output,
    },
  };
}

export function toGitStatusEntry(wire: WireGitStatusResult): GitStatusEntry {
  const entry: GitStatusEntry = {
    branch: wire.branch,
    ahead: wire.ahead,
    behind: wire.behind,
    entries: wire.entries,
    additions: wire.additions,
    deletions: wire.deletions,
    pullRequest: wire.pullRequest ?? null,
  };
  if (wire.upstream !== undefined) entry.upstream = wire.upstream;
  if (wire.head !== undefined) entry.head = wire.head;
  if (wire.detached !== undefined) entry.detached = wire.detached;
  if (wire.stats_error !== undefined) entry.statsError = wire.stats_error;
  if (wire.pull_request_status !== undefined) entry.pullRequestStatus = wire.pull_request_status;
  if (wire.pull_request_error !== undefined) entry.pullRequestError = wire.pull_request_error;
  return entry;
}

export function toGitStatusBatchResult(wire: WireGitStatusBatchResult): GitStatusBatchResult {
  const results: GitStatusBatchResult['results'] = {};
  for (const [root, value] of Object.entries(wire.results ?? {})) results[root] = toGitStatusEntry(value);
  return { results, errors: wire.errors ?? {} };
}

export function toPullRequestResult(data: WirePullRequest | null | undefined, details: unknown): PullRequestResult {
  const result: PullRequestResult = {
    pullRequest: data === null || data === undefined ? null : { number: data.number, state: data.state, url: data.url },
  };
  const lookup = (typeof details === 'object' && details !== null ? details : {}) as Partial<WirePullRequestLookupStatus>;
  if (lookup.pull_request_status !== undefined) result.status = lookup.pull_request_status;
  if (lookup.pull_request_error !== undefined) result.error = lookup.pull_request_error;
  return result;
}

export function toPullRequestBatchResult(wire: WirePullRequestBatchResult): PullRequestBatchResult {
  const statuses: PullRequestBatchResult['statuses'] = {};
  for (const [root, lookup] of Object.entries(wire.statuses ?? {})) {
    statuses[root] = { status: lookup.pull_request_status, error: lookup.pull_request_error };
  }
  return { results: wire.results ?? {}, statuses, errors: wire.errors ?? {} };
}

export function toWorktreeSetupScript(wire: WireWorktreeSetupScript): WorktreeSetupScript {
  const script: WorktreeSetupScript = { path: wire.path, exists: wire.exists };
  if (wire.content !== undefined) script.content = wire.content;
  if (wire.needs_confirmation !== undefined) script.needsConfirmation = wire.needs_confirmation;
  return script;
}

export function toAppWorkspace(wire: WireWorkspace): AppWorkspace {
  return {
    id: wire.id,
    root: wire.root,
    name: wire.name,
    kind: wire.kind,
    additionalDirs: wire.additional_dirs,
    lastOpenedAt: wire.last_opened_at,
    sessionCount: wire.session_count,
    ...(wire.host_id === undefined ? {} : { hostId: wire.host_id }),
  };
}

export function toWireMessageContent(app: AppMessageContent): WireMessageContent {
  switch (app.type) {
    case 'text':
      return { type: 'text', text: app.text };
    case 'toolUse':
      return {
        type: 'tool_use',
        tool_call_id: app.toolCallId,
        tool_name: app.toolName,
        input: app.input,
      };
    case 'toolResult':
      return {
        type: 'tool_result',
        tool_call_id: app.toolCallId,
        output: app.output,
        is_error: app.isError,
      };
    case 'image':
    case 'video': {
      const src = app.source;
      let wireSrc: WireImageSource;
      if (src.kind === 'base64') {
        wireSrc = { kind: 'base64', media_type: src.mediaType, data: src.data };
      } else if (src.kind === 'file') {
        wireSrc = { kind: 'file', file_id: src.fileId };
      } else if (src.kind === 'sessionMedia') {
        wireSrc = { kind: 'session_media', file_id: src.fileId };
      } else {
        wireSrc = { kind: 'url', url: src.url };
      }
      return {
        type: app.type,
        source: wireSrc,
        ...(app.name === undefined ? {} : { name: app.name }),
      };
    }
    case 'file':
      return {
        type: 'file',
        file_id: app.fileId,
        name: app.name,
        media_type: app.mediaType,
        size: app.size,
      };
    case 'thinking':
      return { type: 'thinking', thinking: app.thinking, signature: app.signature };
    case 'unknown':
      return app.raw as WireMessageContent;
  }
}

export function toWirePromptSubmission(input: PromptSubmission): WirePromptSubmission {
  return {
    prompt_id: input.promptId,
    content: input.content.map(toWireMessageContent),
    metadata: input.metadata,
    agent_id: input.agentId,
    model: input.model,
    thinking: input.thinking,
    permission_mode: input.permissionMode,
    plan_mode: input.planMode,
    swarm_mode: input.swarmMode,
    goal_objective: input.goalObjective,
    goal_control: input.goalControl,
    skills: input.skills,
  };
}

export function toWireApprovalResponse(input: ApprovalResponse): WireApprovalResponse {
  return {
    decision: input.decision,
    scope: input.scope,
    feedback: input.feedback,
    selected_label: input.selectedLabel,
  };
}

function toAppQuestionOption(wire: WireQuestionOption): QuestionOption {
  return {
    id: wire.id,
    label: wire.label,
    description: wire.description,
  };
}

function toAppQuestionItem(wire: WireQuestionItem): QuestionItem {
  return {
    id: wire.id,
    question: wire.question,
    header: wire.header,
    body: wire.body,
    options: wire.options.map(toAppQuestionOption),
    multiSelect: wire.multi_select,
    allowOther: wire.allow_other,
    otherLabel: wire.other_label,
    otherDescription: wire.other_description,
  };
}

export function toAppInteractionEvent(interaction: WireInteraction): AppEvent {
  const sessionId = interaction.session_id;
  if (interaction.status === 'ended') {
    const response = interaction.kind === 'approval' ? interaction.response : undefined;
    return {
      type: 'interactionEnded',
      sessionId,
      interactionId: interaction.interaction_id,
      kind: interaction.kind,
      outcome: interaction.outcome ?? 'cancelled',
      feedback: response?.feedback,
      selectedLabel: response?.selected_label,
    };
  }
  if (interaction.kind === 'approval') {
    return {
      type: 'approvalRequested',
      sessionId,
      approval: {
        approvalId: interaction.interaction_id,
        sessionId,
        agentId: interaction.agent_id,
        toolCallId: interaction.tool_call_id ?? interaction.interaction_id,
        toolName: interaction.request.tool_name,
        action: interaction.request.action,
        display: interaction.request.tool_input_display,
      },
    };
  }
  return {
    type: 'questionRequested',
    sessionId,
    question: {
      questionId: interaction.interaction_id,
      sessionId,
      agentId: interaction.agent_id,
      toolCallId: interaction.tool_call_id,
      questions: interaction.request.questions.map(toAppQuestionItem),
    },
  };
}

function toWireQuestionAnswer(app: QuestionAnswer): WireQuestionAnswer {
  switch (app.kind) {
    case 'single':
      return { kind: 'single', option_id: app.optionId };
    case 'multi':
      return { kind: 'multi', option_ids: app.optionIds };
    case 'other':
      return { kind: 'other', text: app.text };
    case 'multiWithOther':
      return { kind: 'multi_with_other', option_ids: app.optionIds, other_text: app.otherText };
    case 'skipped':
      return { kind: 'skipped' };
  }
}

export function toWireQuestionResponse(input: QuestionResponse): WireQuestionResponse {
  const wireAnswers: Record<string, WireQuestionAnswer> = {};
  for (const [questionId, answer] of Object.entries(input.answers)) {
    wireAnswers[questionId] = toWireQuestionAnswer(answer);
  }
  return {
    answers: wireAnswers,
    method: input.method,
    note: input.note,
  };
}

export function toSessionTask(wire: WireTaskState): SessionTask {
  return {
    taskId: wire.task_id,
    kind: wire.kind,
    state: wire.status === 'running' ? 'running' : (wire.outcome ?? 'lost'),
    phase: wire.phase,
    detached: wire.detached,
    description: wire.description,
    agentId: wire.child_agent_id,
    parentToolCallId: wire.parent_tool_call_id,
    swarmIndex: wire.swarm_index,
    command: wire.command,
    startedAt: wire.started_at,
    endedAt: wire.ended_at,
    resultSummary: wire.result_summary,
    stateReason: wire.state_reason,
    model: wire.model,
    thinkingEffort: wire.thinking,
  };
}

export function toAppFsEntry(wire: WireFsEntry): FsEntry {
  return {
    path: wire.path,
    name: wire.name,
    kind: wire.kind,
    size: wire.size,
    modifiedAt: wire.modified_at,
    etag: wire.etag,
    mime: wire.mime,
    languageId: wire.language_id,
    isBinary: wire.is_binary,
    isDirectory: wire.is_directory,
    isSymlinkTo: wire.is_symlink_to,
    gitStatus: wire.git_status,
    childCount: wire.child_count,
  };
}

function recordString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function recordNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordNullableNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toAppSessionRatingOffer(result: WireSessionRatingResult): AppSessionRatingOffer | null {
  return result.appearance === null
    ? null
    : { appearanceId: result.appearance.id, survey: result.appearance.survey };
}

export function toWireSessionRatingReport(report: AppSessionRatingReport): WireSessionRatingReport {
  return report.op === 'respond'
    ? { op: 'respond', appearance_id: report.appearanceId, response: report.response }
    : { op: report.op, appearance_id: report.appearanceId };
}

export function toAppAgentState(frame: WireAgentStateFrame): AppAgentState {
  return {
    status: frame.status,
    compacting: frame.compacting,
    model: frame.model,
    thinking: frame.thinking,
    permissionMode: frame.permission_mode,
    planMode: frame.plan_mode,
    swarmMode: frame.swarm_mode,
    towerMode: frame.tower_mode,
  };
}

export function toAppGoal(snapshot: unknown): AppGoal | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const source = snapshot as Record<string, unknown>;
  const status = recordString(source, 'status');
  if (status !== 'active' && status !== 'paused' && status !== 'blocked' && status !== 'complete') {
    return null;
  }

  const budgetRaw = source['budget'];
  const budget = budgetRaw && typeof budgetRaw === 'object' ? budgetRaw as Record<string, unknown> : {};

  return {
    goalId: recordString(source, 'goalId') ?? recordString(source, 'goal_id') ?? 'goal',
    objective: recordString(source, 'objective') ?? '',
    completionCriterion: recordString(source, 'completionCriterion') ?? recordString(source, 'completion_criterion'),
    status,
    turnsUsed: recordNumber(source, 'turnsUsed') ?? recordNumber(source, 'turns_used') ?? 0,
    tokensUsed: recordNumber(source, 'tokensUsed') ?? recordNumber(source, 'tokens_used') ?? 0,
    wallClockMs: recordNumber(source, 'wallClockMs') ?? recordNumber(source, 'wall_clock_ms') ?? 0,
    terminalReason: recordString(source, 'terminalReason') ?? recordString(source, 'terminal_reason'),
    budget: {
      tokenBudget: recordNullableNumber(budget, 'tokenBudget') ?? recordNullableNumber(budget, 'token_budget'),
      remainingTokens: recordNullableNumber(budget, 'remainingTokens') ?? recordNullableNumber(budget, 'remaining_tokens'),
      turnBudget: recordNullableNumber(budget, 'turnBudget') ?? recordNullableNumber(budget, 'turn_budget'),
      remainingTurns: recordNullableNumber(budget, 'remainingTurns') ?? recordNullableNumber(budget, 'remaining_turns'),
      wallClockBudgetMs: recordNullableNumber(budget, 'wallClockBudgetMs') ?? recordNullableNumber(budget, 'wall_clock_budget_ms'),
      remainingWallClockMs: recordNullableNumber(budget, 'remainingWallClockMs') ?? recordNullableNumber(budget, 'remaining_wall_clock_ms'),
      overBudget: budget['overBudget'] === true || budget['over_budget'] === true,
    },
  };
}

export function toAppCapabilityInstallProgress(
  wire: WireCapabilityInstallProgress,
): AppCapabilityInstallProgress {
  return {
    running: wire.running,
    step: wire.step,
    percent: wire.percent,
    error: wire.error,
    note: wire.note,
    confirmationRequired: wire.confirmation_required,
  };
}

export function toAppCapabilityStatus(wire: WireCapabilityStatus): AppCapabilityStatus {
  return {
    id: wire.id,
    pluginId: wire.plugin_id,
    displayName: wire.display_name,
    description: wire.description,
    supported: wire.supported,
    state: wire.state,
    version: wire.version,
    steps: wire.steps,
    install: toAppCapabilityInstallProgress(wire.install),
  };
}

export function toAppPluginSummary(wire: WirePluginSummary): AppPluginSummary {
  return {
    id: wire.id,
    displayName: wire.display_name,
    description: wire.description,
    shortDescription: wire.short_description,
    longDescription: wire.long_description,
    version: wire.version,
    enabled: wire.enabled,
    state: wire.state,
    skillCount: wire.skill_count,
    mcpServerCount: wire.mcp_server_count,
    enabledMcpServerCount: wire.enabled_mcp_server_count,
    hookCount: wire.hook_count,
    commandCount: wire.command_count,
    hasErrors: wire.has_errors,
    source: wire.source,
    originalSource: wire.original_source,
    origin: wire.origin,
    installedAt: wire.installed_at,
    catalogId: wire.catalog_id,
  };
}

function toAppPluginSkillInfo(wire: WirePluginSkillInfo): AppPluginSkillInfo {
  return {
    name: wire.name,
    displayName: wire.display_name,
    description: wire.description,
  };
}

function toAppPluginMcpServerInfo(wire: WirePluginMcpServerInfo): AppPluginMcpServerInfo {
  return {
    name: wire.name,
    displayName: wire.display_name,
    description: wire.description,
    iconUrl: wire.icon_url,
    runtimeName: wire.runtime_name,
    enabled: wire.enabled,
    transport: wire.transport,
    command: wire.command,
    args: wire.args,
    cwd: wire.cwd,
    url: wire.url,
    envKeys: wire.env_keys,
    headerKeys: wire.header_keys,
  };
}

export function toAppPluginCapabilities(wire: WirePluginCapabilities): AppPluginCapabilities {
  return {
    skills: wire.skills.map(toAppPluginSkillInfo),
    mcpServers: wire.mcp_servers.map(toAppPluginMcpServerInfo),
  };
}

function toAppPluginMarketplaceLocale(
  locale: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (locale === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(locale)) {
    if (key === 'default_locale') {
      out['defaultLocale'] = value;
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const block = value as Record<string, unknown>;
      out[key] = {
        displayName: block['display_name'] ?? block['displayName'],
        shortDescription: block['short_description'] ?? block['shortDescription'],
        longDescription: block['long_description'] ?? block['longDescription'],
        cliDescription: block['cli_description'] ?? block['cliDescription'],
      };
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function toAppPluginMarketplaceEntry(
  wire: WirePluginMarketplaceEntry,
): AppPluginMarketplaceEntry {
  return {
    id: wire.id,
    tier: wire.tier,
    displayName: wire.display_name,
    description: wire.description,
    shortDescription: wire.short_description,
    longDescription: wire.long_description,
    cliDescription: wire.cli_description,
    homepage: wire.homepage,
    keywords: wire.keywords,
    version: wire.version,
    sha256sum: wire.sha256sum,
    source: wire.source,
    capabilityId: wire.capability_id,
    installed: wire.installed,
    updateAvailable: wire.update_available,
    iconUrl: wire.icon_url,
    defaultLocale: wire.default_locale,
    locale: toAppPluginMarketplaceLocale(wire.locale),
    platforms: wire.platforms,
    distribution:
      wire.distribution === undefined
        ? undefined
        : {
            category: wire.distribution.category,
            region: wire.distribution.region,
            defaultInstall: wire.distribution.default_install,
            weight: wire.distribution.weight,
            userLevel: wire.distribution.user_level,
          },
    billing: wire.billing,
  };
}

export function toAppMcpAuthStatus(wire: WireMcpAuthStatus): AppMcpAuthStatus {
  return {
    name: wire.name,
    authStatus: wire.auth_status,
  };
}

export function toWireMcpServerLocator(locator: AppMcpServerLocator): WireMcpServerLocator {
  if (locator.source === 'global') return { source: 'global', name: locator.name };
  return { source: 'plugin', plugin_id: locator.pluginId, server_name: locator.serverName };
}

export function toAppMcpAuthBeginResult(wire: WireMcpAuthBeginResult): AppMcpAuthBeginResult {
  if (wire.status === 'already-authorized') return { status: 'already-authorized' };
  return {
    status: 'authorization-required',
    flowId: wire.flow_id,
    authorizationUrl: wire.authorization_url,
  };
}

export function toAppEvent(wire: WireEvent): AppEvent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = wire as any;
  switch (w.type) {
    case 'session': {
      const session = toAppSession(w.session);
      if (w.change === 'created') return { type: 'sessionCreated', session };
      if (w.change === 'deleted') return { type: 'sessionDeleted', sessionId: session.id };
      if (w.change === 'archived') {
        return { type: 'sessionArchived', sessionId: session.id, workspaceId: session.workspaceId };
      }
      if (w.change === 'restored') return { type: 'sessionRestored', sessionId: session.id };
      return {
        type: 'sessionWorkChanged',
        sessionId: session.id,
        busy: session.busy,
        mainTurnActive: session.mainTurnActive,
        pendingInteraction: session.pendingInteraction,
        lastTurnReason: session.lastTurnReason,
        session,
      };
    }

    case 'workspace':
      if (w.change === 'created') {
        return { type: 'workspaceCreated', workspace: toAppWorkspace(w.workspace) };
      }
      if (w.change === 'updated') {
        return { type: 'workspaceUpdated', workspace: toAppWorkspace(w.workspace) };
      }
      return {
        type: 'workspaceDeleted',
        workspaceId: w.workspace.id,
        root: w.workspace.root,
      };

    case 'config':
      return {
        type: 'configChanged',
        changedFields: [],
        config: toAppConfig(w.config),
        warnings: w.warnings,
      };

    case 'invalidated':
      if (w.kind === 'plugins') return { type: 'pluginsChanged' };
      return { type: 'modelCatalogChanged', changed: [], unchanged: [], failed: [] };

    case 'event.capability.changed':
      return {
        type: 'capabilityChanged',
        capabilityId: w.capability_id,
        install: toAppCapabilityInstallProgress(w.install),
      };

    case 'event.host.changed':
      return {
        type: 'hostsChanged',
        hosts: Array.isArray(w.hosts) ? w.hosts.map((host: WireHost) => toAppHost(host)) : [],
      };

    default:
      return { type: 'unknown', raw: wire };
  }
}

export function toAppHost(wire: WireHost): AppHost {
  return {
    id: wire.id,
    host: wire.host,
    identityFile: wire.identity_file,
    remoteBin: wire.remote_bin,
    name: wire.name,
    enabled: wire.enabled,
    status: wire.status,
    remoteVersion: wire.remote_version,
    connectError: wire.connect_error,
    connectFailure: wire.connect_failure as AppHost['connectFailure'],
  };
}

export function toAppModel(wire: WireModel): AppModel {
  return {
    id: wire.model,
    provider: wire.provider,
    model: wire.model,
    displayName: wire.display_name,
    maxContextSize: wire.max_context_size,
    capabilities: wire.capabilities,
    supportEfforts: wire.support_efforts,
    defaultEffort: wire.default_effort,
  };
}

export function toAppProvider(wire: WireProvider): AppProvider {
  return {
    id: wire.id,
    type: wire.type,
    baseUrl: wire.base_url,
    defaultModel: wire.default_model,
    hasApiKey: wire.has_api_key,
    status: wire.status,
    models: wire.models,
  };
}

export function toAppCatalogProvider(wire: WireCatalogProvider): AppCatalogProvider {
  return {
    id: wire.id,
    name: wire.name,
    wireType: wire.wire_type,
    baseUrl: wire.base_url,
    guessed: wire.guessed,
    needsBaseUrl: wire.needs_base_url,
    rejected: wire.rejected,
    rejectReason: wire.reject_reason,
    envKey: wire.env_key,
    models: wire.models.map((model) => ({
      id: model.id,
      name: model.name,
      maxContextSize: model.max_context_size,
      capabilities: model.capabilities,
      reasoning: model.reasoning,
    })),
  };
}

export function toAppConfig(wire: WireConfig): AppConfig {
  const providers: Record<string, { type: string; baseUrl?: string; defaultModel?: string; hasApiKey: boolean }> = {};
  for (const [id, provider] of Object.entries(wire.providers)) {
    providers[id] = {
      type: provider.type,
      baseUrl: provider.base_url,
      defaultModel: provider.default_model,
      hasApiKey: provider.has_api_key,
    };
  }
  return {
    providers,
    defaultProvider: wire.default_provider,
    defaultModel: wire.default_model,
    secondaryModel: wire.secondary_model as AppConfig['secondaryModel'],
    models: wire.models,
    thinking: wire.thinking as { enabled?: boolean; effort?: string } | undefined,
    planMode: wire.plan_mode,
    yolo: wire.yolo,
    defaultPermissionMode: wire.default_permission_mode,
    defaultPlanMode: wire.default_plan_mode,
    autoSessionTitle: wire.auto_session_title,
    permission: wire.permission,
    hooks: wire.hooks,
    services: wire.services,
    mergeAllAvailableSkills: wire.merge_all_available_skills,
    extraSkillDirs: wire.extra_skill_dirs,
    loopControl: wire.loop_control,
    background: wire.background,
    experimental: wire.experimental,
    telemetry: wire.telemetry,
    disableFeedbackSurvey: wire.disable_feedback_survey,
    raw: wire.raw,
  };
}

export function wireEventSessionId(wire: WireEvent): string {
  return 'session' in wire ? (wire.session as WireSession).id : '__global__';
}
