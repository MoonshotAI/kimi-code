import {
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';

import { SPINE_TOOL_CLOSE, SPINE_TOOL_NEXT, SPINE_TOOL_OPEN } from './spine';
import type { SpineNode, SpineSpawnEvidence, SpineState } from './spineOps';
import {
  childNodeId,
  epochStartupNodeId,
  isRootEpoch,
  nextChildIndex,
  parentNodeId,
  SPINE_VOID_OPENED_AT,
} from './spineTree';
import { ACCEPTED_OUTPUT } from './tools/controlResult';

const LEGACY_ACCEPTED_RECEIPT = 'accepted';

const SPINE_TOOL_SPAWN = 'spine_spawn';

export function deriveSpineState(messages: readonly ContextMessage[]): SpineState {
  const accepted = collectAcceptedCallIds(messages);
  const spawnReceipts = collectSpawnReceipts(messages);
  const nodes: Record<string, SpineNode> = {};
  let openStack: readonly string[] = [];
  let rootEpoch = 0;
  let epochStartAt = 0;
  let epochMemoryAt: number | undefined;

  function openEpoch(epoch: number, startupOpenedAt: number): void {
    const epochId = String(epoch);
    const startupId = epochStartupNodeId(epoch);
    nodes[epochId] = {
      id: epochId,
      summary: `root epoch ${String(epoch)}`,
      openedAt: SPINE_VOID_OPENED_AT,
      children: [startupId],
    };
    nodes[startupId] = {
      id: startupId,
      summary: 'startup',
      openedAt: startupOpenedAt,
      children: [],
    };
    openStack = [epochId, startupId];
    rootEpoch = epoch;
  }

  function openNode(summary: string, openedAt: number): void {
    const parentId = openStack.at(-1);
    if (parentId === undefined) return;
    const parent = nodes[parentId];
    if (parent === undefined || parent.closedAt !== undefined) return;
    const trimmed = summary.trim();
    if (trimmed.length === 0) return;
    const id = childNodeId(parentId, nextChildIndex(parent.children));
    nodes[id] = { id, summary: trimmed, openedAt, children: [] };
    nodes[parentId] = { ...parent, children: [...parent.children, id] };
    openStack = [...openStack, id];
  }

  function closeNode(memory: string, carrierAt: number): void {
    const id = openStack.at(-1);
    if (id === undefined || isRootEpoch(id)) return;
    const node = nodes[id];
    if (node === undefined || node.closedAt !== undefined) return;
    const trimmed = memory.trim();
    if (trimmed.length === 0) return;
    const closedAt = Math.max(carrierAt - 1, node.openedAt);
    nodes[id] = { ...node, closedAt, memory: trimmed };
    openStack = openStack.slice(0, -1);
  }

  function nextNode(summary: string, memory: string, carrierAt: number): void {
    const closedId = openStack.at(-1);
    if (closedId === undefined || isRootEpoch(closedId)) return;
    const closing = nodes[closedId];
    if (closing === undefined || closing.closedAt !== undefined) return;
    const trimmedSummary = summary.trim();
    const trimmedMemory = memory.trim();
    if (trimmedSummary.length === 0 || trimmedMemory.length === 0) return;
    const parentId = parentNodeId(closedId);
    if (parentId === null) return;
    const parent = nodes[parentId];
    if (parent === undefined) return;
    const closedAt = Math.max(carrierAt - 1, closing.openedAt);
    const openedId = childNodeId(parentId, nextChildIndex(parent.children));
    nodes[closedId] = {
      ...closing,
      closedAt,
      memory: trimmedMemory,
    };
    nodes[openedId] = {
      id: openedId,
      summary: trimmedSummary,
      openedAt: closedAt + 1,
      children: [],
    };
    nodes[parentId] = { ...parent, children: [...parent.children, openedId] };
    openStack = [...openStack.slice(0, -1), openedId];
  }

  function spawnNodes(parentId: string, spawn: SpawnReceiptInfo): void {
    const parent = nodes[parentId];
    if (parent === undefined || parent.closedAt !== undefined) return;
    const receiptAt = spawn.receiptAt;
    let childIndex = nextChildIndex(parent.children);
    const newChildren: string[] = [];
    const newNodes: Record<string, SpineNode> = {};
    for (const result of spawn.results) {
      const id = childNodeId(parentId, childIndex);
      const spawnEvidence: SpineSpawnEvidence = {
        summary: result.summary,
        outcome: result.outcome,
      };
      newNodes[id] = {
        id,
        summary: result.summary,
        openedAt: receiptAt,
        closedAt: receiptAt,
        memory: result.memoryBody,
        spawn:
          result.diagnostic === undefined
            ? spawnEvidence
            : { ...spawnEvidence, diagnostic: result.diagnostic },
        children: [],
      };
      newChildren.push(id);
      childIndex += 1;
    }
    nodes[parentId] = { ...parent, children: [...parent.children, ...newChildren] };
    Object.assign(nodes, newNodes);
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
        const spawn = spawnReceipts.get(call.id);
        if (spawn !== undefined) spawns.push(spawn);
        continue;
      }
      if (!isSpineTransitionTool(call.name)) continue;
      hasControlCall = true;
      if (!accepted.has(call.id)) continue;
      const args = parseTransitionArgs(call.arguments);
      if (args === undefined) continue;
      if (!hasTransitionBody(call.name, args)) continue;
      transitions.push({ name: call.name, args });
    }
    if (hasSpawnCall) {
      if (hasControlCall) continue;
      const parentId = openStack.at(-1);
      if (parentId !== undefined) {
        for (const spawn of spawns) spawnNodes(parentId, spawn);
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

  return { nodes, openStack, rootEpoch, epochStartAt, epochMemoryAt };
}

interface SpineTransitionArgs {
  readonly summary: string;
  readonly memory: string;
}

function parseTransitionArgs(raw: string | null | undefined): SpineTransitionArgs | undefined {
  if (raw === undefined || raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const summary = record['summary'];
  const memory = record['memory'];
  return {
    summary: typeof summary === 'string' ? summary : '',
    memory: typeof memory === 'string' ? memory : '',
  };
}

function collectAcceptedCallIds(messages: readonly ContextMessage[]): ReadonlySet<string> {
  const spineCallIds = new Set<string>();
  for (const message of messages) {
    if (message === undefined || message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (isSpineTransitionTool(call.name)) spineCallIds.add(call.id);
    }
  }
  const accepted = new Set<string>();
  for (const message of messages) {
    if (message === undefined || message.role !== 'tool') continue;
    const callId = message.toolCallId;
    if (callId === undefined || !spineCallIds.has(callId)) continue;
    if (message.isError === true) continue;
    const text = messageText(message);
    if (text === ACCEPTED_OUTPUT || text === LEGACY_ACCEPTED_RECEIPT) accepted.add(callId);
  }
  return accepted;
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

interface SpawnCallInfo {
  readonly carrierAt: number;
  readonly tasks: readonly SpawnTask[];
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

function parseSpawnArgs(raw: string | null | undefined): readonly SpawnTask[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const tasksRaw = record['tasks'];
  if (!Array.isArray(tasksRaw) || tasksRaw.length < 2) return undefined;
  const tasks: SpawnTask[] = [];
  for (const item of tasksRaw) {
    if (typeof item !== 'object' || item === null) return undefined;
    const itemRecord = item as Record<string, unknown>;
    const summary = itemRecord['summary'];
    const prompt = itemRecord['prompt'];
    if (typeof summary !== 'string' || typeof prompt !== 'string') return undefined;
    tasks.push({ summary, prompt });
  }
  return tasks;
}

function collectSpawnReceipts(
  messages: readonly ContextMessage[],
): ReadonlyMap<string, SpawnReceiptInfo> {
  const calls = new Map<string, SpawnCallInfo>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined || message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.name !== SPINE_TOOL_SPAWN) continue;
      const tasks = parseSpawnArgs(call.arguments);
      if (tasks !== undefined) calls.set(call.id, { carrierAt: i, tasks });
    }
  }
  const receipts = new Map<string, SpawnReceiptInfo>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined || message.role !== 'tool') continue;
    const callId = message.toolCallId;
    if (callId === undefined) continue;
    const call = calls.get(callId);
    if (call === undefined) continue;
    if (message.isError === true) continue;
    const validated = validateSpawnReceipt(call.tasks, messageText(message), i);
    if (validated !== undefined) receipts.set(callId, validated);
  }
  return receipts;
}

function validateSpawnReceipt(
  tasks: readonly SpawnTask[],
  receiptText: string,
  receiptAt: number,
): SpawnReceiptInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record['schema'] !== 'spine.spawn.result.v1') return undefined;
  const resultsRaw = record['results'];
  if (!Array.isArray(resultsRaw) || resultsRaw.length < 2 || resultsRaw.length !== tasks.length) {
    return undefined;
  }
  const results: SpawnResult[] = [];
  const seenOrdinals = new Set<number>();
  for (const item of resultsRaw) {
    if (typeof item !== 'object' || item === null) return undefined;
    const itemRecord = item as Record<string, unknown>;
    const ordinal = itemRecord['ordinal'];
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal)) return undefined;
    if (ordinal < 0 || ordinal >= tasks.length || seenOrdinals.has(ordinal)) return undefined;
    seenOrdinals.add(ordinal);
    const outcome = itemRecord['outcome'];
    if (outcome !== 'completed' && outcome !== 'errored' && outcome !== 'aborted') return undefined;
    const memoryBody = itemRecord['memory_body'];
    if (typeof memoryBody !== 'string' || memoryBody.length === 0) return undefined;
    const diagnostic = itemRecord['diagnostic'];
    if (diagnostic !== undefined && (typeof diagnostic !== 'string' || diagnostic.length === 0)) {
      return undefined;
    }
    const executionRef = itemRecord['execution_ref'];
    if (
      executionRef !== undefined &&
      (typeof executionRef !== 'string' || executionRef.length === 0)
    ) {
      return undefined;
    }
    if (outcome !== 'completed' && diagnostic === undefined) return undefined;
    const task = tasks[ordinal];
    if (task === undefined || task.summary.trim().length === 0) return undefined;
    results[ordinal] = {
      summary: task.summary,
      outcome,
      memoryBody,
      diagnostic,
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
