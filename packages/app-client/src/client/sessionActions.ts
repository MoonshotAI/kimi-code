import type { AppSession } from '@moonshot-ai/app-core/api';
import { isDaemonApiError, isPlaceholderSessionUsage, isSessionOccupiedError, SESSION_BUSY_CODE, SESSION_EXPORT_TOO_LARGE_CODE } from '@moonshot-ai/app-core/api';
import { isDesktop } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi, notifySessionForked, sessionExportTraceToJsonl, t, traceKeyEvent } from './deps';
import { track } from '../contracts';
import { modelsStore } from '../stores/models';
import { promptStore } from '../stores/prompt';
import { notifySessionStale, retryWhileOccupied } from './sessionOccupancy';
import { sessionListStore } from '../stores/sessionList';
import { sessionRuntimeStore } from '../stores/sessionRuntime';
import { sessionRatingStore } from '../stores/sessionRating';
import { sessionsStore } from '../stores/sessions';
import { warningsStore } from '../stores/warnings';

const COMPACTION_UNABLE_CODE = 40910;

export interface SessionActionsDeps {
  mainUndoTarget: (sessionId: string, turnId?: string) => { turnId: string; text: string } | null;
  updateSession: (id: string, update: (session: AppSession) => AppSession) => void;
  selectSession: (sessionId: string, opts?: { skipTrack?: boolean }) => Promise<void>;
  upsertSessionSorted: (session: AppSession) => void;
  isCompactionRunning: (sessionId: string) => boolean;
}

export function createSessionActions(deps: SessionActionsDeps) {
  let exportInFlight = false;

  async function exportSession(targetSessionId?: string): Promise<boolean> {
    if (exportInFlight) return false;
    const sessionId = targetSessionId ?? sessionsStore().activeSessionId;
    if (!sessionId) {
      const message = t('commands.export.noSession');
      traceKeyEvent('export:failed', { status: 'no-session' });
      warningsStore().pushOperationFailure('exportSession', new Error(message), { message });
      return false;
    }
    exportInFlight = true;
    const startedAt = Date.now();
    traceKeyEvent('export:start', { sessionId });
    try {
      const webLog = sessionExportTraceToJsonl();
      const { blob, fileName } = await getKimiWebApi().exportSession(sessionId, webLog, {
        desktop: isDesktop,
      });
      if (typeof document === 'undefined') throw new Error('Document is unavailable');
      const url = URL.createObjectURL(blob);
      let anchor: HTMLAnchorElement | undefined;
      try {
        anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor?.remove();
        setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
          } catch {
          }
        }, 0);
      }
      traceKeyEvent('export:accepted', {
        sessionId,
        status: 'accepted',
        zipBytes: blob.size,
        durationMs: Date.now() - startedAt,
      });
      return true;
    } catch (error) {
      const failure =
        typeof error === 'object' && error !== null
          ? (error as {
              name?: unknown;
              code?: unknown;
              requestId?: unknown;
              phase?: unknown;
              status?: unknown;
            })
          : undefined;
      traceKeyEvent('export:failed', {
        sessionId,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorName:
          typeof failure?.name === 'string' ? failure.name : typeof error,
        errorCode: typeof failure?.code === 'number' ? failure.code : undefined,
        requestId: typeof failure?.requestId === 'string' ? failure.requestId : undefined,
        phase: typeof failure?.phase === 'string' ? failure.phase : undefined,
        httpStatus: typeof failure?.status === 'number' ? failure.status : undefined,
      });
      warningsStore().pushOperationFailure('exportSession', error, {
        sessionId,
        ...(isDaemonApiError(error) && error.code === SESSION_EXPORT_TOO_LARGE_CODE
          ? { message: t('commands.export.tooLarge', { sessionId }) }
          : {}),
      });
      return false;
    } finally {
      exportInFlight = false;
    }
  }

  function compact(
    instruction?: string,
    hooks?: { onRequestRejected?: (err: unknown) => void },
  ): boolean {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return false;
    const store = promptStore();
    store.beginCompactStart(sid);
    void retryWhileOccupied(sid, () => getKimiWebApi().compactSession(sid, instruction)).then(
      () => store.holdCompactStartGrace(sid),
      (err) => {
        store.settleCompactStart(sid);
        hooks?.onRequestRejected?.(err);
        if (isSessionOccupiedError(err)) return;
        if (isDaemonApiError(err) && err.code === COMPACTION_UNABLE_CODE) {
          warningsStore().pushWarning({
            severity: 'warning',
            title: t(deps.isCompactionRunning(sid) ? 'commands.compactQueue.compacting' : 'commands.compactQueue.busy'),
          });
          return;
        }
        warningsStore().pushOperationFailure('compact', err, { sessionId: sid });
      },
    );
    return true;
  }

  async function forkSession(sessionId?: string, turnIndex?: number): Promise<void> {
    const sid = sessionId ?? sessionsStore().activeSessionId;
    if (!sid || sessionRuntimeStore().forkInFlightBySession[sid] === true) return;
    sessionRuntimeStore().forkInFlightBySession[sid] = true;
    try {
      const forked = await getKimiWebApi().forkSession(sid, { turnIndex });
      sessionListStore().notePoolInsert(forked.id);
      deps.upsertSessionSorted(forked);
      try {
        await notifySessionForked(sid, forked.id);
      } catch (error) {
        warningsStore().pushOperationFailure('fork', error, {
          sessionId: forked.id,
          message: t('browser.forkTabsFailed'),
        });
      }
      await deps.selectSession(forked.id, { skipTrack: true });
    } catch (err) {
      warningsStore().pushOperationFailure('fork', err, { sessionId: sid });
    } finally {
      delete sessionRuntimeStore().forkInFlightBySession[sid];
    }
  }

  async function undo(turnId?: string): Promise<{ text: string } | null> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return null;
    const target = deps.mainUndoTarget(sid, turnId);
    if (target === null) return null;
    try {
      sessionRatingStore().endSession(sid);
      await retryWhileOccupied(sid, () => getKimiWebApi().undoSession(sid, target.turnId));
      const reasonChangeBefore = sessionRuntimeStore().lastTurnReasonChangeBySession[sid];
      void getKimiWebApi()
        .getSession(sid)
        .then((fresh) => {
          if (sessionRuntimeStore().lastTurnReasonChangeBySession[sid] !== reasonChangeBefore) return;
          deps.updateSession(sid, (s) => ({ ...s, lastTurnReason: fresh.lastTurnReason }));
        })
        .catch(() => {
        });
      return { text: target.text };
    } catch (err) {
      if (isSessionOccupiedError(err)) return null;
      if (notifySessionStale(err, 'operation')) return null;
      warningsStore().pushOperationFailure('undo', err, { sessionId: sid });
      return null;
    }
  }

  async function reloadSession(sessionId?: string): Promise<boolean> {
    const sid = sessionId ?? sessionsStore().activeSessionId;
    if (!sid) return false;
    const target = sessionsStore().sessions.find((session) => session.id === sid);
    if (target?.archived === true) {
      track('session_reload_result', { result: 'archived' });
      warningsStore().pushOperationFailure('reloadSession', new Error(t('commands.reload.archived')), {
        sessionId: sid,
        message: t('commands.reload.archived'),
      });
      return false;
    }
    try {
      sessionRatingStore().endSession(sid);
      const reloaded = await getKimiWebApi().reloadSession(sid);
      const merged = { ...reloaded };
      const existingPr = target?.pullRequest;
      if (
        existingPr !== undefined &&
        existingPr !== null &&
        (reloaded.pullRequest === undefined || reloaded.pullRequest === null)
      ) {
        merged.pullRequest = existingPr;
      }
      const existingUsage = target?.usage;
      if (
        existingUsage !== undefined &&
        isPlaceholderSessionUsage(reloaded.usage) &&
        !isPlaceholderSessionUsage(existingUsage)
      ) {
        merged.usage = existingUsage;
      }
      deps.upsertSessionSorted(merged);
      await modelsStore().loadSkillsForSession(sid).catch(() => {
      });
      warningsStore().refreshSessionWarnings(sid);
      warningsStore().pushWarning({ severity: 'success', title: t('header.sessionReloaded') });
      track('session_reload_result', { result: 'success' });
      return true;
    } catch (err) {
      const busy = isDaemonApiError(err) && err.code === SESSION_BUSY_CODE;
      track('session_reload_result', { result: busy ? 'busy' : 'error' });
      warningsStore().pushOperationFailure('reloadSession', err, {
        sessionId: sid,
        ...(busy ? { message: t('commands.reload.busy') } : {}),
      });
      return false;
    }
  }

  return {
    exportSession,
    compact,
    forkSession,
    undo,
    reloadSession,
  };
}

export type UseSessionActions = ReturnType<typeof createSessionActions>;
