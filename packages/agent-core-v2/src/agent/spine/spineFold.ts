import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ContentPart } from '#human/llm/message';

import type { SpineNode, SpineSpawnEvidence, SpineState } from './spineOps';
import type { SpineTrimProjection } from './spineTrimDerive';
import { applySpineTrim } from './spineTrimFold';

export interface SpineFoldStatus {
  readonly cursorId: string;
  readonly summary: string;
  readonly parentId: string | null;
  readonly parentSummary: string | null;
  readonly cursorContext: number;
  readonly contextLeft: number | undefined;
  readonly rawContext: number;
  readonly projectedContext: number;
  readonly projectedMeasured: boolean;
}

export interface SpineFoldInput {
  readonly state: SpineState;
  readonly anchors: readonly number[];
  readonly epochSummaryMessage?: ContextMessage;
  readonly trim?: SpineTrimProjection;
}

export function foldSpine(
  messages: readonly ContextMessage[],
  input: SpineFoldInput,
): ContextMessage[] {
  const state = input.state;
  const ctx: FoldContext = {
    messages,
    state,
    anchors: input.anchors,
    epochStartAt: state.epochStartAt,
    trim: input.trim,
  };
  const out: ContextMessage[] = [];

  if (input.epochSummaryMessage !== undefined && state.epochMemoryAt !== undefined) {
    out.push(input.epochSummaryMessage);
  }

  const root = state.epochs.at(-1);
  if (root !== undefined) {
    walkChildren(ctx, root.children, state.epochStartAt, messages.length - 1, out, pushRaw);
  }

  return out;
}

interface FoldContext {
  readonly messages: readonly ContextMessage[];
  readonly state: SpineState;
  readonly anchors: readonly number[];
  readonly epochStartAt: number;
  readonly trim: SpineTrimProjection | undefined;
}

type SpanSink = (ctx: FoldContext, index: number, out: ContextMessage[]) => void;

function walkChildren(
  ctx: FoldContext,
  children: readonly SpineNode[],
  lo: number,
  hi: number,
  out: ContextMessage[],
  sink: SpanSink,
): void {
  let i = lo;
  for (const child of children) {
    if (child.closedAt !== undefined && child.closedAt < ctx.epochStartAt) continue;
    const childLo = Math.max(child.openedAt, ctx.epochStartAt);
    if (childLo > hi) break;
    const childHi = Math.min(child.closedAt ?? hi, hi);
    for (; i < childLo; i++) sink(ctx, i, out);
    renderNode(ctx, child, childLo, childHi, out);
    i = childHi + 1;
  }
  for (; i <= hi; i++) sink(ctx, i, out);
}

function renderNode(
  ctx: FoldContext,
  node: SpineNode,
  lo: number,
  hi: number,
  out: ContextMessage[],
): void {
  if (node.closedAt === undefined) {
    out.push(spineNodeMessage(node, ctx.state));
    walkChildren(ctx, node.children, lo, hi, out, pushRaw);
    return;
  }
  if (node.spawn !== undefined) {
    out.push(spineSpawnEvidenceMessage(node, node.spawn));
  }
  walkChildren(ctx, node.children, lo, hi, out, pushSurvivingUserRequest);
  const memoryMessage = spineMemoryMessage(node);
  if (memoryMessage !== undefined) out.push(memoryMessage);
}

function pushRaw(ctx: FoldContext, index: number, out: ContextMessage[]): void {
  const message = ctx.messages[index];
  if (message === undefined) return;
  const anchor = ctx.anchors[index] ?? 0;
  const surviving = anchor > 0 ? annotateUserRequest(message, anchor) : message;
  out.push(ctx.trim === undefined ? surviving : applySpineTrim(ctx.trim, index, surviving));
}

function pushSurvivingUserRequest(ctx: FoldContext, index: number, out: ContextMessage[]): void {
  const message = ctx.messages[index];
  if (message === undefined) return;
  const anchor = ctx.anchors[index] ?? 0;
  if (anchor > 0) out.push(annotateUserRequest(message, anchor));
}

function spineNodeMessage(node: SpineNode, state: SpineState): ContextMessage {
  const status = state.openPath.at(-1)?.id === node.id ? 'live' : 'opened';
  const text = `<spine_node id="${node.id}" summary="${escapeAttr(node.summary)}" status="${status}" />`;
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'spine_node' },
  };
}

function spineMemoryMessage(node: SpineNode): ContextMessage | undefined {
  const memory = node.memory;
  if (memory === undefined) return undefined;
  return {
    role: 'user',
    content: [{ type: 'text', text: `<spine_memory node_id="${node.id}">\n${memory}\n</spine_memory>` }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'spine_memory' },
  };
}

function spineSpawnEvidenceMessage(
  node: SpineNode,
  spawn: SpineSpawnEvidence,
): ContextMessage {
  const diagnostic =
    spawn.diagnostic === undefined ? '' : ` diagnostic="${escapeAttr(spawn.diagnostic)}"`;
  const text = `<spine_spawn_evidence node_id="${node.id}" summary="${escapeAttr(
    spawn.summary,
  )}" outcome="${spawn.outcome}"${diagnostic} />`;
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'spine_spawn_evidence' },
  };
}

function annotateUserRequest(message: ContextMessage, anchorNumber: number): ContextMessage {
  const anchor = `[U${String(anchorNumber)}] `;
  const content = prefixFirstText(message.content, anchor);
  if (content === message.content) return message;
  return { ...message, content };
}

function prefixFirstText(content: readonly ContentPart[], anchor: string): ContentPart[] {
  const index = content.findIndex((part) => part.type === 'text');
  if (index < 0) {
    return [{ type: 'text', text: anchor.trimEnd() }, ...content];
  }
  return content.map((part, position) =>
    position === index && part.type === 'text' ? { type: 'text', text: anchor + part.text } : part,
  );
}

export function buildSpineTranStatusMessage(status: SpineFoldStatus): ContextMessage {
  const parent = status.parentId === null ? '' : ` parent="${status.parentId}"`;
  const parentSummary =
    status.parentSummary === null ? '' : ` parent_summary="${escapeAttr(status.parentSummary)}"`;
  const cursorContext = ` cursor_context="~${formatTokens(status.cursorContext)}"`;
  const contextLeft =
    status.contextLeft === undefined ? '' : ` context_left="~${formatTokens(status.contextLeft)}"`;
  const rawContext = ` raw_context="~${formatTokens(status.rawContext)}"`;
  const projectedPrefix = status.projectedMeasured ? '' : '~';
  const projectedContext = ` projected_context="${projectedPrefix}${formatTokens(
    status.projectedContext,
  )}"`;
  const text = `<spine_tran_status cursor="${status.cursorId}" summary="${escapeAttr(status.summary)}"${parent}${parentSummary}${cursorContext}${contextLeft}${rawContext}${projectedContext} />`;
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'spine_tran_status' },
  };
}

function formatTokens(tokens: number): string {
  const safe = Math.max(0, tokens);
  if (safe >= 1000) return `${(safe / 1000).toFixed(safe >= 10000 ? 0 : 1)}K`;
  return String(safe);
}

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
