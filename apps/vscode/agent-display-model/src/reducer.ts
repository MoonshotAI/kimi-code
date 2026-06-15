import type { DisplayEffect } from './effects';
import type { DisplayEvent } from './events';
import {
  createEmptyTokenUsage,
  type DisplayApprovalPart,
  type DisplayBlock,
  type DisplayMessage,
  type DisplayMessageStatus,
  type DisplayPart,
  type DisplayState,
  type DisplayStep,
  type DisplayTokenUsage,
  type DisplayToolCallPart,
} from './model';

export interface DisplayReduction {
  state: DisplayState;
  effects: DisplayEffect[];
}

interface MutableState {
  state: DisplayState;
  effects: DisplayEffect[];
}

function cloneState(state: DisplayState): DisplayState {
  return {
    ...state,
    messages: state.messages.map((message) => ({
      ...message,
      parts: message.parts.map(clonePart),
      steps: message.steps?.map(cloneStep),
    })),
    pendingApprovals: state.pendingApprovals.map(clonePart) as DisplayApprovalPart[],
    tokenUsage: { ...state.tokenUsage },
    activeTokenUsage: { ...state.activeTokenUsage },
    availableCommands: state.availableCommands.map((command) => ({ ...command })),
    plan: state.plan ? { entries: state.plan.entries.map((entry) => ({ ...entry })) } : null,
    status: state.status ? { ...state.status, tokenUsage: state.status.tokenUsage ? { ...state.status.tokenUsage } : state.status.tokenUsage } : null,
  };
}

function cloneStep(step: DisplayStep): DisplayStep {
  return { ...step, parts: step.parts.map(clonePart) };
}

function cloneDisplayBlock(block: DisplayBlock): DisplayBlock {
  if (block.type === 'todo') {
    return { ...block, items: block.items.map((item) => ({ ...item })) };
  }
  return { ...block };
}

function clonePart<T extends DisplayPart>(part: T): T {
  if (part.type === 'tool-call') {
    return {
      ...part,
      displayBlocks: part.displayBlocks?.map(cloneDisplayBlock),
      children: part.children?.map(cloneStep),
    } as T;
  }
  if (part.type === 'plan') {
    return { ...part, plan: { entries: part.plan.entries.map((entry) => ({ ...entry })) } } as T;
  }
  if (part.type === 'approval') {
    return {
      ...part,
      displayBlocks: part.displayBlocks?.map(cloneDisplayBlock),
      options: part.options?.map((option) => ({ ...option })),
    } as T;
  }
  if (part.type === 'error') {
    return { ...part, error: { ...part.error, details: part.error.details ? { ...part.error.details } : part.error.details } } as T;
  }
  if (part.type === 'media') {
    return { ...part } as T;
  }
  return { ...part };
}

function nextId(state: DisplayState, prefix: string): string {
  return `${prefix}-${state.messages.length + 1}`;
}

function ensureAssistant(ctx: MutableState): DisplayMessage {
  let message = ctx.state.messages.at(-1);
  if (!message || message.role !== 'assistant') {
    message = { id: nextId(ctx.state, 'assistant'), role: 'assistant', parts: [], steps: [], status: 'streaming' };
    ctx.state.messages.push(message);
  }
  return message;
}

function ensureCurrentStep(message: DisplayMessage, n = 1): DisplayStep {
  if (!message.steps) message.steps = [];
  let step = message.steps.at(-1);
  if (!step) {
    step = { id: `step-${message.steps.length + 1}`, n, parts: [] };
    message.steps.push(step);
  }
  return step;
}

function finishTextParts(parts: DisplayPart[]): void {
  for (const part of parts) {
    if ((part.type === 'text' || part.type === 'thinking') && part.finished !== true) {
      part.finished = true;
    }
    if (part.type === 'tool-call' && part.children) {
      for (const child of part.children) finishTextParts(child.parts);
    }
  }
}

function appendContent(ctx: MutableState, kind: 'text' | 'thinking', text: string): void {
  if (!text) return;
  const message = ensureAssistant(ctx);
  const step = ensureCurrentStep(message);
  if (kind === 'text') finishTextParts(step.parts.filter((part) => part.type === 'thinking'));
  const last = step.parts.at(-1);
  if (last?.type === kind && last.finished !== true) {
    if (kind === 'text') last.text += text;
    else last.text += text;
    return;
  }
  step.parts.push(kind === 'text' ? { type: 'text', text } : { type: 'thinking', text });
}

function appendMedia(ctx: MutableState, media: DisplayPart & { type: 'media' }): void {
  const message = ensureAssistant(ctx);
  currentStepParts(message).push({ ...media });
}

function addTokenUsage(target: DisplayTokenUsage, source: DisplayTokenUsage): void {
  target.inputOther += source.inputOther;
  target.output += source.output;
  target.inputCacheRead += source.inputCacheRead;
  target.inputCacheCreation += source.inputCacheCreation;
}

function findToolPart(parts: DisplayPart[], id: string): DisplayToolCallPart | null {
  for (const part of parts) {
    if (part.type === 'tool-call') {
      if (part.id === id) return part;
      if (part.children) {
        for (const child of part.children) {
          const found = findToolPart(child.parts, id);
          if (found) return found;
        }
      }
    }
  }
  return null;
}

function upsertToolCall(ctx: MutableState, id: string, name: string, argumentsText: string | null | undefined, status: 'pending' | 'running'): void {
  const message = ensureAssistant(ctx);
  const step = ensureCurrentStep(message);
  const existing = findToolPart(step.parts, id) ?? (message.steps ? findToolPart(message.steps.flatMap((item) => item.parts), id) : null);
  if (existing) {
    existing.name = name;
    if (argumentsText !== undefined) existing.argumentsText = argumentsText;
    existing.status = status;
    return;
  }
  finishTextParts(step.parts);
  step.parts.push({ type: 'tool-call', id, name, argumentsText: argumentsText ?? null, status });
}

function toolStatus(isError: boolean | undefined, status: DisplayToolCallPart['status'] = 'success'): DisplayToolCallPart['status'] {
  if (isError === true) return 'error';
  return status;
}

function extractPaths(displayBlocks?: DisplayBlock[]): string[] {
  return (displayBlocks ?? []).filter((block): block is Extract<DisplayBlock, { type: 'diff' }> => block.type === 'diff').map((block) => block.path);
}

function applyToolResult(
  ctx: MutableState,
  id: string,
  isError: boolean | undefined,
  output: string | undefined,
  messageText: string | undefined,
  displayBlocks: DisplayBlock[] | undefined,
): void {
  const message = ensureAssistant(ctx);
  const part = message.steps ? findToolPart(message.steps.flatMap((step) => step.parts), id) : null;
  if (!part) return;
  part.status = toolStatus(isError);
  part.resultText = output ?? messageText;
  part.displayBlocks = displayBlocks?.map(cloneDisplayBlock);
  const paths = extractPaths(displayBlocks);
  if (paths.length > 0) ctx.effects.push({ type: 'TrackFiles', paths });
}

function currentStepParts(message: DisplayMessage): DisplayPart[] {
  return ensureCurrentStep(message).parts;
}

function applyPlan(ctx: MutableState, plan: DisplayEvent & { type: 'plan.replace' }): void {
  const message = ensureAssistant(ctx);
  const step = ensureCurrentStep(message);
  ctx.state.plan = { entries: plan.plan.entries.map((entry) => ({ ...entry })) };
  const existing = step.parts.find((part): part is Extract<DisplayPart, { type: 'plan' }> => part.type === 'plan');
  if (existing) existing.plan = ctx.state.plan;
  else step.parts.push({ type: 'plan', plan: ctx.state.plan });
}

function applyStatus(ctx: MutableState, status: NonNullable<DisplayState['status']>): void {
  ctx.state.status = { ...status, tokenUsage: status.tokenUsage ? { ...status.tokenUsage } : status.tokenUsage };
  ctx.effects.push({ type: 'UpdateStatus', status: ctx.state.status });
  if (status.tokenUsage) {
    ctx.state.activeTokenUsage = {
      inputOther: status.tokenUsage.inputOther,
      output: status.tokenUsage.output,
      inputCacheRead: status.tokenUsage.inputCacheRead,
      inputCacheCreation: status.tokenUsage.inputCacheCreation,
    };
  }
  const message = ensureAssistant(ctx);
  const step = ensureCurrentStep(message);
  step.parts.push({ type: 'status', status: ctx.state.status });
}

function applySubagentEvent(ctx: MutableState, parentToolCallId: string, event: DisplayEvent): void {
  const message = ensureAssistant(ctx);
  const parent = message.steps ? findToolPart(message.steps.flatMap((step) => step.parts), parentToolCallId) : null;
  if (!parent) return;
  if (!parent.children) parent.children = [];
  const childState: DisplayState = {
    ...ctx.state,
    messages: [{ id: 'subagent', role: 'assistant', parts: [], steps: parent.children }],
    pendingApprovals: [],
  };
  const reduction = reduceDisplayEvent(childState, event);
  parent.children = reduction.state.messages[0]?.steps ?? [];
  if (event.type === 'approval.request') {
    const request = reduction.state.pendingApprovals[0];
    if (request) {
      ctx.state.pendingApprovals = [...ctx.state.pendingApprovals.filter((item) => item.requestId !== request.requestId), request];
    }
  } else if (event.type === 'approval.resolved') {
    ctx.state.pendingApprovals = ctx.state.pendingApprovals.filter((item) => item.requestId !== event.requestId);
  }
  ctx.effects.push(...reduction.effects);
}

function finalizeTurn(ctx: MutableState, status: DisplayMessageStatus): void {
  const message = ctx.state.messages.at(-1);
  if (message?.role === 'assistant') {
    message.status = status;
    if (message.steps) for (const step of message.steps) finishTextParts(step.parts);
  }
  finalizeTurnState(ctx);
}

function finalizeTurnState(ctx: MutableState): void {
  addTokenUsage(ctx.state.tokenUsage, ctx.state.activeTokenUsage);
  ctx.state.activeTokenUsage = createEmptyTokenUsage();
  ctx.state.isStreaming = false;
  ctx.state.isCompacting = false;
  ctx.state.pendingApprovals = [];
  ctx.effects.push({ type: 'ClearApprovals' });
}

function rollbackPreflightTurn(ctx: MutableState): void {
  const lastMessage = ctx.state.messages.at(-1);
  if (lastMessage?.role === 'assistant' && isEmptyAssistant(lastMessage)) {
    ctx.state.messages.pop();
  }

  if (ctx.state.messages.at(-1)?.role === 'user') {
    ctx.state.messages.pop();
  }

  finalizeTurnState(ctx);
}

function isEmptyAssistant(message: DisplayMessage): boolean {
  return message.parts.length === 0 && (message.steps?.every((step) => step.parts.length === 0) ?? true);
}

export function finalizeDisplayStateForHistory(state: DisplayState): DisplayState {
  const next = cloneState(state);
  if (!next.isStreaming) {
    return next;
  }

  addTokenUsage(next.tokenUsage, next.activeTokenUsage);
  next.activeTokenUsage = createEmptyTokenUsage();
  next.isStreaming = false;
  next.isCompacting = false;

  for (const message of next.messages) {
    if (message.role !== 'assistant') {
      continue;
    }

    if (message.status === 'streaming') {
      message.status = 'completed';
    }

    finishTextParts(message.parts);
    if (message.steps) {
      for (const step of message.steps) {
        finishTextParts(step.parts);
      }
    }
  }

  return next;
}

export function reduceDisplayEvent(state: DisplayState, event: DisplayEvent): DisplayReduction {
  const ctx: MutableState = { state: cloneState(state), effects: [] };

  switch (event.type) {
    case 'conversation.reset':
      ctx.state.messages = [];
      ctx.state.plan = null;
      ctx.state.status = null;
      ctx.state.pendingApprovals = [];
      ctx.state.tokenUsage = createEmptyTokenUsage();
      ctx.state.activeTokenUsage = createEmptyTokenUsage();
      ctx.state.availableCommands = [];
      ctx.state.isStreaming = false;
      ctx.state.isCompacting = false;
      ctx.effects.push({ type: 'ClearApprovals' });
      ctx.effects.push({ type: 'ClearTrackedFiles' });
      break;
    case 'turn.begin': {
      const cleaned = event.userText.trim();
      if (cleaned || event.parts?.length) {
        ctx.state.messages.push({ id: nextId(ctx.state, 'user'), role: 'user', parts: event.parts?.map(clonePart) ?? [{ type: 'text', text: cleaned }], status: 'completed' });
        ctx.state.messages.push({ id: nextId(ctx.state, 'assistant'), role: 'assistant', parts: [], steps: [], status: 'streaming' });
        ctx.state.isStreaming = true;
      }
      break;
    }
    case 'turn.complete':
      finalizeTurn(ctx, 'completed');
      break;
    case 'turn.error':
      if (event.error.phase === 'preflight') {
        rollbackPreflightTurn(ctx);
      } else {
        currentStepParts(ensureAssistant(ctx)).push({
        type: 'error',
        error: { ...event.error, details: event.error.details ? { ...event.error.details } : event.error.details },
      });
        finalizeTurn(ctx, 'error');
      }
      break;
    case 'turn.interrupted':
      currentStepParts(ensureAssistant(ctx)).push({ type: 'interrupt', reason: event.reason, message: event.message });
      finalizeTurn(ctx, 'interrupted');
      break;
    case 'message.begin': {
      if (event.text) ctx.state.messages.push({ id: event.id ?? nextId(ctx.state, event.role), role: event.role, parts: [{ type: 'text', text: event.text }], status: 'streaming' });
      else ctx.state.messages.push({ id: event.id ?? nextId(ctx.state, event.role), role: event.role, parts: [], steps: [], status: 'streaming' });
      break;
    }
    case 'step.begin': {
      const message = ensureAssistant(ctx);
      if (message.steps) for (const step of message.steps) finishTextParts(step.parts);
      if (!message.steps) message.steps = [];
      message.steps.push({ id: `step-${message.steps.length + 1}`, n: event.n, parts: [] });
      break;
    }
    case 'content.append':
      if (event.kind === 'media') appendMedia(ctx, event.media);
      else appendContent(ctx, event.kind, event.text);
      break;
    case 'tool.call':
      upsertToolCall(ctx, event.id, event.name, event.argumentsText, event.status ?? 'running');
      break;
    case 'tool.call.delta': {
      const message = ensureAssistant(ctx);
      const tool = message.steps ? findToolPart(message.steps.flatMap((step) => step.parts), event.id) : null;
      if (!tool) {
        upsertToolCall(ctx, event.id, 'tool', event.argumentsPart, 'pending');
      } else {
        tool.argumentsText = `${tool.argumentsText ?? ''}${event.argumentsPart}`;
      }
      break;
    }
    case 'tool.result':
      applyToolResult(ctx, event.id, event.isError, event.output, event.message, event.displayBlocks);
      break;
    case 'plan.replace':
      applyPlan(ctx, event);
      break;
    case 'approval.request': {
      const request = clonePart(event.request);
      ctx.state.pendingApprovals = [...ctx.state.pendingApprovals.filter((item) => item.requestId !== request.requestId), request];
      currentStepParts(ensureAssistant(ctx)).push(request);
      ctx.effects.push({ type: 'OpenApproval', request });
      break;
    }
    case 'approval.resolved':
      ctx.state.pendingApprovals = ctx.state.pendingApprovals.filter((item) => item.requestId !== event.requestId);
      break;
    case 'approval.clear':
      ctx.state.pendingApprovals = [];
      ctx.effects.push({ type: 'ClearApprovals' });
      break;
    case 'status.update':
      applyStatus(ctx, event.status);
      break;
    case 'usage.add':
      addTokenUsage(ctx.state.activeTokenUsage, event.usage);
      break;
    case 'compaction.begin':
      ctx.state.isCompacting = true;
      currentStepParts(ensureAssistant(ctx)).push({
        type: 'compaction',
        status: 'running',
        trigger: event.trigger,
        instruction: event.instruction,
        message: event.message,
      });
      break;
    case 'compaction.end':
      ctx.state.isCompacting = false;
      currentStepParts(ensureAssistant(ctx)).push({
        type: 'compaction',
        status: event.status ?? 'completed',
        trigger: event.trigger,
        instruction: event.instruction,
        summary: event.summary,
        compactedCount: event.compactedCount,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
        message: event.message,
      });
      break;
    case 'step.interrupted':
      currentStepParts(ensureAssistant(ctx)).push({ type: 'interrupt', reason: event.reason, message: event.message });
      finalizeTurn(ctx, 'interrupted');
      break;
    case 'available_commands.update': {
      const commands = event.commands.map((command) => ({ ...command }));
      ctx.state.availableCommands = commands;
      ctx.effects.push({ type: 'UpdateAvailableCommands', commands });
      break;
    }
    case 'subagent.event':
      applySubagentEvent(ctx, event.parentToolCallId, event.event);
      break;
  }

  return { state: ctx.state, effects: ctx.effects };
}
