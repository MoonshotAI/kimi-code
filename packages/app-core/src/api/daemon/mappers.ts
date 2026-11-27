
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
  AppWorkspace,
  ApprovalResponse,
  PromptSubmission,
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
  WireWorkspace,
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
  };
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
    displayName: wire.display_name,
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
