import { userCancellationReason } from '#/_base/utils/abort';
import type { IDisposable } from '#/_base/di/lifecycle';
import { newMessageId } from '#/actor/contextMemory/messageId';
import type { ContextMessage } from '#/actor/contextMemory/types';
import { getLoopControl } from '#/actor/loop/internal/access';
import type { Turn } from '#/actor/loop/internal/loop';
import { AgentTools } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import { IEventService } from '#/app/event/event';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import type {
  PromptAdmissionReservation,
  PromptBeforeSubmitHook,
  PromptHandle,
  PromptInput,
  PromptQueueSnapshot,
  PromptSubmitInput,
  PromptSubmitResult,
} from '../prompt';
import { promptMetadataTextFromContentParts } from '../promptMetadataText';
import { PromptAccepted } from '../promptOps';
import {
  contextMemoryOf,
  extractCompressionCaptions,
  hostOf,
  injectMessage,
  materializeDaemonRefs,
  steerRequestFor,
  type PromptRuntimeContext,
} from './promptIntake';
import {
  machineContextOf,
  type PromptAbortEvent,
  type PromptEnqueueEvent,
  type PromptSteerBeginEvent,
  type PromptSteerSettleEvent,
  type RemovedPromptEntry,
} from './promptMachine';
import {
  createPromptRecord,
  mergeSteerMessages,
  snapshotOf,
  stripBundledSkillBlocks,
  submitResultOf,
  userMessageForOrigin,
} from './promptRecord';
import { RetryStepRequest } from './promptStepRequests';

function reserveAdmissionId(runtime: PromptRuntimeContext, promptId: string | undefined): string {
  if (promptId !== undefined && promptId.length === 0) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_id must not be empty');
  }
  const accepted = runtime.getState();
  let id = promptId ?? newMessageId();
  while (accepted.has(id) || machineContextOf(runtime).reserved.has(id)) {
    if (promptId !== undefined) {
      throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${id}' is already in use`);
    }
    id = newMessageId();
  }
  runtime.send({ type: 'prompt.reserve', id });
  return id;
}

async function dispatchAccepted(
  runtime: PromptRuntimeContext,
  id: string,
  message: ContextMessage,
): Promise<void> {
  runtime.send({ type: 'prompt.release', id });
  await runtime.dispatch(
    new PromptAccepted({
      agentId: runtime.agent.agentId,
      promptId: id,
      content: stripBundledSkillBlocks(message),
    }),
  );
}

export function reserveAdmission(
  runtime: PromptRuntimeContext,
  promptId: string | undefined,
): PromptAdmissionReservation {
  const id = reserveAdmissionId(runtime, promptId);
  return {
    id,
    dispose: () => {
      runtime.send({ type: 'prompt.release', id });
    },
  };
}

async function updatePromptMetadata(
  runtime: PromptRuntimeContext,
  text: string | undefined,
): Promise<void> {
  if (runtime.agent.agentId !== MAIN_AGENT_ID) return;
  await applyPromptMetadataUpdate(
    {
      metadata: runtime.get(ISessionMetadata),
      eventService: runtime.get(IEventService),
      sessionId: runtime.get(ISessionContext).sessionId,
    },
    text,
  );
}

export async function submitPrompt(
  runtime: PromptRuntimeContext,
  input: PromptSubmitInput,
): Promise<PromptSubmitResult> {
  if (input.admission === 'currentTurn') return submitSteer(runtime, input);
  const promptId = reserveAdmissionId(runtime, input.promptId);
  let accepted = false;
  try {
    if (input.disabledTools !== undefined) {
      try {
        await runtime
          .get(IAgentLifecycleService)
          .resolve(runtime.agent, AgentTools)
          .setSessionDisabledTools(input.disabledTools);
      } catch (error) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    await updatePromptMetadata(runtime, promptMetadataTextFromContentParts(input.content));
    const message = userMessageForOrigin(input.content, input.origin);
    await dispatchAccepted(runtime, promptId, message);
    accepted = true;
    const handle = await enqueuePrompt(runtime, { id: promptId, message });
    if (handle.state === 'pending') {
      return { promptId: handle.id, createdAt: handle.createdAt, state: 'queued' };
    }
    const turn = await handle.launched;
    return submitResultOf(handle, turn);
  } finally {
    if (!accepted) runtime.send({ type: 'prompt.release', id: promptId });
  }
}

async function submitSteer(
  runtime: PromptRuntimeContext,
  input: PromptSubmitInput,
): Promise<PromptSubmitResult> {
  hostOf(runtime).telemetry.track2('input_steer', { parts: input.content.length });
  await updatePromptMetadata(runtime, promptMetadataTextFromContentParts(input.content));
  const queued = await enqueuePrompt(runtime, {
    message: {
      role: 'user',
      content: [...input.content],
      toolCalls: [],
    },
  });
  if (queued.state !== 'pending') {
    const turn = await queued.launched;
    return submitResultOf(queued, turn);
  }
  try {
    const [steered] = await steerPrompts(runtime, [queued.id]);
    if (steered === undefined) {
      return { promptId: queued.id, createdAt: queued.createdAt, state: 'queued' };
    }
    const turn = await steered.launched;
    return submitResultOf(steered, turn);
  } catch (error) {
    if (isError2(error) && error.code === ErrorCodes.PROMPT_NOT_FOUND) {
      return { promptId: queued.id, createdAt: queued.createdAt, state: 'queued' };
    }
    throw error;
  }
}

export async function submitMessage(
  runtime: PromptRuntimeContext,
  message: ContextMessage,
): Promise<PromptHandle> {
  const id = reserveAdmissionId(runtime, message.id);
  let accepted = false;
  try {
    await dispatchAccepted(runtime, id, message);
    accepted = true;
    return await enqueuePrompt(runtime, { id, message });
  } finally {
    if (!accepted) runtime.send({ type: 'prompt.release', id });
  }
}

export async function enqueuePrompt(
  runtime: PromptRuntimeContext,
  input: PromptInput,
): Promise<PromptHandle> {
  const id = input.id ?? input.message.id ?? newMessageId();
  const record = createPromptRecord(id, { ...input.message, id });
  const reply: PromptEnqueueEvent['reply'] = { wait: false };
  runtime.send({ type: 'prompt.enqueue', record, reply } satisfies PromptEnqueueEvent);
  if (reply.wait) {
    await Promise.race([record.launchedDeferred.promise, record.completionDeferred.promise]);
  }
  return record.handle;
}

export function listPrompts(runtime: PromptRuntimeContext): PromptQueueSnapshot {
  const machine = machineContextOf(runtime);
  return {
    active: machine.active === undefined ? undefined : snapshotOf(machine.active),
    pending: machine.pending.map(snapshotOf),
  };
}

export async function steerPrompts(
  runtime: PromptRuntimeContext,
  promptIds: readonly string[],
): Promise<readonly PromptHandle[]> {
  if (promptIds.length === 0) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_ids must not be empty');
  }
  const machine = machineContextOf(runtime);
  const active = machine.active;
  if (active === undefined) {
    throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active prompt to steer into');
  }
  const ids = new Set(promptIds);
  if (
    ids.size !== promptIds.length ||
    machine.pending.filter((item) => ids.has(item.id)).length !== ids.size
  ) {
    throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
  }
  const selected = machine.pending.filter((item) => ids.has(item.id));
  const { message: rerouted, captions } = extractCompressionCaptions(mergeSteerMessages(selected));
  await materializeDaemonRefs(runtime, rerouted);
  const begin: PromptSteerBeginEvent['reply'] = { ok: false, removed: [] };
  runtime.send({
    type: 'prompt.steerBegin',
    records: selected,
    activeId: active.id,
    reply: begin,
  } satisfies PromptSteerBeginEvent);
  if (!begin.ok) {
    throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are no longer pending');
  }
  const removed: readonly RemovedPromptEntry[] = begin.removed;
  let turn: Turn | undefined;
  try {
    turn = (await getLoopControl(runtime.agent).enqueue(steerRequestFor(runtime, rerouted, captions)).assigned).turn;
  } catch {
    turn = undefined;
  }
  const settle: PromptSteerSettleEvent['reply'] = { ok: false };
  runtime.send({
    type: 'prompt.steerSettle',
    removed,
    activeId: active.id,
    turn,
    reply: settle,
  } satisfies PromptSteerSettleEvent);
  if (!settle.ok) {
    throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active turn to steer into');
  }
  return selected.map((item) => item.handle);
}

export function abortPrompt(
  runtime: PromptRuntimeContext,
  promptId: string,
  reason: Error = userCancellationReason(),
): boolean {
  const reply: PromptAbortEvent['reply'] = { outcome: 'missing' };
  runtime.send({ type: 'prompt.abort', promptId, reason, reply } satisfies PromptAbortEvent);
  if (reply.outcome === 'missing') {
    throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${promptId} not found`);
  }
  return true;
}

export async function drainPrompts(
  runtime: PromptRuntimeContext,
  reason: Error = userCancellationReason(),
): Promise<void> {
  const machine = machineContextOf(runtime);
  for (const item of [...machine.pending]) abortPrompt(runtime, item.id, reason);
  const active = machineContextOf(runtime).active;
  if (active !== undefined) abortPrompt(runtime, active.id, reason);
}

export async function injectPrompt(
  runtime: PromptRuntimeContext,
  message: ContextMessage,
): Promise<Turn | undefined> {
  return injectMessage(runtime, message);
}

export async function retryPrompt(runtime: PromptRuntimeContext): Promise<Turn | undefined> {
  return (await getLoopControl(runtime.agent).enqueue(new RetryStepRequest()).assigned).turn;
}

export function clearPrompts(runtime: PromptRuntimeContext): void {
  const machine = machineContextOf(runtime);
  for (const item of [...machine.pending]) abortPrompt(runtime, item.id);
  const active = machineContextOf(runtime).active;
  if (active !== undefined) abortPrompt(runtime, active.id);
  void contextMemoryOf(runtime).clear();
}

export function registerBeforeSubmitHook(
  runtime: PromptRuntimeContext,
  name: string,
  hook: PromptBeforeSubmitHook,
): IDisposable {
  return machineContextOf(runtime).hooks.onBeforeSubmitPrompt.register(name, hook);
}
