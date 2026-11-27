
import type { ConversationNotice } from '../../conversation/types';
import type { AppNoticeDetail } from '../../contracts';
import { isPlaceholderSessionUsage } from './mappers';
import type {
  AppApprovalRequest,
  AppConfig,
  AppEvent,
  AppGoal,
  AppNotice,
  AppWarning,
  AppQuestionRequest,
  AppSession,
} from '../types';

export interface ReduceContext {
  t: (key: string, params?: Record<string, unknown>) => string;
}

const DEFAULT_REDUCE_CONTEXT: ReduceContext = { t: (key) => key };

export interface CompactionStatus {
  status: 'running';
}

export interface KimiClientState {
  sessions: AppSession[];
  activeSessionId?: string;
  approvalsBySession: Record<string, AppApprovalRequest[]>;
  questionsBySession: Record<string, AppQuestionRequest[]>;
  goalBySession: Record<string, AppGoal>;
  goalVersionBySession: Record<string, number>;
  config?: AppConfig | null;
  warnings: AppWarning[];
}

export function createInitialState(): KimiClientState {
  return {
    sessions: [],
    activeSessionId: undefined,
    approvalsBySession: {},
    questionsBySession: {},
    goalBySession: {},
    goalVersionBySession: {},
    warnings: [],
  };
}

function cloneState(s: KimiClientState): KimiClientState {
  return {
    ...s,
    sessions: s.sessions,
    approvalsBySession: { ...s.approvalsBySession },
    questionsBySession: { ...s.questionsBySession },
    goalBySession: { ...s.goalBySession },
    goalVersionBySession: { ...s.goalVersionBySession },
    warnings: [...s.warnings],
  };
}

const AGENT_ERROR_TITLE_KEYS: Readonly<Record<string, string>> = {
  'provider.connection_error': 'connection',
  'provider.auth_error': 'auth',
  'provider.rate_limit': 'rateLimit',
  'provider.overloaded': 'overloaded',
  'provider.filtered': 'filtered',
  'provider.api_error': 'api',
  'context.overflow': 'contextOverflow',
};

const NOTICE_TITLE_KEYS: Readonly<Record<string, string>> = {
  ...AGENT_ERROR_TITLE_KEYS,
  'compaction.failed': 'compactionFailed',
};

export function isModelTurnErrorNotice(notice: ConversationNotice): boolean {
  return notice.code !== undefined && Object.hasOwn(AGENT_ERROR_TITLE_KEYS, notice.code);
}

export function buildAgentErrorNotice(notice: ConversationNotice, t: ReduceContext['t']): AppNotice {
  const details: AppNoticeDetail[] = [];
  if (notice.code !== undefined) details.push({ label: t('warnings.details.code'), value: notice.code });
  if (notice.detail !== undefined) details.push({ label: t('warnings.details.details'), value: notice.detail });
  const titleKey = (notice.code !== undefined ? NOTICE_TITLE_KEYS[notice.code] : undefined) ?? 'title';
  return {
    severity: 'error',
    title: t(`warnings.agentError.${titleKey}`),
    message: notice.title,
    details: details.length > 0 ? details : undefined,
  };
}

export interface EventMeta {
  sessionId: string;
}

export function reduceAppEvent(
  state: KimiClientState,
  event: AppEvent,
  meta: EventMeta,
  ctx: ReduceContext = DEFAULT_REDUCE_CONTEXT,
): KimiClientState {
  const next = cloneState(state);

  switch (event.type) {
    case 'sessionCreated': {
      const exists = next.sessions.some((s) => s.id === event.session.id);
      if (!exists) {
        next.sessions = [event.session, ...next.sessions];
      }
      break;
    }

    case 'sessionDeleted': {
      const id = event.sessionId;
      next.sessions = next.sessions.filter((s) => s.id !== id);
      delete next.goalBySession[id];
      delete next.goalVersionBySession[id];
      delete next.approvalsBySession[id];
      delete next.questionsBySession[id];
      if (next.activeSessionId === id) {
        next.activeSessionId = undefined;
      }
      break;
    }

    case 'sessionWorkChanged': {
      let pendingInteraction: AppSession['pendingInteraction'];
      next.sessions = next.sessions.map((s) => {
        if (s.id !== event.sessionId) return s;
        pendingInteraction =
          event.pendingInteraction ?? (event.busy ? s.pendingInteraction : 'none');
        const incoming = event.session;
        const base =
          incoming === undefined
            ? s
            : {
                ...incoming,
                model: incoming.model !== '' ? incoming.model : s.model,
                usage:
                  isPlaceholderSessionUsage(incoming.usage) && !isPlaceholderSessionUsage(s.usage)
                    ? s.usage
                    : incoming.usage,
                messageCount: incoming.messageCount > 0 ? incoming.messageCount : s.messageCount,
                pullRequest: incoming.pullRequest !== undefined ? incoming.pullRequest : s.pullRequest,
              };
        return {
          ...base,
          busy: event.busy,
          mainTurnActive: event.mainTurnActive ?? (event.busy ? base.mainTurnActive : false),
          pendingInteraction,
          lastTurnReason: event.lastTurnReason,
        };
      });
      if (pendingInteraction === 'none') {
        delete next.approvalsBySession[event.sessionId];
        delete next.questionsBySession[event.sessionId];
      } else if (pendingInteraction === 'question') {
        delete next.approvalsBySession[event.sessionId];
      }
      break;
    }

    case 'sessionMetaUpdated': {
      next.sessions = next.sessions.map((s) =>
        s.id === event.sessionId
          ? { ...s, title: event.title ?? s.title, lastPrompt: event.lastPrompt ?? s.lastPrompt }
          : s,
      );
      break;
    }

    case 'approvalRequested': {
      const sid = event.sessionId;
      const list = next.approvalsBySession[sid] ?? [];
      const exists = list.some((a) => a.approvalId === event.approval.approvalId);
      if (!exists) {
        next.approvalsBySession[sid] = [...list, event.approval];
      }
      break;
    }

    case 'questionRequested': {
      const sid = event.sessionId;
      const list = next.questionsBySession[sid] ?? [];
      const exists = list.some((q) => q.questionId === event.question.questionId);
      if (!exists) {
        next.questionsBySession[sid] = [...list, event.question];
      }
      break;
    }

    case 'interactionEnded': {
      const sid = event.sessionId;
      const id = event.interactionId;
      if (event.kind === 'approval') {
        const list = next.approvalsBySession[sid] ?? [];
        next.approvalsBySession[sid] = list.filter((a) => a.approvalId !== id);
      } else {
        const list = next.questionsBySession[sid] ?? [];
        next.questionsBySession[sid] = list.filter((q) => q.questionId !== id);
      }
      break;
    }

    case 'interactionsReset':
      delete next.approvalsBySession[event.sessionId];
      delete next.questionsBySession[event.sessionId];
      break;

    case 'configChanged': {
      next.config = event.config;
      break;
    }

    case 'modelCatalogChanged':
      break;

    case 'unknown': {
      const raw = event.raw as { _noop?: boolean; type?: string } | null;
      if (raw && raw._noop === true) break;
      const wireType = raw?.type ?? '(unknown)';
      next.warnings = [...next.warnings, ctx.t('warnings.unhandledEvent', { type: wireType })];
      break;
    }

    case 'workspaceCreated':
    case 'workspaceUpdated':
    case 'workspaceDeleted':
      break;

    case 'sessionArchived':
    case 'sessionRestored':
      break;

    case 'pluginsChanged':
    case 'capabilityChanged':
    case 'hostsChanged':
    case 'uiPreferencesChanged':
      break;

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      break;
    }
  }

  return next;
}
