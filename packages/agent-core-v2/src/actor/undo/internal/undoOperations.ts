import type { IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { AgentContextMemory, type ContextMemoryRuntime } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import {
  computeUndoCut,
  formatUndoUnavailableMessage,
  precheckUndo,
} from '#/actor/contextMemory/contextOps';
import { isUndoAnchor } from '#/actor/contextMemory/conversationTime';
import { AgentFullCompaction } from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import { AgentPrompt } from '#/actor/prompt/promptAgentRuntime';
import { promptMetadataTextFromContentParts } from '#/actor/prompt/promptMetadataText';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import { getLoopControl } from '#/actor/loop/internal/access';
import { IAgentHostService, type AgentHost } from '#/agent/host/agentHost';
import { IEventService } from '#/app/event/event';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';
import { keepsUndoCheckpoints } from '#/state/state';

import type { UndoAvailability, UndoResult } from '../undoAgentRuntime';
import { ContextUndone } from '../undoEvents';

import type { UndoActorContext } from './undoMachine';

type UndoRuntimeContext = AgentRuntimeContext<null>;

function hostOf(runtime: UndoRuntimeContext): AgentHost {
  return runtime.get(IAgentHostService).of(runtime.agent);
}

function contextMemoryOf(runtime: UndoRuntimeContext): ContextMemoryRuntime {
  return runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentContextMemory);
}

export function undoAvailability(runtime: UndoRuntimeContext): UndoAvailability {
  const cut = computeUndoCut(contextMemoryOf(runtime).get(), Number.MAX_SAFE_INTEGER);
  const maxTurns = Math.min(cut.removedCount, checkpointDepth(runtime).depth);
  return { canUndo: maxTurns > 0 };
}

export async function runUndo(runtime: UndoRuntimeContext, count: number): Promise<UndoResult> {
  let quiescence: IDisposable | undefined;
  try {
    quiescence = getLoopControl(runtime.agent).tryAcquireQuiescence();
    if (quiescence === undefined) {
      throw busyError('loop');
    }
    if (
      runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentFullCompaction).status() === 'running'
    ) {
      throw busyError('compaction');
    }
    assertUndoAvailable(runtime, count);
    void contextMemoryOf(runtime).undo(count);
    await flushAfterCommit(runtime, 'context cut');
    await reconcileParticipants(runtime);
    await flushAfterCommit(runtime, 'state reconciliation');
    await reconcileLastPromptSafely(runtime);
    hostOf(runtime).telemetry.track2('conversation_undo', { count });
    await runtime.dispatch(
      new ContextUndone({ agentId: runtime.agent.agentId, turns: count }),
    );
    return { applied: true };
  } finally {
    quiescence?.dispose();
  }
}

function checkpointDepth(runtime: UndoRuntimeContext): { depth: number; model: string } {
  const host = hostOf(runtime);
  let depth = Number.POSITIVE_INFINITY;
  let model = '';
  for (const key of host.state.replayableKeys()) {
    if (!keepsUndoCheckpoints(key)) continue;
    const stateDepth = host.dispatcher.checkpointDepth(key);
    if (stateDepth < depth) {
      depth = stateDepth;
      model = key.name;
    }
  }
  for (const entry of host.dispatcher.participantCheckpointDepths()) {
    if (entry.depth < depth) {
      depth = entry.depth;
      model = entry.id;
    }
  }
  return { depth, model };
}

function busyError(reason: 'loop' | 'compaction'): Error2 {
  const message = reason === 'loop'
    ? 'Cannot undo while a turn is active or queued. Wait for it to finish, then retry.'
    : 'Cannot undo while conversation compaction is running. Wait for it to finish, then retry.';
  return new Error2(ErrorCodes.SESSION_BUSY, message, { details: { reason } });
}

function assertUndoAvailable(runtime: UndoRuntimeContext, count: number): void {
  const check = precheckUndo(contextMemoryOf(runtime).get(), count);
  if (!check.ok) {
    throw new Error2(
      ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      formatUndoUnavailableMessage(check),
      {
        details: {
          reason: check.reason,
          requestedCount: check.requested,
          undoableCount: check.undoable,
        },
      },
    );
  }
  const { depth, model } = checkpointDepth(runtime);
  if (depth >= count) return;
  const fullCut = computeUndoCut(contextMemoryOf(runtime).get(), Number.MAX_SAFE_INTEGER);
  const reason = fullCut.stoppedAtCompaction ? 'compaction_boundary' : 'checkpoint_lost';
  throw new Error2(
    ErrorCodes.SESSION_UNDO_UNAVAILABLE,
    formatUndoUnavailableMessage({
      ok: false,
      reason,
      requested: count,
      undoable: depth,
    }),
    {
      details: {
        reason,
        requestedCount: count,
        undoableCount: depth,
        model,
      },
    },
  );
}

async function reconcileParticipants(runtime: UndoRuntimeContext): Promise<void> {
  const participants = [...runtime.getLogicState<UndoActorContext>().participants.values()];
  const results = await Promise.allSettled(
    participants.map((participant) => participant.reconcileAfterUndo()),
  );
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    runtime.get(ILogService).error('undo participant reconciliation failed', {
      participantId: participants[index]?.id,
      error: result.reason,
    });
  });
}

async function reconcileLastPromptSafely(runtime: UndoRuntimeContext): Promise<void> {
  try {
    await reconcileLastPrompt(runtime);
  } catch (error) {
    runtime.get(ILogService).error('undo lastPrompt reconciliation failed', { error });
  }
}

async function flushAfterCommit(runtime: UndoRuntimeContext, stage: string): Promise<void> {
  try {
    await hostOf(runtime).dispatcher.flush();
  } catch (error) {
    runtime.get(ILogService).error('undo wire flush failed after in-memory commit', { stage, error });
    throw error;
  }
}

async function reconcileLastPrompt(runtime: UndoRuntimeContext): Promise<void> {
  if (runtime.agent.agentId !== MAIN_AGENT_ID) return;
  const manager = runtime.get(IAgentLifecycleService);
  const pending = manager.resolve(runtime.agent, AgentPrompt).list().pending.at(-1);
  let lastPrompt = pending === undefined
    ? undefined
    : promptMetadataTextFromContentParts(pending.message.content);
  if (lastPrompt === undefined) {
    const history = contextMemoryOf(runtime).get();
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i]!;
      if (!isUndoAnchor(message)) continue;
      lastPrompt = promptMetadataTextFromContentParts(message.content);
      if (lastPrompt !== undefined) break;
    }
  }
  await runtime.get(ISessionMetadata).update({ lastPrompt });
  runtime.get(IEventService).publish(
    new SessionMetaUpdated({
      payload: {
        agentId: MAIN_AGENT_ID,
        sessionId: runtime.get(ISessionContext).sessionId,
        patch: { lastPrompt },
      },
    }),
  );
}
