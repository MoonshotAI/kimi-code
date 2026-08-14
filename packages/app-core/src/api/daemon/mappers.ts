// apps/kimi-web/src/api/daemon/mappers.ts
// wire→app and app→wire mapper functions.
// All snake_case ↔ camelCase conversion happens ONLY here.

import type {
  AppApprovalRequest,
  AppCatalogProvider,
  AppConfig,
  AppEvent,
  AppGoal,
  AppModel,
  AppProvider,
  FsEntry,
  AppMessage,
  AppMessageContent,
  AppMessageRole,
  AppQuestionRequest,
  AppSession,
  AppSessionUsage,
  AppTask,
  AppTaskStatus,
  AppWorkspace,
  ApprovalResponse,
  ImageSource,
  PromptSubmission,
  QuestionAnswer,
  QuestionItem,
  QuestionOption,
  QuestionResponse,
  V2Session,
} from '../types';

import type {
  WireApprovalRequest,
  WireApprovalResponse,
  WireCatalogProvider,
  WireTask,
  WireFsEntry,
  WireImageSource,
  WireMessage,
  WireMessageContent,
  WireModel,
  WirePromptSubmission,
  WireProvider,
  WireQuestionAnswer,
  WireQuestionItem,
  WireQuestionOption,
  WireQuestionRequest,
  WireQuestionResponse,
  WireSession,
  WireSessionUsage,
  WireWorkspace,
  WireEvent,
  WireConfig,
} from './wire';

// ---------------------------------------------------------------------------
// Session mappers
// ---------------------------------------------------------------------------

export function toAppSessionUsage(wire: WireSessionUsage): AppSessionUsage {
  return {
    inputTokens: wire.input_tokens,
    outputTokens: wire.output_tokens,
    cacheReadTokens: wire.cache_read_tokens,
    cacheCreationTokens: wire.cache_creation_tokens,
    totalCostUsd: wire.total_cost_usd,
    contextTokens: wire.context_tokens,
    contextLimit: wire.context_limit,
    turnCount: wire.turn_count,
  };
}

/**
 * True when a session usage object is the daemon's all-zero placeholder.
 * Both engines return placeholders for the heavy session fields on the
 * list/snapshot read paths; the live values arrive via GET /status and the
 * WS `agent.status.updated` stream. Callers replacing a cached session with
 * a wire record must keep the live usage when the incoming one is this
 * placeholder, or the context ring drops to 0 until the next refresh.
 */
export function isPlaceholderSessionUsage(usage: AppSessionUsage): boolean {
  return (
    usage.contextTokens === 0 &&
    usage.contextLimit === 0 &&
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.turnCount === 0
  );
}

/**
 * Merge a snapshot's session into the pooled one (session open / reopen /
 * resync all funnel through this). The snapshot's wire session is the v1
 * projection, and the pooled entry carries facts that projection must not
 * overwrite:
 * - usage arrives as the all-zero placeholder (both engines) — keep the live
 *   usage folded in from /status and the WS stream instead of zeroing the
 *   context ring on every snapshot sync;
 * - model may be empty (the daemon couldn't resolve it) — keep the pooled one;
 * - pullRequest rides only the v2 list's git domain (include=git); the v1
 *   snapshot never carries it — preserve the pooled value (`undefined` =
 *   never checked, `null` = checked, no PR);
 * - updatedAt is prompt-submit-grained server-side while the client bumps at
 *   turn end and on approval/question requests. Blindly taking the server
 *   value re-sorted the sidebar on every click (and could even downgrade a
 *   newer local bump), so keep whichever timestamp is newer — except while
 *   the main turn is still running: the server also bumps mid-turn (prompt
 *   submit, auto title), and importing that on click floats the session
 *   before the turn finishes. The turn's start and end both bump recency via
 *   durable WS events (replayed after a reconnect), so nothing is lost by
 *   holding the local value until then.
 *
 * `mainTurnActive` is the snapshot's EFFECTIVE main-turn liveness, computed by
 * the caller (`snap.session.mainTurnActive ?? (inFlightTurn !== null && busy)`)
 * — older daemons omit the field, and treating the absence as "not running"
 * would import a mid-turn server timestamp on click.
 */
export function mergeSnapshotSession(
  pooled: AppSession,
  snap: AppSession,
  mainTurnActive: boolean,
): AppSession {
  return {
    ...snap,
    model: snap.model.length > 0 ? snap.model : pooled.model,
    usage: isPlaceholderSessionUsage(snap.usage) ? pooled.usage : snap.usage,
    updatedAt:
      !mainTurnActive && snap.updatedAt > pooled.updatedAt
        ? snap.updatedAt
        : pooled.updatedAt,
    pullRequest: snap.pullRequest ?? pooled.pullRequest,
  };
}

export function toAppSession(wire: WireSession): AppSession {  return {
    id: wire.id,
    title: wire.title,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
    busy: wire.busy,
    mainTurnActive: wire.main_turn_active,
    pendingInteraction: wire.pending_interaction,
    lastTurnReason: wire.last_turn_reason,
    archived: wire.archived ?? false,
    archivedAt: wire.archived_at,
    currentPromptId: wire.current_prompt_id,
    lastPrompt: wire.last_prompt,
    cwd: wire.metadata.cwd,
    model: wire.agent_config.model,
    usage: toAppSessionUsage(wire.usage),
    messageCount: wire.message_count,
    lastSeq: wire.last_seq,
    workspaceId: wire.workspace_id,
    parentSessionId:
      typeof wire.metadata['parent_session_id'] === 'string'
        ? wire.metadata['parent_session_id']
        : undefined,
  };
}

/**
 * v2 session（domain 结构，见 types.ts 注释块）折回 AppSession。v2 列表不携带
 * usage / model / message_count 等重字段（文档的 domain 设计），这里填
 * placeholder 零值 usage（isPlaceholderSessionUsage 语义，后续会被 /status 的
 * live 值替换）与空 model；标题按文档 fallback：title → last_prompt → id 前 12 位。
 */
export function toAppSessionFromV2(session: V2Session): AppSession {
  const status = session.activity.status;
  return {
    id: session.id,
    title: session.meta.title ?? session.meta.last_prompt ?? session.id.slice(0, 12),
    createdAt: new Date(session.meta.created_at).toISOString(),
    updatedAt: new Date(session.meta.updated_at).toISOString(),
    // v2 `running` means ANY lease (background/sub-agent included) — the
    // domain has no main-turn flag, so mainTurnActive stays unset here rather
    // than falsely rendering a main-turn spinner for background-only sessions
    // until a v1/status refresh corrects it. busy is the honest bit.
    busy: status === 'running',
    pendingInteraction:
      status === 'approval' ? 'approval' : status === 'question' ? 'question' : undefined,
    lastTurnReason: status === 'failed' ? 'failed' : undefined,
    archived: session.meta.archived,
    // `== null` covers both the contract's null and older daemons omitting
    // the key entirely.
    archivedAt:
      session.meta.archived_at == null
        ? undefined
        : new Date(session.meta.archived_at).toISOString(),
    lastPrompt: session.meta.last_prompt ?? undefined,
    cwd: session.workspace.cwd ?? '',
    model: '',
    pullRequest: session.git === undefined ? undefined : session.git.pull_request,
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
    lastSeq: 0,
    workspaceId: session.workspace.id.length > 0 ? session.workspace.id : undefined,
  };
}

export function toAppWorkspace(wire: WireWorkspace): AppWorkspace {
  return {
    id: wire.id,
    root: wire.root,
    name: wire.name,
    lastOpenedAt: wire.last_opened_at,
    sessionCount: wire.session_count,
  };
}

// ---------------------------------------------------------------------------
// Message mappers
// ---------------------------------------------------------------------------

function toAppImageSource(src: WireImageSource): ImageSource {
  if (src.kind === 'base64') {
    return { kind: 'base64', mediaType: src.media_type, data: src.data };
  }
  if (src.kind === 'file') {
    return { kind: 'file', fileId: src.file_id };
  }
  return { kind: 'url', url: src.url };
}

export function toAppMessageContent(wire: WireMessageContent): AppMessageContent {
  switch (wire.type) {
    case 'text':
      return { type: 'text', text: wire.text };
    case 'tool_use':
      return {
        type: 'toolUse',
        toolCallId: wire.tool_call_id,
        toolName: wire.tool_name,
        input: wire.input,
      };
    case 'tool_result':
      return {
        type: 'toolResult',
        toolCallId: wire.tool_call_id,
        output: wire.output,
        isError: wire.is_error,
      };
    case 'image':
      return {
        type: 'image',
        source: toAppImageSource(wire.source),
      };
    case 'video':
      return {
        type: 'video',
        source: toAppImageSource(wire.source),
      };
    case 'file':
      return {
        type: 'file',
        fileId: wire.file_id,
        name: wire.name,
        mediaType: wire.media_type,
        size: wire.size,
      };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: wire.thinking,
        signature: wire.signature,
      };
    default: {
      // Unknown content type — pass raw through
      return { type: 'unknown', raw: wire };
    }
  }
}

export function toAppMessage(wire: WireMessage): AppMessage {
  return {
    id: wire.id,
    sessionId: wire.session_id,
    role: wire.role as AppMessageRole,
    content: wire.content.map(toAppMessageContent),
    createdAt: wire.created_at,
    promptId: wire.prompt_id,
    parentMessageId: wire.parent_message_id,
    metadata: wire.metadata,
  };
}

// ---------------------------------------------------------------------------
// Prompt mappers
// ---------------------------------------------------------------------------

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
      } else {
        wireSrc = { kind: 'url', url: src.url };
      }
      return { type: app.type, source: wireSrc };
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
      // Best-effort: pass raw back. May not be a valid WireMessageContent.
      return app.raw as WireMessageContent;
  }
}

export function toWirePromptSubmission(input: PromptSubmission): WirePromptSubmission {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Approval mappers
// ---------------------------------------------------------------------------

export function toWireApprovalResponse(input: ApprovalResponse): WireApprovalResponse {
  return {
    decision: input.decision,
    scope: input.scope,
    feedback: input.feedback,
    selected_label: input.selectedLabel,
  };
}

export function toAppApprovalRequest(wire: WireApprovalRequest): AppApprovalRequest {
  return {
    approvalId: wire.approval_id,
    sessionId: wire.session_id,
    turnId: wire.turn_id,
    toolCallId: wire.tool_call_id,
    toolName: wire.tool_name,
    action: wire.action,
    // The real daemon sends `tool_input_display`; the stub sends `display`.
    display: wire.tool_input_display ?? wire.display,
    expiresAt: wire.expires_at,
    createdAt: wire.created_at,
  };
}

// ---------------------------------------------------------------------------
// Question mappers
// ---------------------------------------------------------------------------

function toAppQuestionOption(wire: WireQuestionOption): QuestionOption {
  return {
    id: wire.id,
    label: wire.label,
    description: wire.description,
    recommended: wire.recommended === true || wire.is_recommended === true,
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

export function toAppQuestionRequest(wire: WireQuestionRequest): AppQuestionRequest {
  return {
    questionId: wire.question_id,
    sessionId: wire.session_id,
    turnId: wire.turn_id,
    toolCallId: wire.tool_call_id,
    questions: wire.questions.map(toAppQuestionItem),
    createdAt: wire.created_at,
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

// ---------------------------------------------------------------------------
// Task mapper
// ---------------------------------------------------------------------------

export function toAppTask(wire: WireTask, knownAgentId?: string): AppTask {
  return {
    id: wire.id,
    agentId: wire.agent_id ?? knownAgentId,
    sessionId: wire.session_id,
    kind: wire.kind,
    description: wire.description,
    status: wire.status as AppTaskStatus,
    command: wire.command,
    createdAt: wire.created_at,
    startedAt: wire.started_at,
    completedAt: wire.completed_at,
    outputPreview: wire.output_preview,
    outputBytes: wire.output_bytes,
    subagentPhase: wire.subagent_phase,
    subagentType: wire.subagent_type,
    model: wire.model,
    thinkingEffort: wire.thinking_effort,
    parentToolCallId: wire.parent_tool_call_id,
    suspendedReason: wire.suspended_reason,
    swarmIndex: wire.swarm_index,
    // The snapshot's subagent roster carries the explicit flag. REST `/tasks`
    // does not, but its background-task store only holds detached tasks, so any
    // subagent it returns is a background subagent (foreground ones never
    // persist there) — hence the `?? true` fallback for that path.
    runInBackground: wire.run_in_background ?? (wire.kind === 'subagent' ? true : undefined),
    // outputLines starts undefined; populated by eventReducer via task.progress events
  };
}

// ---------------------------------------------------------------------------
// FsEntry mapper
// ---------------------------------------------------------------------------

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
    isSymlinkTo: wire.is_symlink_to,
    gitStatus: wire.git_status,
    childCount: wire.child_count,
  };
}

// ---------------------------------------------------------------------------
// WireEvent → AppEvent
// ---------------------------------------------------------------------------

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

/**
 * Map a WireEvent to an AppEvent.
 *
 * Decision: reducer consumes AppEvent.
 * - Visible events are fully mapped to their camelCase AppEvent variant.
 * - No-op-but-known streaming/tool events (tool.*, assistant.tool_use_*,
 *   assistant.completed) are folded to { type: 'unknown', raw } so the reducer
 *   can advance lastSeqBySession without emitting warnings.
 *   We use a dedicated sentinel raw: { _noop: true } so Task 7 reducer can
 *   distinguish real unknowns (push warning) from no-op knowns (silent advance).
 * - Truly unknown events are also { type: 'unknown', raw } but raw._noop is absent.
 */
export function toAppEvent(wire: WireEvent): AppEvent {
  // TypeScript cannot narrow the WireEvent union through specific `case` arms
  // because the catch-all `WireEventUnknown` member has `type: string` (broad)
  // and `payload: unknown`, which prevents discriminated-union narrowing.
  // We cast to `any` once here; individual cases are still logically type-safe
  // because the union member types document the actual payload shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = wire as any;
  switch ((wire as { type: string }).type) {
    // ----- Session lifecycle -----
    case 'event.session.created':
      return { type: 'sessionCreated', session: toAppSession(w.payload.session) };

    case 'event.session.updated':
      return {
        type: 'sessionUpdated',
        session: toAppSession(w.payload.session),
        changedFields: w.payload.changed_fields,
      };

    case 'event.session.deleted':
      return { type: 'sessionDeleted', sessionId: w.session_id };

    // ----- Workspace lifecycle -----
    case 'event.workspace.created':
      return { type: 'workspaceCreated', workspace: toAppWorkspace(w.payload.workspace) };

    case 'event.workspace.updated':
      return { type: 'workspaceUpdated', workspace: toAppWorkspace(w.payload.workspace) };

    case 'event.workspace.deleted':
      return {
        type: 'workspaceDeleted',
        workspaceId: w.payload.workspace_id,
        root: w.payload.root,
      };

    case 'event.session.work_changed':
      return {
        type: 'sessionWorkChanged',
        sessionId: w.session_id,
        busy: w.payload.busy,
        mainTurnActive: w.payload.main_turn_active,
        pendingInteraction: w.payload.pending_interaction,
        lastTurnReason: w.payload.last_turn_reason,
      };

    // Deprecated: old journals may still carry status_changed; fold it onto
    // the busy flag (awaiting/running were live work, aborted was not).
    case 'event.session.status_changed':
      return {
        type: 'sessionWorkChanged',
        sessionId: w.session_id,
        busy: w.payload.status !== 'idle' && w.payload.status !== 'aborted',
        mainTurnActive: w.payload.status !== 'idle' && w.payload.status !== 'aborted',
        pendingInteraction:
          w.payload.status === 'awaiting_approval'
            ? 'approval'
            : w.payload.status === 'awaiting_question'
              ? 'question'
              : 'none',
        lastTurnReason: w.payload.status === 'aborted' ? 'cancelled' : undefined,
      };

    case 'event.session.usage_updated':
      return {
        type: 'sessionUsageUpdated',
        sessionId: w.session_id,
        usage: toAppSessionUsage(w.payload.usage),
      };

    case 'event.session.history_compacted':
      return {
        type: 'historyCompacted',
        sessionId: w.session_id,
        beforeSeq: w.payload.before_seq,
        reason: w.payload.reason,
        summaryMessageId: w.payload.summary_message_id,
      };

    case 'event.goal.updated': {
      const goal = toAppGoal(w.payload.snapshot ?? null);
      return {
        type: 'goalUpdated',
        sessionId: w.session_id,
        goal: goal?.status === 'complete' ? null : goal,
      };
    }

    // ----- Message lifecycle -----
    case 'event.message.created':
      return { type: 'messageCreated', message: toAppMessage(w.payload.message) };

    case 'event.message.updated':
      return {
        type: 'messageUpdated',
        sessionId: w.session_id,
        messageId: w.payload.message_id,
        content: w.payload.content.map(toAppMessageContent),
        status: w.payload.status,
      };

    // ----- Assistant streaming -----
    case 'event.assistant.delta':
      return {
        type: 'assistantDelta',
        sessionId: w.session_id,
        messageId: w.payload.message_id,
        contentIndex: w.payload.content_index,
        delta: w.payload.delta,
      };

    // No-op streaming events — advance seq silently
    case 'event.assistant.tool_use_started':
    case 'event.assistant.tool_use_delta':
    case 'event.assistant.tool_use_completed':
    case 'event.assistant.completed':
    case 'event.tool.started':
      return { type: 'unknown', raw: { _noop: true, _wireType: w.type } };

    case 'event.tool.output':
      return {
        type: 'toolOutput',
        sessionId: w.session_id,
        toolCallId: w.payload.tool_call_id,
        outputChunk: w.payload.chunk,
        stream: w.payload.stream,
      };

    case 'event.tool.progress':
      if (typeof w.payload.message === 'string' && w.payload.message.length > 0) {
        return {
          type: 'toolOutput',
          sessionId: w.session_id,
          toolCallId: w.payload.tool_call_id,
          outputChunk: w.payload.message,
          stream: 'stdout',
        };
      }
      return { type: 'unknown', raw: { _noop: true, _wireType: w.type } };

    case 'event.tool.completed':
      return { type: 'unknown', raw: { _noop: true, _wireType: w.type } };

    // ----- Approval -----
    case 'event.approval.requested':
      return {
        type: 'approvalRequested',
        sessionId: w.session_id,
        approval: toAppApprovalRequest(w.payload),
      };

    case 'event.approval.resolved':
      return {
        type: 'approvalResolved',
        sessionId: w.session_id,
        approvalId: w.payload.approval_id,
        decision: w.payload.decision,
        resolvedAt: w.payload.resolved_at,
        feedback: w.payload.feedback,
        selectedLabel: w.payload.selected_label,
      };

    case 'event.approval.expired':
      return {
        type: 'approvalExpired',
        sessionId: w.session_id,
        approvalId: w.payload.approval_id,
      };

    // ----- Question -----
    case 'event.question.requested':
      return {
        type: 'questionRequested',
        sessionId: w.session_id,
        question: toAppQuestionRequest(w.payload),
      };

    case 'event.question.answered':
      return {
        type: 'questionAnswered',
        sessionId: w.session_id,
        questionId: w.payload.question_id,
        resolvedAt: w.payload.resolved_at,
      };

    case 'event.question.dismissed':
      return {
        type: 'questionDismissed',
        sessionId: w.session_id,
        questionId: w.payload.question_id,
        dismissedAt: w.payload.dismissed_at,
      };

    // ----- Tasks -----
    case 'event.task.created':
      return {
        type: 'taskCreated',
        sessionId: w.session_id,
        task: toAppTask(w.payload.task),
      };

    case 'event.task.progress':
      return {
        type: 'taskProgress',
        sessionId: w.session_id,
        taskId: w.payload.task_id,
        outputChunk: w.payload.output_chunk,
        stream: w.payload.stream,
      };

    case 'event.task.completed':
      return {
        type: 'taskCompleted',
        sessionId: w.session_id,
        taskId: w.payload.task_id,
        status: w.payload.status as AppTaskStatus,
        outputPreview: w.payload.output_preview,
        outputBytes: w.payload.output_bytes,
      };

    case 'event.config.changed':
      return {
        type: 'configChanged',
        changedFields: w.payload.changed_fields,
        config: toAppConfig(w.payload.config),
      };

    case 'event.model_catalog.changed':
      return {
        type: 'modelCatalogChanged',
        changed: w.payload.changed.map(
          (item: { provider_id: string; provider_name: string; added: number; removed: number }) => ({
            providerId: item.provider_id,
            providerName: item.provider_name,
            added: item.added,
            removed: item.removed,
          }),
        ),
        unchanged: w.payload.unchanged,
        failed: w.payload.failed,
      };

    default: {
      // Truly unknown event — record warning
      return { type: 'unknown', raw: wire };
    }
  }
}

// ---------------------------------------------------------------------------
// Model + Provider mappers
// PRESUMED — not in current daemon docs; isolated here, swap when backend defines them.
// ---------------------------------------------------------------------------

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
    permission: wire.permission,
    hooks: wire.hooks,
    services: wire.services,
    mergeAllAvailableSkills: wire.merge_all_available_skills,
    extraSkillDirs: wire.extra_skill_dirs,
    loopControl: wire.loop_control,
    background: wire.background,
    experimental: wire.experimental,
    telemetry: wire.telemetry,
    raw: wire.raw,
  };
}

// Helper to extract sessionId from a WireEvent (needed by reducer for lastSeq update)
export function wireEventSessionId(wire: WireEvent): string {
  return wire.session_id;
}

export function wireEventSeq(wire: WireEvent): number {
  return wire.seq;
}
