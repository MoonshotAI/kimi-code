import { assign, emit, enqueueActions, fromCallback, fromPromise, raise, setup } from 'xstate';

import type { HistoryMessage, ToolEntry } from '#/history/message';
import { toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmOutcome } from '#/llm/response';
import type { ToolExecutor } from '#/tool/index';
import type { AbortScope } from '#/utils/abort';
import type { LoopCommand, LoopInput, UnfinishedTurn } from '../contract/command';
import type { LoopEmitted, HookFailedEvent } from '../contract/emitted';
import type {
  HookLifecycleEvent,
  HookPoint,
  StepStartingEvent,
  ToolBatchStartingEvent,
  TurnStartingEvent,
} from '../contract/hook';
import type { QueuedItem } from '../contract/inbox';
import { CLOSED, CRASHED, type Cause, type StepOutcome } from '../contract/outcome';
import {
  hookFailedEvent,
  hookFailureEntry,
  hookFailureReports,
  runtimeFailure,
  type HookFailure,
  type HookFailureReport,
} from '../hook/failure';
import type { HookSource } from '../hook/registry';
import {
  runMessageAppending,
  runStepEnding,
  runStepStarting,
  runToolBatchStarting,
  runTurnStarting,
  type StepEndingInput,
  type StepEndingRun,
  type StepStartingRun,
  type ToolBatchStartingRun,
  type TurnStartingRun,
} from '../hook/run';
import { createToolMachine, type ToolSignal } from '../tool/machine';
import { abortedToolOutcome, blockedToolOutcome, completionEntry, failedToolOutcome } from '../tool/outcome';
import {
  abortReason,
  allSettled,
  assistantEntryOf,
  canContinue,
  cancel,
  decide,
  dequeueTurn,
  draftOutcome,
  drainPatch,
  hasTrigger,
  initialContext,
  isAborted,
  isResumable,
  newTurn,
  notifyPatch,
  releasePending,
  remindPatch,
  resumedTurn,
  runTurnPatch,
  settle,
  steer,
  stepOf,
  submitPatch,
  trailingCalls,
  turnOf,
  type LoopMachineContext,
  type AppendedItem,
  type TurnState,
} from './context';
import { createRequestActor, type LoopLlmRequester, type RequestActorEvent } from './request-actor';

export interface CreateLoopMachineOptions {
  readonly requester: () => LoopLlmRequester;
  readonly executor: ToolExecutor;
  readonly hooks: HookSource;
  readonly abortGraceMs?: number;
}

type LoopEvent =
  | LoopCommand
  | ToolSignal
  | RequestActorEvent
  | HookFailedEvent
  | { type: 'hook.changed'; event: HookLifecycleEvent }
  | { type: 'turn.abort_grace' }
  | { type: 'loop.close' }
  | { type: `xstate.error.actor.${string}`; error: unknown; actorId: string };

interface FailureEnqueue {
  (action: () => void): void;
  emit(event: LoopEmitted): void;
}

function settleUnfinished(
  context: LoopMachineContext,
  unfinished: UnfinishedTurn,
  outcome: StepOutcome,
): { events: LoopEmitted[]; messages: HistoryMessage[] } {
  const { turnId, step } = unfinished;
  const events: LoopEmitted[] = [];
  const entries: ToolEntry[] = [];
  for (const toolCall of trailingCalls(context.messages).unresolved) {
    const result = abortedToolOutcome(toolCall, CRASHED);
    entries.push(result.entry);
    events.push({ type: 'tool.ended', toolCallId: toolCall.id, outcome: result, detached: false });
    events.push({ type: 'message.appended', turnId, step, source: 'tool', entry: result.entry });
  }
  if (unfinished.stepUnfinished) events.push({ type: 'step.ended', turnId, step, outcome });
  return { events, messages: [...context.messages, ...entries] };
}

export function createLoopMachine({ requester, executor, hooks, abortGraceMs }: CreateLoopMachineOptions) {
  const suspendFailed = (failure: HookFailure) => {
    if (failure.paused && failure.hookId !== undefined) hooks.suspend(failure.hookId);
  };
  const reportHookFailures = (
    enqueue: FailureEnqueue,
    point: HookPoint,
    turn: TurnState,
    reports: readonly HookFailureReport[],
  ) => {
    for (const { failure, entry } of reports) {
      enqueue.emit(hookFailedEvent(point, turn.id, turn.step, failure));
      enqueue.emit({ type: 'prompt.notified', entry });
      enqueue(() => suspendFailed(failure));
    }
  };

  return setup({
    types: {
      input: {} as LoopInput,
      context: {} as LoopMachineContext,
      events: {} as LoopEvent,
      emitted: {} as LoopEmitted,
    },
    actors: {
      requestActor: createRequestActor(requester),
      toolActor: createToolMachine(executor, hooks),
      scopeGuard: fromCallback<LoopEvent, { scope: AbortScope }>(({ input }) => () => input.scope.abort()),
      turnStartingActor: fromPromise<TurnStartingRun, { event: TurnStartingEvent; signal: AbortSignal }>(
        ({ input }) => runTurnStarting(hooks, input.event, input.signal),
      ),
      appendingActor: fromPromise<
        AppendedItem[],
        { turnId: number; step: number; items: readonly QueuedItem[]; signal: AbortSignal }
      >(async ({ input }) => {
        const appended: AppendedItem[] = [];
        for (const item of input.items) {
          const run = await runMessageAppending(
            hooks,
            { turnId: input.turnId, step: input.step, item },
            input.signal,
          );
          appended.push({ source: item.kind, entry: run.entry, blocked: run.blocked });
          for (const failure of run.failures) {
            appended.push({ source: 'notify', entry: hookFailureEntry('message.appending', failure.error), failure });
          }
        }
        return appended;
      }),
      stepStartingActor: fromPromise<StepStartingRun, { event: StepStartingEvent; signal: AbortSignal }>(
        ({ input }) => runStepStarting(hooks, input.event, input.signal),
      ),
      toolBatchStartingActor: fromPromise<ToolBatchStartingRun, { event: ToolBatchStartingEvent; signal: AbortSignal }>(
        ({ input }) => runToolBatchStarting(hooks, input.event, input.signal),
      ),
      stepEndingActor: fromPromise<StepEndingRun, { event: StepEndingInput; signal: AbortSignal }>(({ input }) =>
        runStepEnding(hooks, input.event, input.signal),
      ),
    },
    guards: {
      aborted: ({ context }) => isAborted(context),
    },
    actions: {
      setContext: enqueueActions(({ event, enqueue }) => {
        if (event.type !== 'input.set_context') return;
        const { reply } = event;
        enqueue.assign({ messages: event.messages });
        const ack = { type: 'context.settled' as const, messages: event.messages, reason: event.reason };
        enqueue.emit(ack);
        if (reply !== undefined) enqueue(() => reply(ack));
      }),
      setSystemPrompt: enqueueActions(({ context, event, enqueue }) => {
        if (event.type !== 'input.set_system_prompt') return;
        const { reply } = event;
        enqueue.assign({ profile: { ...context.profile, systemPrompt: event.systemPrompt } });
        const ack = { type: 'system_prompt.settled' as const, systemPrompt: event.systemPrompt };
        enqueue.emit(ack);
        if (reply !== undefined) enqueue(() => reply(ack));
      }),
      setTools: enqueueActions(({ context, event, enqueue }) => {
        if (event.type !== 'input.set_tools') return;
        const { reply } = event;
        enqueue.assign({ profile: { ...context.profile, tools: [...event.tools] } });
        const ack = { type: 'tools.settled' as const, tools: [...event.tools] };
        enqueue.emit(ack);
        if (reply !== undefined) enqueue(() => reply(ack));
      }),
      turnStartingFailed: enqueueActions(({ context, enqueue }, params: { failures: readonly HookFailure[] }) => {
        const turn = turnOf(context);
        const reports = hookFailureReports('turn.starting', params.failures);
        if (reports.length === 0) return;
        enqueue.assign({
          turn: { ...turn, pending: [...turn.pending, ...reports.map(({ entry }) => ({ kind: 'notify' as const, entry }))] },
        });
        reportHookFailures(enqueue, 'turn.starting', turn, reports);
      }),
      appendItems: enqueueActions(({ context, enqueue }, params: { items: readonly AppendedItem[] }) => {
        const turn = turnOf(context);
        enqueue.assign({
          messages: [...context.messages, ...params.items.map((item) => item.entry)],
          turn: { ...turn, pending: [] },
        });
        for (const item of params.items) {
          if ('failure' in item) {
            reportHookFailures(enqueue, 'message.appending', turn, [{ failure: item.failure, entry: item.entry }]);
          }
          enqueue.emit({
            type: 'message.appended',
            turnId: turn.id,
            step: turn.step,
            source: item.source,
            entry: item.entry,
            ...('blocked' in item && item.blocked !== undefined ? { blocked: item.blocked } : {}),
          });
        }
      }),
      stepDecided: enqueueActions(({ context, enqueue }, params: StepEndingRun) => {
        const turn = turnOf(context);
        const groups = params.failures.map(({ point, failure }) => ({
          point,
          reports: hookFailureReports(point, [failure]),
        }));
        enqueue.assign({
          ...decide(context, params.outcome),
          ...notifyPatch(context, groups.flatMap(({ reports }) => reports.map(({ entry }) => entry))),
        });
        for (const { point, reports } of groups) reportHookFailures(enqueue, point, turn, reports);
      }),
      stepStartingSettled: enqueueActions(({ context, enqueue }, params: StepStartingRun) => {
        const turn = turnOf(context);
        const reports = hookFailureReports('step.starting', params.failures);
        enqueue.assign({
          ...(params.rewrittenBy === undefined ? {} : { messages: [...params.messages] }),
          ...notifyPatch(context, reports.map(({ entry }) => entry)),
        });
        if (params.rewrittenBy !== undefined) {
          enqueue.emit({ type: 'context.settled', messages: [...params.messages], reason: params.rewrittenBy });
        }
        reportHookFailures(enqueue, 'step.starting', turn, reports);
      }),
      stepStartingBlocked: enqueueActions(({ context, enqueue }, params: StepStartingRun) => {
        const turn = turnOf(context);
        const reports = hookFailureReports('step.starting', params.failures);
        enqueue.assign({
          ...decide(context, { type: 'blocked', at: 'step.starting', cause: params.blocked as Cause }),
          ...notifyPatch(context, reports.map(({ entry }) => entry)),
        });
        reportHookFailures(enqueue, 'step.starting', turn, reports);
      }),
      abortTurn: enqueueActions(({ context, enqueue }, params: { reason: unknown }) => {
        if (context.turn === undefined) return;
        const turn = context.turn;
        if (turn.outcome?.type === 'aborted') {
          enqueue.cancel('abortGrace');
          enqueue.raise({ type: 'turn.abort_grace' });
          return;
        }
        const outcome = { type: 'aborted' as const, reason: params.reason };
        enqueue(() => turn.scope.abort(params.reason));
        enqueue.assign({
          ...releasePending(context, outcome),
          step: context.step === undefined ? undefined : { ...context.step, outcome },
        });
        for (const slot of Object.values(context.tools)) {
          if (slot.turnId === turn.id && !slot.detached) {
            enqueue.sendTo(slot.ref, { type: 'tool.abort', reason: params.reason });
          }
        }
        enqueue.raise({ type: 'turn.abort_grace' }, { id: 'abortGrace', delay: 'abortGrace' });
      }),
      closeUnfinished: enqueueActions(({ context, enqueue }) => {
        const unfinished = context.unfinished;
        if (unfinished === undefined) return;
        const outcome = { type: 'aborted' as const, reason: CRASHED };
        const settled = settleUnfinished(context, unfinished, outcome);
        enqueue.assign({
          messages: settled.messages,
          unfinished: undefined,
          nextTurnId: Math.max(context.nextTurnId, unfinished.turnId + 1),
        });
        for (const event of settled.events) enqueue.emit(event);
        enqueue.emit({ type: 'turn.ended', turnId: unfinished.turnId, outcome });
      }),
      resumeUnfinished: enqueueActions(({ context, enqueue }) => {
        const unfinished = context.unfinished;
        if (unfinished === undefined) return;
        const settled = settleUnfinished(context, unfinished, { type: 'continue', cause: CRASHED });
        enqueue.assign({
          messages: settled.messages,
          unfinished: undefined,
          held: false,
          turn: resumedTurn(context, unfinished),
        });
        for (const event of settled.events) enqueue.emit(event);
      }),
      finishTurn: enqueueActions(({ context, enqueue }) => {
        enqueue.cancel('abortGrace');
        const turn = context.turn;
        const tools = { ...context.tools };
        for (const [key, slot] of Object.entries(tools)) {
          if (slot.turnId === turn?.id && !slot.detached) {
            enqueue.stopChild(slot.ref);
            delete tools[key];
          }
        }
        enqueue.assign({
          tools,
          turn: undefined,
          step: undefined,
          nextTurnId: turn === undefined ? context.nextTurnId : Math.max(context.nextTurnId, turn.id + 1),
        });
        enqueue(() => turn?.reply?.(turn.outcome ?? { type: 'aborted' }));
      }),
      recordLlm: enqueueActions(({ context, event, enqueue }) => {
        const turn = turnOf(context);
        const step = stepOf(context);
        const outcome: LlmOutcome =
          event.type === 'llm.ended' ? event.outcome : { type: 'aborted', message: null, reason: undefined };
        const entry = assistantEntryOf(outcome, step.model);
        const toolCalls = outcome.type === 'done' ? outcome.message.toolCalls : [];
        enqueue.assign({
          step: {
            ...step,
            llm: outcome,
            calls: toolCalls.map((toolCall, index) => ({ key: `${turn.id}:${turn.step}:${index}`, toolCall })),
          },
          messages: entry === undefined ? context.messages : [...context.messages, entry],
        });
        enqueue.emit({ type: 'llm.ended', outcome });
        if (entry !== undefined) {
          enqueue.emit({ type: 'message.appended', turnId: turn.id, step: turn.step, source: 'llm', entry });
        }
      }),
      settleBatchBlocked: enqueueActions(({ context, enqueue }, params: ToolBatchStartingRun) => {
        const turn = turnOf(context);
        const step = stepOf(context);
        const blocked = params.blocked as NonNullable<ToolBatchStartingRun['blocked']>;
        const settled = { ...step.settled };
        for (const { key, toolCall } of step.calls) {
          const outcome = blockedToolOutcome(toolCall, blocked.cause, blocked.result);
          settled[key] = outcome.entry;
          enqueue.emit({ type: 'tool.started', turnId: turn.id, step: turn.step, toolCall });
          enqueue.emit({ type: 'tool.ended', toolCallId: toolCall.id, outcome, detached: false });
        }
        const reports = hookFailureReports('tool.batch-starting', params.failures);
        enqueue.assign({
          step: { ...step, settled },
          ...notifyPatch(context, reports.map(({ entry }) => entry)),
        });
        reportHookFailures(enqueue, 'tool.batch-starting', turn, reports);
      }),
      toolBatchStartingFailed: enqueueActions(({ context, enqueue }, params: { failures: readonly HookFailure[] }) => {
        const turn = turnOf(context);
        const reports = hookFailureReports('tool.batch-starting', params.failures);
        if (reports.length === 0) return;
        enqueue.assign(notifyPatch(context, reports.map(({ entry }) => entry)));
        reportHookFailures(enqueue, 'tool.batch-starting', turn, reports);
      }),
      spawnTools: enqueueActions(({ context, enqueue }) => {
        const turn = turnOf(context);
        const step = stepOf(context);
        if (isAborted(context)) {
          const reason = abortReason(context);
          const settled = { ...step.settled };
          for (const { key, toolCall } of step.calls) {
            const outcome = abortedToolOutcome(toolCall, reason);
            settled[key] = outcome.entry;
            enqueue.emit({ type: 'tool.started', turnId: turn.id, step: turn.step, toolCall });
            enqueue.emit({ type: 'tool.ended', toolCallId: toolCall.id, outcome, detached: false });
          }
          enqueue.assign({ step: { ...step, settled } });
          return;
        }
        enqueue.assign({
          tools: ({ context: current, spawn }) => {
            const tools = { ...current.tools };
            for (const { key, toolCall } of step.calls) {
              if (step.settled[key] !== undefined) continue;
              tools[key] = {
                toolCall,
                turnId: turn.id,
                detached: false,
                ref: spawn('toolActor', {
                  id: key,
                  input: { key, toolCall, turnId: turn.id, step: turn.step, signal: current.scope.signal },
                }),
              };
            }
            return tools;
          },
        });
      }),
      expireTools: enqueueActions(({ context, enqueue }) => {
        const step = stepOf(context);
        const reason = abortReason(context);
        const settled = { ...step.settled };
        const tools = { ...context.tools };
        for (const { key, toolCall } of step.calls) {
          if (settled[key] !== undefined) continue;
          const slot = tools[key];
          if (slot !== undefined) {
            enqueue.stopChild(slot.ref);
            delete tools[key];
          }
          const outcome = abortedToolOutcome(toolCall, reason);
          settled[key] = outcome.entry;
          enqueue.emit({ type: 'tool.ended', toolCallId: toolCall.id, outcome, detached: false });
        }
        enqueue.assign({ tools, step: { ...step, settled } });
      }),
      appendToolEntries: enqueueActions(({ context, enqueue }) => {
        const turn = turnOf(context);
        const step = stepOf(context);
        const entries = step.calls.flatMap((call) => step.settled[call.key] ?? []);
        enqueue.assign({ messages: [...context.messages, ...entries] });
        for (const entry of entries) {
          enqueue.emit({ type: 'message.appended', turnId: turn.id, step: turn.step, source: 'tool', entry });
        }
      }),
    },
    delays: {
      abortGrace: abortGraceMs ?? 2_500,
    },
  }).createMachine({
    id: 'loop',
    initial: 'idle',
    context: ({ input }) => initialContext(input),
    invoke: {
      src: 'scopeGuard',
      input: ({ context }) => ({ scope: context.scope }),
    },
    on: {
      'input.run_turn': {
        actions: ({ event }) => event.reply(),
      },
      'input.submit': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          const { reply } = event;
          enqueue.assign(submitPatch(context, event.entry));
          const ack = { type: 'prompt.submitted' as const, entry: event.entry };
          enqueue.emit(ack);
          if (reply !== undefined) enqueue(() => reply(ack));
        }),
      },
      'input.notify': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          const { reply } = event;
          enqueue.assign(notifyPatch(context, [event.entry]));
          const ack = { type: 'prompt.notified' as const, entry: event.entry };
          enqueue.emit(ack);
          if (reply !== undefined) enqueue(() => reply(ack));
        }),
      },
      'input.remind': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          const { reply } = event;
          enqueue.assign(remindPatch(context, event.entry));
          const ack = { type: 'prompt.reminded' as const, entry: event.entry };
          enqueue.emit(ack);
          if (reply !== undefined) enqueue(() => reply(ack));
        }),
      },
      'input.steer': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          const { reply } = event;
          const { promptIds, entry, patch } = steer(context, event.promptIds);
          enqueue.assign(patch);
          const ack = { type: 'prompt.steered' as const, promptIds, ...(entry === undefined ? {} : { entry }) };
          enqueue.emit(ack);
          if (reply !== undefined) enqueue(() => reply(ack));
        }),
      },
      'input.cancel': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          const { reply } = event;
          const { canceled, patch } = cancel(context, event.promptId);
          enqueue.assign(patch);
          const ack = { type: 'prompt.canceled' as const, promptId: event.promptId, canceled };
          enqueue.emit(ack);
          if (reply !== undefined) enqueue(() => reply(ack));
        }),
      },
      'input.abort_tool': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          for (const slot of Object.values(context.tools)) {
            if (slot.toolCall.id === event.toolCallId) {
              enqueue.sendTo(slot.ref, { type: 'tool.abort', reason: event.reason });
            }
          }
        }),
      },
      'input.detach_tool': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          for (const slot of Object.values(context.tools)) {
            if (slot.toolCall.id !== event.toolCallId || slot.detached) continue;
            enqueue.sendTo(slot.ref, {
              type: 'tool.detach',
              text: `moved to background by the user: ${slot.toolCall.name} (tool_call_id=${event.toolCallId})`,
            });
          }
        }),
      },
      'input.set_context': {
        actions: enqueueActions(({ event, enqueue }) => {
          const { reply } = event;
          const ack = { type: 'context.rejected' as const, messages: event.messages, reason: event.reason };
          enqueue.emit(ack);
          if (reply !== undefined) enqueue(() => reply(ack));
        }),
      },
      'input.set_system_prompt': {
        actions: enqueueActions(({ event, enqueue }) => {
          const { reply } = event;
          const ack = { type: 'system_prompt.rejected' as const, systemPrompt: event.systemPrompt };
          enqueue.emit(ack);
          if (reply !== undefined) enqueue(() => reply(ack));
        }),
      },
      'input.set_tools': {
        actions: enqueueActions(({ event, enqueue }) => {
          const { reply } = event;
          const ack = { type: 'tools.rejected' as const, tools: [...event.tools] };
          enqueue.emit(ack);
          if (reply !== undefined) enqueue(() => reply(ack));
        }),
      },
      'hook.failed': {
        actions: [
          emit(({ event }) => event),
          ({ event }) => {
            suspendFailed({ hookId: event.hookId, error: event.error, paused: event.paused, blocking: false });
          },
        ],
      },
      'hook.changed': {
        actions: emit(({ event }) => event.event),
      },
      'tool.started': {
        actions: emit(({ event }) => ({
          type: 'tool.started' as const,
          turnId: event.turnId,
          step: event.step,
          toolCall: event.toolCall,
        })),
      },
      'tool.delta': {
        actions: emit(({ event }) => ({
          type: 'tool.delta' as const,
          toolCallId: event.toolCallId,
          update: event.update,
        })),
      },
      'tool.ended': {
        actions: [
          assign(({ context, event }) => {
            const tools = { ...context.tools };
            const slot = tools[event.key];
            if (slot !== undefined) {
              if (event.detached) tools[event.key] = { ...slot, detached: true };
              else delete tools[event.key];
            }
            return { tools, step: settle(context.step, event.key, event.outcome) };
          }),
          emit(({ event }) => ({
            type: 'tool.ended' as const,
            toolCallId: event.toolCallId,
            outcome: event.outcome,
            detached: event.detached,
          })),
        ],
      },
      'tool.async_ended': {
        actions: [
          assign(({ context, event }) => {
            const tools = { ...context.tools };
            delete tools[event.key];
            return { tools };
          }),
          emit(({ event }) => ({
            type: 'tool.async_ended' as const,
            toolCallId: event.toolCallId,
            outcome: event.outcome,
            entry: event.entry,
          })),
          raise(({ event }) => ({ type: 'input.notify' as const, entry: event.entry })),
        ],
      },
      'xstate.error.actor.*': [
        {
          guard: ({ context, event }) => context.tools[event.actorId] !== undefined,
          actions: enqueueActions(({ context, event, enqueue }) => {
            const slot = context.tools[event.actorId];
            if (slot === undefined) return;
            const tools = { ...context.tools };
            delete tools[event.actorId];
            if (slot.detached) {
              const outcome = { type: 'failed' as const, error: event.error };
              const entry = completionEntry(slot.toolCall, outcome);
              enqueue.assign({ tools });
              enqueue.emit({ type: 'tool.async_ended', toolCallId: slot.toolCall.id, outcome, entry });
              enqueue.raise({ type: 'input.notify', entry });
              return;
            }
            const outcome = failedToolOutcome(slot.toolCall, event.error);
            enqueue.assign({ tools, step: settle(context.step, event.actorId, outcome) });
            enqueue.emit({ type: 'tool.ended', toolCallId: slot.toolCall.id, outcome, detached: false });
          }),
        },
        {},
      ],
      'input.close': {
        target: '.closed',
      },
      'loop.close': {
        target: '.closed',
      },
    },
    states: {
      idle: {
        always: [
          { guard: ({ context }) => context.unfinished !== undefined, target: 'interrupted' },
          {
            guard: ({ context }) => !context.held && hasTrigger(context),
            target: 'running',
            actions: assign(({ context }) => dequeueTurn(context)),
          },
        ],
        on: {
          'input.run_turn': {
            target: 'running',
            actions: [
              emit(({ event }) => ({ type: 'prompt.submitted' as const, entry: event.entry })),
              assign(({ context, event }) => runTurnPatch(context, event.entry, event.reply)),
            ],
          },
          'input.continue': [
            {
              guard: ({ context }) => !hasTrigger(context) && canContinue(context.messages),
              target: 'running',
              actions: assign(({ context }) => ({ held: false, turn: newTurn(context, 'continue', []) })),
            },
            { actions: assign({ held: false }) },
          ],
          'input.set_context': { actions: 'setContext' },
          'input.set_system_prompt': { actions: 'setSystemPrompt' },
          'input.set_tools': { actions: 'setTools' },
        },
      },
      interrupted: {
        always: {
          guard: ({ context }) => !context.held,
          target: 'idle',
          actions: 'closeUnfinished',
        },
        on: {
          'input.run_turn': {
            target: 'idle',
            actions: ['closeUnfinished', raise(({ event }) => event)],
          },
          'input.continue': [
            {
              guard: ({ context }) => isResumable(context),
              target: '#loop.running.turn.draining',
              actions: 'resumeUnfinished',
            },
            {
              target: 'idle',
              actions: ['closeUnfinished', raise({ type: 'input.continue' })],
            },
          ],
          'input.abort_turn': {
            target: 'idle',
            actions: 'closeUnfinished',
          },
        },
      },
      running: {
        initial: 'starting',
        exit: 'finishTurn',
        on: {
          'input.abort_turn': {
            actions: { type: 'abortTurn', params: ({ event }) => ({ reason: event.reason }) },
          },
          'input.close': {
            actions: [
              { type: 'abortTurn', params: { reason: CLOSED } },
              raise({ type: 'turn.abort_grace' }),
              raise({ type: 'loop.close' }),
            ],
          },
        },
        states: {
          starting: {
            invoke: {
              src: 'turnStartingActor',
              input: ({ context }) => {
                const turn = turnOf(context);
                return {
                  event: { turnId: turn.id, trigger: turn.trigger, pending: turn.pending },
                  signal: turn.scope.signal,
                };
              },
              onDone: [
                {
                  guard: ({ event }) => event.output.blocked !== undefined,
                  target: 'turn.finished',
                  actions: [
                    { type: 'turnStartingFailed', params: ({ event }) => ({ failures: event.output.failures }) },
                    assign(({ context, event }) =>
                      releasePending(context, {
                        type: 'blocked',
                        at: 'turn.starting',
                        cause: event.output.blocked as Cause,
                      }),
                    ),
                  ],
                },
                {
                  target: 'turn',
                  actions: {
                    type: 'turnStartingFailed',
                    params: ({ event }) => ({ failures: event.output.failures }),
                  },
                },
              ],
              onError: {
                target: 'turn',
                actions: {
                  type: 'turnStartingFailed',
                  params: ({ event }) => ({ failures: [runtimeFailure(event.error)] }),
                },
              },
            },
            always: {
              guard: 'aborted',
              target: 'turn.finished',
            },
          },
          turn: {
            initial: 'appending',
            entry: emit(({ context }) => {
              const turn = turnOf(context);
              return turn.resumed === true
                ? { type: 'turn.resumed' as const, turnId: turn.id, step: turn.step }
                : { type: 'turn.started' as const, turnId: turn.id, trigger: turn.trigger };
            }),
            exit: emit(({ context }) => ({
              type: 'turn.ended' as const,
              turnId: turnOf(context).id,
              outcome: context.turn?.outcome ?? { type: 'aborted' as const },
            })),
            states: {
              appending: {
                invoke: {
                  src: 'appendingActor',
                  input: ({ context }) => {
                    const turn = turnOf(context);
                    return { turnId: turn.id, step: turn.step, items: turn.pending, signal: turn.scope.signal };
                  },
                  onDone: {
                    target: 'step',
                    actions: { type: 'appendItems', params: ({ event }) => ({ items: event.output }) },
                  },
                  onError: {
                    target: 'step',
                    actions: {
                      type: 'appendItems',
                      params: ({ context, event }) => ({
                        items: [
                          ...turnOf(context).pending.map((item) => ({ source: item.kind, entry: item.entry })),
                          {
                            source: 'notify' as const,
                            entry: hookFailureEntry('message.appending', event.error),
                            failure: runtimeFailure(event.error),
                          },
                        ],
                      }),
                    },
                  },
                },
                always: {
                  guard: 'aborted',
                  target: 'finished',
                },
              },
              step: {
                initial: 'starting',
                entry: [
                  assign(({ context }) => ({
                    turn: { ...turnOf(context), step: turnOf(context).step + 1 },
                    step: { calls: [], settled: {} },
                  })),
                  emit(({ context }) => ({
                    type: 'step.started' as const,
                    turnId: turnOf(context).id,
                    step: turnOf(context).step,
                  })),
                ],
                exit: [
                  emit(({ context }) => ({
                    type: 'step.ended' as const,
                    turnId: turnOf(context).id,
                    step: turnOf(context).step,
                    outcome: context.step?.outcome ?? { type: 'aborted' as const },
                  })),
                  assign({ step: undefined }),
                ],
                states: {
                  starting: {
                    invoke: {
                      src: 'stepStartingActor',
                      input: ({ context }) => {
                        const turn = turnOf(context);
                        return {
                          event: {
                            turnId: turn.id,
                            step: turn.step,
                            messages: context.messages,
                            profile: context.profile,
                          },
                          signal: turn.scope.signal,
                        };
                      },
                      onDone: [
                        {
                          guard: ({ event }) => event.output.blocked !== undefined,
                          target: 'decided',
                          actions: { type: 'stepStartingBlocked', params: ({ event }) => event.output },
                        },
                        {
                          target: 'requesting',
                          actions: { type: 'stepStartingSettled', params: ({ event }) => event.output },
                        },
                      ],
                      onError: {
                        target: 'requesting',
                        actions: {
                          type: 'stepStartingSettled',
                          params: ({ context, event }) => ({
                            messages: context.messages,
                            failures: [runtimeFailure(event.error)],
                          }),
                        },
                      },
                    },
                    always: {
                      guard: 'aborted',
                      target: 'decided',
                    },
                  },
                  requesting: {
                    invoke: {
                      src: 'requestActor',
                      input: ({ context }) => ({
                        profile: context.profile,
                        messages: context.messages,
                        signal: turnOf(context).scope.signal,
                      }),
                      onError: {
                        target: 'ending',
                        actions: enqueueActions(({ context, event, enqueue }) => {
                          const outcome: LlmOutcome = {
                            type: 'failed',
                            error: toLlmErrorMessage(event.error),
                            rawError: event.error,
                          };
                          enqueue.assign({ step: { ...stepOf(context), llm: outcome } });
                          enqueue.emit({ type: 'llm.ended', outcome });
                        }),
                      },
                    },
                    on: {
                      'llm.prepared': {
                        actions: assign(({ context, event }) => ({ step: { ...stepOf(context), model: event.model } })),
                      },
                      'llm.started': { actions: emit(({ event }) => event) },
                      'llm.notice': { actions: emit(({ event }) => event) },
                      'llm.streaming.*': { actions: emit(({ event }) => event) },
                      'llm.retrying': { actions: emit(({ event }) => event) },
                      'llm.ended': [
                        {
                          guard: ({ event }) =>
                            event.outcome.type === 'done' && event.outcome.message.toolCalls.length > 0,
                          target: 'batching',
                          actions: 'recordLlm',
                        },
                        { guard: 'aborted', target: 'decided', actions: 'recordLlm' },
                        { target: 'ending', actions: 'recordLlm' },
                      ],
                      'turn.abort_grace': {
                        target: 'decided',
                        actions: 'recordLlm',
                      },
                    },
                  },
                  batching: {
                    invoke: {
                      src: 'toolBatchStartingActor',
                      input: ({ context }) => {
                        const turn = turnOf(context);
                        return {
                          event: {
                            turnId: turn.id,
                            step: turn.step,
                            toolCalls: stepOf(context).calls.map((call) => call.toolCall),
                          },
                          signal: turn.scope.signal,
                        };
                      },
                      onDone: [
                        {
                          guard: ({ event }) => event.output.blocked !== undefined,
                          target: 'acting',
                          actions: { type: 'settleBatchBlocked', params: ({ event }) => event.output },
                        },
                        {
                          target: 'acting',
                          actions: {
                            type: 'toolBatchStartingFailed',
                            params: ({ event }) => ({ failures: event.output.failures }),
                          },
                        },
                      ],
                      onError: {
                        target: 'acting',
                        actions: {
                          type: 'toolBatchStartingFailed',
                          params: ({ event }) => ({ failures: [runtimeFailure(event.error)] }),
                        },
                      },
                    },
                    always: {
                      guard: 'aborted',
                      target: 'acting',
                    },
                  },
                  acting: {
                    entry: 'spawnTools',
                    always: [
                      {
                        guard: ({ context }) => allSettled(context.step) && isAborted(context),
                        target: 'decided',
                        actions: 'appendToolEntries',
                      },
                      {
                        guard: ({ context }) => allSettled(context.step),
                        target: 'ending',
                        actions: 'appendToolEntries',
                      },
                    ],
                    on: {
                      'turn.abort_grace': {
                        actions: 'expireTools',
                      },
                    },
                  },
                  ending: {
                    invoke: {
                      src: 'stepEndingActor',
                      input: ({ context }) => {
                        const turn = turnOf(context);
                        return {
                          event: {
                            turnId: turn.id,
                            step: turn.step,
                            draft: draftOutcome(stepOf(context)),
                            messages: context.messages,
                          },
                          signal: turn.scope.signal,
                        };
                      },
                      onDone: {
                        target: 'decided',
                        actions: { type: 'stepDecided', params: ({ event }) => event.output },
                      },
                      onError: {
                        target: 'decided',
                        actions: {
                          type: 'stepDecided',
                          params: ({ context, event }) => {
                            const outcome = draftOutcome(stepOf(context));
                            const point = outcome.type === 'continue' ? 'step.continuing' : 'step.stopping';
                            return { outcome, failures: [{ point, failure: runtimeFailure(event.error) }] };
                          },
                        },
                      },
                    },
                    always: {
                      guard: 'aborted',
                      target: 'decided',
                    },
                    on: {
                      'input.set_context': { actions: 'setContext' },
                      'input.set_system_prompt': { actions: 'setSystemPrompt' },
                      'input.set_tools': { actions: 'setTools' },
                    },
                  },
                  decided: {
                    always: [
                      {
                        guard: ({ context }) => context.step?.outcome?.type === 'continue',
                        target: '#loop.running.turn.draining',
                      },
                      { target: '#loop.running.turn.finished' },
                    ],
                  },
                },
              },
              draining: {
                entry: assign(({ context }) => drainPatch(context)),
                always: [
                  { guard: ({ context }) => (context.turn?.pending.length ?? 0) > 0, target: 'appending' },
                  { target: 'step' },
                ],
              },
              finished: {
                always: '#loop.idle',
              },
            },
          },
        },
      },
      closed: {
        type: 'final',
        entry: enqueueActions(({ context, enqueue }) => {
          for (const slot of Object.values(context.tools)) {
            if (!slot.detached) continue;
            const outcome = { type: 'aborted' as const, reason: CLOSED };
            enqueue.stopChild(slot.ref);
            enqueue.emit({
              type: 'tool.async_ended',
              toolCallId: slot.toolCall.id,
              outcome,
              entry: completionEntry(slot.toolCall, outcome),
            });
          }
          enqueue.assign({ tools: {} });
          enqueue(() => context.scope.abort());
        }),
      },
    },
  });
}
