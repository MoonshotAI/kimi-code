import { randomUUID } from 'node:crypto';

import type { DurableAgentRuntimeParticipant, IEventDispatcher, IDisposable } from '@moonshot-ai/agent-core-v2';
import { ContextAppendMessage } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import { TurnEnded, TurnPrompt } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';

interface SurveyTurnHistory {
  readonly count: number;
  readonly reliable: boolean;
  readonly firstPrompt: number;
  readonly firstUserMessage: number;
  readonly firstPromptAt?: number;
  readonly currentOrigin?: unknown;
  readonly evaluation?: {
    readonly origin: unknown;
    readonly requestId?: string;
    readonly endedAt?: number;
  };
}

export interface SurveyTurnRecovery {
  readonly userTurnCount: number;
  readonly firstPromptAt?: number;
  readonly origin: unknown;
  readonly requestId?: string;
  readonly endedAt?: number;
}

const EMPTY_HISTORY: SurveyTurnHistory = {
  count: 0,
  reliable: true,
  firstPrompt: Infinity,
  firstUserMessage: Infinity,
};

function countOf(history: SurveyTurnHistory): number | undefined {
  return history.reliable && history.firstUserMessage >= history.firstPrompt
    ? history.count
    : undefined;
}

function observeHistory(
  history: SurveyTurnHistory,
  record: unknown,
  position: number,
): SurveyTurnHistory {
  if (record === null || typeof record !== 'object') return { ...history, reliable: false };
  if (!('type' in record)) return history;
  const time = 'time' in record && typeof record.time === 'number' ? record.time : undefined;
  if (record.type === 'turn.prompt') {
    const origin = 'origin' in record ? record.origin : undefined;
    const counted = isSurveyTurnOrigin(origin);
    return {
      ...history,
      count: history.count + (counted === true ? 1 : 0),
      reliable: history.reliable && counted !== undefined,
      firstPrompt: Math.min(history.firstPrompt, position),
      firstPromptAt: history.firstPromptAt ?? time,
      currentOrigin: origin,
      evaluation: undefined,
    };
  }
  if (record.type === 'turn.ended') {
    const origin = history.currentOrigin;
    return {
      ...history,
      currentOrigin: undefined,
      evaluation: isSurveyTurnOrigin(origin) === true
        ? {
            origin,
            requestId: 'requestId' in record && typeof record.requestId === 'string' ? record.requestId : undefined,
            endedAt: time,
          }
        : undefined,
    };
  }
  if (record.type === 'context.append_message' && 'message' in record) {
    const message = record.message;
    if (message === null || typeof message !== 'object' || !('role' in message) || message.role !== 'user') return history;
    const origin = 'origin' in message ? message.origin : undefined;
    if (
      origin === undefined || origin === null ||
      (typeof origin === 'object' && 'kind' in origin && origin.kind !== 'shell_command' &&
        isSurveyTurnOrigin(origin) === true)
    ) {
      return { ...history, firstUserMessage: Math.min(history.firstUserMessage, position) };
    }
  }
  return history;
}

export interface MountedSurveyTurnCounter extends IDisposable {
  readonly count: number | undefined;
  readonly whenAttached: Promise<void>;
  recovery(): SurveyTurnRecovery | undefined;
}

export function mountSurveyTurnCounter(dispatcher: IEventDispatcher): MountedSurveyTurnCounter {
  let state = { history: EMPTY_HISTORY, position: 0 };
  let attachment:
    | { phase: 'pending' }
    | { phase: 'attached'; registration: IDisposable }
    | { phase: 'disposed' } = { phase: 'pending' };
  const participant: DurableAgentRuntimeParticipant<typeof state> = {
    id: `session-rating.survey-turns:${randomUUID()}`,
    events: [TurnPrompt, TurnEnded, ContextAppendMessage],
    undoable: false,
    getState: () => state,
    commit: (next) => { state = next; },
    transition: (current, event) => ({
      history: observeHistory(current.history, event.serialize(), current.position),
      position: current.position + 1,
    }),
  };
  const register = (registration: IDisposable): void => {
    if (attachment.phase === 'disposed') registration.dispose();
    else attachment = { phase: 'attached', registration };
  };
  let whenAttached: Promise<void>;
  if (dispatcher.restorePhase === 'new') {
    register(dispatcher.attach(participant));
    whenAttached = Promise.resolve();
  } else {
    whenAttached = dispatcher.attachLate(participant).then(register);
  }
  return {
    whenAttached,
    get count() {
      return attachment.phase !== 'attached' || dispatcher.restorePhase !== 'ready'
        ? undefined
        : countOf(state.history);
    },
    recovery() {
      if (attachment.phase !== 'attached' || dispatcher.restorePhase !== 'ready') return undefined;
      const userTurnCount = countOf(state.history);
      const evaluation = state.history.evaluation;
      if (userTurnCount === undefined || evaluation === undefined) return undefined;
      return {
        userTurnCount,
        firstPromptAt: state.history.firstPromptAt,
        origin: evaluation.origin,
        requestId: evaluation.requestId,
        endedAt: evaluation.endedAt,
      };
    },
    dispose() {
      if (attachment.phase === 'attached') attachment.registration.dispose();
      attachment = { phase: 'disposed' };
    },
  };
}

export class SurveyTurnCounter {
  private history = EMPTY_HISTORY;

  get count(): number | undefined {
    return countOf(this.history);
  }

  observe(record: unknown, position: number): void {
    this.history = observeHistory(this.history, record, position);
  }

  invalidate(): void {
    this.history = { ...this.history, reliable: false };
  }
}

export function isSurveyTurnOrigin(origin: unknown): boolean | undefined {
  if (origin === null || typeof origin !== 'object' || !('kind' in origin)) return undefined;
  switch (origin.kind) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      if (!('trigger' in origin) || typeof origin.trigger !== 'string') return undefined;
      return origin.trigger === 'user-slash';
    case 'shell_command':
      if (!('phase' in origin) || typeof origin.phase !== 'string') return undefined;
      return origin.phase === 'input';
    case 'cron_job':
    case 'cron_missed':
    case 'system_trigger':
    case 'task':
    case 'background_task':
    case 'hook_result':
    case 'compaction_summary':
    case 'injection':
    case 'retry':
      return false;
    default:
      return undefined;
  }
}
