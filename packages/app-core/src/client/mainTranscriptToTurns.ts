// packages/app-core/src/client/mainTranscriptToTurns.ts
// The MAIN conversation's transcript → ChatTurn pipeline (the migration's
// target shape, see docs/plans/2026-08-19-main-transcript-protocol.md). Same
// synthesis base as the detail panel (turnToMessages), plus the pieces only
// the main flow renders: origin-keyed turns (goal continuations, cron, skill
// cards), the compaction divider, and approval cards from interaction
// entities.

import type {
  AgentTranscriptSnapshot,
  TranscriptInteraction,
  TranscriptItem,
  TranscriptTask,
  TranscriptTurn,
} from '../transcript';
import type { AppApprovalRequest, AppMessage, AppQuestionRequest, CompactionMarkerMetadata, SessionPlan } from '../api';
import { COMPACTION_MARKER_METADATA_KEY } from '../api/types';

import { earliestTimestamp, turnToMessages } from './auxiliaryTranscriptToTurns';
import { messagesToTurns, extractCronPrompt } from './messagesToTurns';
import type { ChatTurn } from './types';

export function mainTranscriptToTurns(
  snapshot: AgentTranscriptSnapshot,
  deps: {
    sessionId: string;
    getFileUrl?: (fileId: string) => string;
    getSessionMediaUrl?: (sessionId: string, fileId: string) => string;
    /** Persisted ExitPlanMode records keyed by toolCallId (fetched via
     *  `GET transcript/plan` by the caller). */
    plansByToolCallId?: Record<string, SessionPlan>;
    planReviewByToolCallId?: Record<string, { plan: string; path?: string }>;
    /** Fallback start stamp for the first turn when its own stamps are
     *  missing (the main agent's registration time). */
    agentCreatedAt?: string;
    /** Observed times the session's pending interactions appeared, keyed by
     *  the suspended step id (see turnToMessages). */
    pendingInteractionAtByStepId?: ReadonlyMap<string, string>;
  },
): ChatTurn[] {
  const transcriptTurns = snapshot.items.filter((item) => item.kind === 'turn');
  const firstTurnId = transcriptTurns[0]?.turnId;
  const taskById = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
  const cronOriginOf = (candidate: TranscriptItem) =>
    candidate.kind === 'turn'
      ? (((candidate.origin as { payload?: unknown }).payload ?? candidate.origin) as {
          kind?: unknown;
          jobId?: unknown;
        })
      : undefined;
  // cron.fired markers consumed by their own turn, paired one-to-one in order:
  // back-to-back firings of one recurring job interleave as
  // marker A, marker B, turn A, turn B — matching each marker to only the NEXT
  // cron item renders A synthetically AND lets turn A cover B (3 cards for 2
  // firings).
  const consumedCronTurnIds = new Set<string>();

  const messages = snapshot.items.flatMap((item, itemIndex) => {
    if (item.kind === 'turn') {
      // The agent-createdAt fallback applies only when the turn and all its
      // steps lack a start stamp — otherwise the earliest-merge in
      // turnToMessages would backdate the turn to the agent's registration.
      const hasStart =
        item.startedAt !== undefined || item.steps.some((step) => step.startedAt !== undefined);
      return turnMessagesForMain(
        item,
        snapshot.attachments,
        taskById,
        // The first-turn fallback applies only to the session's real first
        // turn — a paged window's oldest turn is not it.
        item.turnId === firstTurnId && !hasStart && snapshot.hasMoreOlder !== true
          ? deps.agentCreatedAt
          : undefined,
        undefined,
        deps.sessionId,
        deps.pendingInteractionAtByStepId,
      );
    }
    if (item.kind === 'marker' && item.marker === 'compaction') {
      const message = compactionDividerMessage(
        item.payload,
        item.at,
        deps.sessionId,
        item.markerId,
        compactionTriggerBefore(snapshot.items, itemIndex),
      );
      return message === undefined ? [] : [message];
    }
    if (item.kind === 'marker' && item.marker === 'cron.fired') {
      // The daemon emits cron.fired BEFORE steer-injecting the prompt
      // (manager.handleFire), so this marker's own turn comes AFTER it. Pair
      // same-job/same-prompt markers and turns one-to-one in order: an older
      // firing's turn must not swallow this marker, and this marker must not
      // swallow a later marker's turn. The turn's prompt may carry the
      // <cron-fire> envelope — compare the INNER prompt exactly: a substring
      // test would pair this marker with a LATER firing's longer prompt
      // ('status' ⊂ 'status quo') and consume its turn, erasing this firing
      // and duplicating the later one.
      const fired = item.payload as
        | { origin?: { jobId?: unknown }; prompt?: unknown }
        | undefined;
      const jobId = fired?.origin?.jobId;
      const prompt = typeof fired?.prompt === 'string' ? fired.prompt : undefined;
      const mate = snapshot.items.slice(itemIndex + 1).find((candidate) => {
        if (candidate.kind !== 'turn' || consumedCronTurnIds.has(candidate.turnId)) return false;
        const p = cronOriginOf(candidate);
        return (
          p?.kind === 'cron_job' &&
          (jobId === undefined || p.jobId === jobId) &&
          (prompt === undefined ||
            (candidate.kind === 'turn' && extractCronPrompt(candidate.prompt ?? '') === prompt))
        );
      });
      if (mate !== undefined && mate.kind === 'turn') {
        consumedCronTurnIds.add(mate.turnId);
        return [];
      }
      const message = cronFiredMessage(item.payload, item.at, deps.sessionId, item.markerId);
      return message === undefined ? [] : [message];
    }
    return [];
  });

  const approvals = snapshot.interactions
    .map((interaction) => interactionToApproval(interaction, deps.sessionId))
    .filter((approval): approval is AppApprovalRequest => approval !== undefined);

  const running = snapshot.meta.activity === 'turn';
  return messagesToTurns(
    messages,
    approvals,
    deps.getFileUrl,
    running,
    deps.planReviewByToolCallId ?? {},
    deps.plansByToolCallId ?? {},
    { getSessionMediaUrl: deps.getSessionMediaUrl },
  ).map(clearMissingTimestamps);
}

function turnMessagesForMain(
  turn: TranscriptTurn,
  attachments: AgentTranscriptSnapshot['attachments'],
  taskById: ReadonlyMap<string, TranscriptTask>,
  fallbackStartedAt: string | undefined,
  fallbackEndedAt: string | undefined,
  sessionId: string,
  pendingInteractionAtByStepId?: ReadonlyMap<string, string>,
): AppMessage[] {
  const originPayload = (turn.origin as { payload?: unknown }).payload ?? turn.origin;
  const originKind = (originPayload as { kind?: unknown } | undefined)?.kind;
  // A system-triggered turn carries no prompt (the engine hides it), but the
  // main flow reads the continuation off the user message's origin — synthesize
  // the hidden placeholder so goalContinuation/skill/injection handling sees it.
  // Its stamp follows the same earliest-merge as turnToMessages: an empty
  // stamp here would seed the goal group's createdAt with '' and get the
  // group's timestamps cleared downstream.
  const hidden: AppMessage[] =
    turn.prompt === undefined && originKind === 'system_trigger'
      ? [
          {
            id: `${turn.turnId}:origin`,
            sessionId,
            role: 'user',
            content: [],
            createdAt:
              earliestTimestamp([
                turn.startedAt,
                ...turn.steps.map((step) => step.startedAt),
                fallbackStartedAt,
              ]) ?? '',
            promptId: turn.turnId,
            metadata: { origin: originPayload },
          },
        ]
      : [];
  return [
    ...hidden,
    ...turnToMessages(turn, attachments, taskById, fallbackStartedAt, fallbackEndedAt, sessionId, {
      includeOrigin: true,
      pendingInteractionAtByStepId,
    }),
  ];
}

/** The compaction divider turn's source message — the same shape the live
 *  reducer appends on compactionCompleted. The trigger comes from the nearest
 *  preceding started marker of the same compaction run. */
function compactionDividerMessage(
  payload: unknown,
  at: string | undefined,
  sessionId: string,
  markerId: string,
  trigger: 'manual' | 'auto',
): AppMessage | undefined {
  const p = payload as
    | { phase?: unknown; result?: { summary?: unknown; tokensBefore?: unknown; tokensAfter?: unknown } }
    | undefined;
  if (p?.phase !== 'completed') return undefined;
  const result = p.result ?? {};
  const marker: CompactionMarkerMetadata = {
    trigger,
    tokensBefore: typeof result.tokensBefore === 'number' ? result.tokensBefore : undefined,
    tokensAfter: typeof result.tokensAfter === 'number' ? result.tokensAfter : undefined,
  };
  return {
    id: markerId,
    sessionId,
    role: 'assistant',
    content: typeof result.summary === 'string' ? [{ type: 'text', text: result.summary }] : [],
    createdAt: at ?? '',
    metadata: {
      origin: { kind: 'compaction_summary' },
      [COMPACTION_MARKER_METADATA_KEY]: marker,
    },
  };
}

/** A cron.fired marker carries the fired job's origin and prompt — synthesize
 *  the same user message the live path delivers so messagesToTurns renders it
 *  as a cron card (buildCronTurn keys off metadata.origin.kind). */
function cronFiredMessage(
  payload: unknown,
  at: string | undefined,
  sessionId: string,
  markerId: string,
): AppMessage | undefined {
  const p = payload as { origin?: unknown; prompt?: unknown } | undefined;
  const origin = p?.origin as { kind?: unknown } | undefined;
  if (origin?.kind !== 'cron_job' || typeof p?.prompt !== 'string') return undefined;
  return {
    id: markerId,
    sessionId,
    role: 'user',
    content: [{ type: 'text', text: p.prompt }],
    createdAt: at ?? '',
    metadata: { origin },
  };
}

/** The trigger of the compaction run a completed marker belongs to: the
 *  nearest preceding started marker's payload (`manual` when the user ran
 *  /compact), defaulting to auto. */
function compactionTriggerBefore(
  items: AgentTranscriptSnapshot['items'],
  beforeIndex: number,
): 'manual' | 'auto' {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== 'marker' || item.marker !== 'compaction') continue;
    const p = item.payload as { phase?: unknown; trigger?: unknown } | undefined;
    if (p?.phase === 'started') {
      return p.trigger === 'manual' ? 'manual' : 'auto';
    }
  }
  return 'auto';
}

export function interactionToApproval(
  interaction: TranscriptInteraction,
  sessionId: string,
): AppApprovalRequest | undefined {
  // Only a PENDING interaction becomes an approval block — a resolved one is
  // already reflected in the tool's outcome.
  if (interaction.interactionKind !== 'approval' || interaction.state !== 'pending') {
    return undefined;
  }
  const request = (interaction.request ?? {}) as Record<string, unknown>;
  if (typeof request['toolName'] !== 'string' || typeof request['action'] !== 'string') {
    return undefined;
  }
  const toolCallId =
    typeof interaction.toolCallId === 'string'
      ? interaction.toolCallId
      : typeof request['toolCallId'] === 'string'
        ? request['toolCallId']
        : undefined;
  if (toolCallId === undefined) return undefined;
  return {
    approvalId: interaction.interactionId,
    sessionId,
    turnId: typeof request['turnId'] === 'number' ? request['turnId'] : undefined,
    toolCallId,
    toolName: request['toolName'],
    action: request['action'],
    display: request['display'],
    // The interaction entity carries neither an expiry nor a stamp today —
    // the resolved card doesn't render either. (Live expiry countdowns stay
    // on the interaction slice, not the turn.)
    expiresAt: '',
    createdAt: '',
  };
}

/** The pending question card for a question interaction — the dock's
 *  QuestionCard reads these; a resolved one is already reflected in the
 *  tool's outcome. The interaction entity carries no stamp today. */
export function interactionToQuestion(
  interaction: TranscriptInteraction,
  sessionId: string,
): AppQuestionRequest | undefined {
  if (interaction.interactionKind !== 'question' || interaction.state !== 'pending') {
    return undefined;
  }
  const request = (interaction.request ?? {}) as Record<string, unknown>;
  if (!Array.isArray(request['questions'])) return undefined;
  const toolCallId =
    typeof interaction.toolCallId === 'string'
      ? interaction.toolCallId
      : typeof request['toolCallId'] === 'string'
        ? request['toolCallId']
        : undefined;
  return {
    questionId: interaction.interactionId,
    sessionId,
    turnId: typeof request['turnId'] === 'number' ? request['turnId'] : undefined,
    toolCallId,
    questions: request['questions'] as AppQuestionRequest['questions'],
    createdAt: '',
  };
}

function clearMissingTimestamps(turn: ChatTurn): ChatTurn {
  if (turn.createdAt !== '' && turn.endedAt !== '') return turn;
  const next = { ...turn };
  if (next.createdAt === '') delete next.createdAt;
  if (next.endedAt === '') delete next.endedAt;
  return next;
}
