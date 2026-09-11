import { z } from 'zod';

import {
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';

import {
  SPINE_TOOL_CLOSE,
  SPINE_TOOL_NEXT,
  SPINE_TOOL_OPEN,
  SPINE_TOOL_SPAWN,
} from './spine';
import type { SpineNodeKind, SpineSpawnEvidence, SpineState } from './spineOps';
import { SPINE_VOID_OPENED_AT, spineChildId } from './spineOps';
import { ACCEPTED_OUTPUT } from './tools/controlResult';

const LEGACY_ACCEPTED_RECEIPT = 'accepted';

export interface SpineProjection {
  readonly state: SpineState;
  readonly anchors: readonly number[];
}

export function deriveSpineProjection(messages: readonly ContextMessage[]): SpineProjection {
  const evidence = scanSpineEvidence(messages);
  return {
    state: buildSpineState(messages, evidence),
    anchors: evidence.anchors,
  };
}

export function deriveSpineState(messages: readonly ContextMessage[]): SpineState {
  return deriveSpineProjection(messages).state;
}

export function isUserRequest(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

interface SpineEvidence {
  readonly accepted: ReadonlySet<string>;
  readonly spawns: ReadonlyMap<string, SpawnReceiptInfo>;
  readonly anchors: readonly number[];
}

function scanSpineEvidence(messages: readonly ContextMessage[]): SpineEvidence {
  const callNames = new Map<string, string>();
  const spawnCalls = new Map<string, readonly SpawnTask[]>();
  const accepted = new Set<string>();
  const spawns = new Map<string, SpawnReceiptInfo>();
  const anchors: number[] = Array.from({ length: messages.length }, () => 0);
  let anchor = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;
    if (isUserRequest(message)) {
      anchor += 1;
      anchors[i] = anchor;
    }
    if (message.role === 'assistant') {
      if (message.toolCalls.length === 0) continue;
      for (const call of message.toolCalls) {
        callNames.set(call.id, call.name);
        if (call.name === SPINE_TOOL_SPAWN) {
          const tasks = parseSpawnArgs(call.arguments);
          if (tasks !== undefined) spawnCalls.set(call.id, tasks);
        }
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    const callId = message.toolCallId;
    if (callId === undefined) continue;
    const name = callNames.get(callId);
    if (name !== undefined && isSpineTransitionTool(name)) {
      if (message.isError === true) continue;
      const text = messageText(message);
      if (text === ACCEPTED_OUTPUT || text === LEGACY_ACCEPTED_RECEIPT) accepted.add(callId);
      continue;
    }
    if (name === SPINE_TOOL_SPAWN) {
      if (message.isError === true) continue;
      const tasks = spawnCalls.get(callId);
      if (tasks === undefined) continue;
      const validated = validateSpawnReceipt(tasks, messageText(message), i);
      if (validated !== undefined) spawns.set(callId, validated);
    }
  }

  return { accepted, spawns, anchors };
}

interface MutableSpineNode {
  id: string;
  kind: SpineNodeKind;
  summary: string;
  openedAt: number;
  closedAt?: number;
  memory?: string;
  spawn?: SpineSpawnEvidence;
  children: MutableSpineNode[];
}

function buildSpineState(
  messages: readonly ContextMessage[],
  evidence: SpineEvidence,
): SpineState {
  const epochs: MutableSpineNode[] = [];
  let openPath: MutableSpineNode[] = [];
  let rootEpoch = 0;
  let epochStartAt = 0;
  let epochMemoryAt: number | undefined;

  function openEpoch(epoch: number, startupOpenedAt: number): void {
    const root: MutableSpineNode = {
      id: String(epoch),
      kind: 'epoch',
      summary: `root epoch ${String(epoch)}`,
      openedAt: SPINE_VOID_OPENED_AT,
      children: [],
    };
    const startup: MutableSpineNode = {
      id: spineChildId(root.id, 0),
      kind: 'startup',
      summary: 'startup',
      openedAt: startupOpenedAt,
      children: [],
    };
    root.children.push(startup);
    epochs.push(root);
    openPath = [root, startup];
    rootEpoch = epoch;
  }

  function openNode(summary: string, openedAt: number): void {
    const parent = openPath.at(-1);
    if (parent === undefined || parent.closedAt !== undefined) return;
    const trimmed = summary.trim();
    if (trimmed.length === 0) return;
    const child: MutableSpineNode = {
      id: spineChildId(parent.id, parent.children.length),
      kind: 'task',
      summary: trimmed,
      openedAt,
      children: [],
    };
    parent.children.push(child);
    openPath.push(child);
  }

  function closeNode(memory: string, carrierAt: number): void {
    const node = openPath.at(-1);
    if (node === undefined || openPath.length <= 1) return;
    if (node.closedAt !== undefined) return;
    const trimmed = memory.trim();
    if (trimmed.length === 0) return;
    node.closedAt = Math.max(carrierAt - 1, node.openedAt);
    node.memory = trimmed;
    openPath.pop();
  }

  function nextNode(summary: string, memory: string, carrierAt: number): void {
    const closing = openPath.at(-1);
    if (closing === undefined || openPath.length <= 1) return;
    if (closing.closedAt !== undefined) return;
    const trimmedSummary = summary.trim();
    const trimmedMemory = memory.trim();
    if (trimmedSummary.length === 0 || trimmedMemory.length === 0) return;
    const parent = openPath.at(-2);
    if (parent === undefined) return;
    const closedAt = Math.max(carrierAt - 1, closing.openedAt);
    closing.closedAt = closedAt;
    closing.memory = trimmedMemory;
    const opened: MutableSpineNode = {
      id: spineChildId(parent.id, parent.children.length),
      kind: 'task',
      summary: trimmedSummary,
      openedAt: closedAt + 1,
      children: [],
    };
    parent.children.push(opened);
    openPath = [...openPath.slice(0, -1), opened];
  }

  function spawnNodes(parent: MutableSpineNode, spawn: SpawnReceiptInfo): void {
    if (parent.closedAt !== undefined) return;
    const receiptAt = spawn.receiptAt;
    for (const result of spawn.results) {
      const spawnEvidence: SpineSpawnEvidence = {
        summary: result.summary,
        outcome: result.outcome,
      };
      parent.children.push({
        id: spineChildId(parent.id, parent.children.length),
        kind: 'task',
        summary: result.summary,
        openedAt: receiptAt,
        closedAt: receiptAt,
        memory: result.memoryBody,
        spawn:
          result.diagnostic === undefined
            ? spawnEvidence
            : { ...spawnEvidence, diagnostic: result.diagnostic },
        children: [],
      });
    }
  }

  openEpoch(1, 0);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;
    if (isEpochBoundary(message)) {
      openEpoch(rootEpoch + 1, i + 1);
      epochStartAt = i + 1;
      epochMemoryAt = i;
      continue;
    }
    if (message.role !== 'assistant') continue;
    let hasSpawnCall = false;
    let hasControlCall = false;
    const spawns: SpawnReceiptInfo[] = [];
    const transitions: Array<{ readonly name: string; readonly args: SpineTransitionArgs }> =
      [];
    for (const call of message.toolCalls) {
      if (call.name === SPINE_TOOL_SPAWN) {
        hasSpawnCall = true;
        const spawn = evidence.spawns.get(call.id);
        if (spawn !== undefined) spawns.push(spawn);
        continue;
      }
      if (!isSpineTransitionTool(call.name)) continue;
      hasControlCall = true;
      if (!evidence.accepted.has(call.id)) continue;
      const args = parseTransitionArgs(call.arguments);
      if (args === undefined) continue;
      if (!hasTransitionBody(call.name, args)) continue;
      transitions.push({ name: call.name, args });
    }
    if (hasSpawnCall) {
      if (hasControlCall) continue;
      const parent = openPath.at(-1);
      if (parent !== undefined) {
        for (const spawn of spawns) spawnNodes(parent, spawn);
      }
      continue;
    }
    if (transitions.length !== 1) continue;
    const transition = transitions[0];
    if (transition === undefined) continue;
    if (transition.name === SPINE_TOOL_OPEN) {
      openNode(transition.args.summary, i);
    } else if (transition.name === SPINE_TOOL_CLOSE) {
      closeNode(transition.args.memory, i);
    } else if (transition.name === SPINE_TOOL_NEXT) {
      nextNode(transition.args.summary, transition.args.memory, i);
    }
  }

  return { epochs, openPath, rootEpoch, epochStartAt, epochMemoryAt };
}

interface SpineTransitionArgs {
  readonly summary: string;
  readonly memory: string;
}

const lenientString = z.preprocess((value) => (typeof value === 'string' ? value : ''), z.string());

const transitionArgsSchema = z.object({
  summary: lenientString,
  memory: lenientString,
});

function parseTransitionArgs(raw: string | null | undefined): SpineTransitionArgs | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = parseJsonObject(raw);
  if (parsed === undefined) return undefined;
  const result = transitionArgsSchema.safeParse(parsed);
  return result.success ? result.data : { summary: '', memory: '' };
}

function parseJsonObject(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isSpineTransitionTool(name: string): boolean {
  return name === SPINE_TOOL_OPEN || name === SPINE_TOOL_CLOSE || name === SPINE_TOOL_NEXT;
}

function hasTransitionBody(name: string, args: SpineTransitionArgs): boolean {
  if (name === SPINE_TOOL_OPEN) return args.summary.trim().length > 0;
  if (name === SPINE_TOOL_CLOSE) return args.memory.trim().length > 0;
  if (name === SPINE_TOOL_NEXT) {
    return args.summary.trim().length > 0 && args.memory.trim().length > 0;
  }
  return false;
}

interface SpawnTask {
  readonly summary: string;
  readonly prompt: string;
}

interface SpawnResult {
  readonly summary: string;
  readonly outcome: 'completed' | 'errored' | 'aborted';
  readonly memoryBody: string;
  readonly diagnostic?: string;
}

interface SpawnReceiptInfo {
  readonly receiptAt: number;
  readonly results: readonly SpawnResult[];
}

const spawnArgsSchema = z.object({
  tasks: z
    .array(
      z.object({
        summary: z.string(),
        prompt: z.string(),
      }),
    )
    .min(2),
});

function parseSpawnArgs(raw: string | null | undefined): readonly SpawnTask[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = parseJsonObject(raw);
  if (parsed === undefined) return undefined;
  const result = spawnArgsSchema.safeParse(parsed);
  return result.success ? result.data.tasks : undefined;
}

const spawnReceiptResultSchema = z
  .object({
    ordinal: z.number().int(),
    outcome: z.enum(['completed', 'errored', 'aborted']),
    memory_body: z.string().min(1),
    diagnostic: z.string().min(1).optional(),
    execution_ref: z.string().min(1).optional(),
  })
  .refine((result) => result.outcome === 'completed' || result.diagnostic !== undefined);

const spawnReceiptSchema = z.object({
  schema: z.literal('spine.spawn.result.v1'),
  results: z.array(spawnReceiptResultSchema).min(2),
});

function validateSpawnReceipt(
  tasks: readonly SpawnTask[],
  receiptText: string,
  receiptAt: number,
): SpawnReceiptInfo | undefined {
  const parsed = parseJsonObject(receiptText);
  if (parsed === undefined) return undefined;
  const receipt = spawnReceiptSchema.safeParse(parsed);
  if (!receipt.success) return undefined;
  const rawResults = receipt.data.results;
  if (rawResults.length !== tasks.length) return undefined;
  const results: SpawnResult[] = [];
  const seenOrdinals = new Set<number>();
  for (const item of rawResults) {
    if (item.ordinal < 0 || item.ordinal >= tasks.length || seenOrdinals.has(item.ordinal)) {
      return undefined;
    }
    seenOrdinals.add(item.ordinal);
    const task = tasks[item.ordinal];
    if (task === undefined || task.summary.trim().length === 0) return undefined;
    results[item.ordinal] = {
      summary: task.summary,
      outcome: item.outcome,
      memoryBody: item.memory_body,
      diagnostic: item.diagnostic,
    };
  }
  if (seenOrdinals.size !== tasks.length) return undefined;
  return { receiptAt, results };
}

function isEpochBoundary(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  if (isCompactionSummaryMessage(message)) return true;
  if (message.origin !== undefined) return false;
  return messageText(message).startsWith(COMPACTION_SUMMARY_PREFIX);
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}
