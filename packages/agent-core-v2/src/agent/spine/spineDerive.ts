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
  SPINE_TOOL_TRIM,
} from './spine';
import type { SpineNodeKind, SpineSpawnEvidence, SpineState } from './spineOps';
import { SPINE_VOID_OPENED_AT, spineChildId } from './spineOps';
import {
  parseSpineTrimCallArgs,
  SPINE_TRIM_THRESHOLD_BYTES,
  type SpineTrimCallArgs,
  type SpineTrimOp,
  type SpineTrimProjection,
} from './spineTrimDerive';
import { ACCEPTED_OUTPUT, TRIM_ACCEPTED_OUTPUT } from './tools/controlResult';

const LEGACY_ACCEPTED_RECEIPT = 'accepted';

export interface SpineProjection {
  readonly state: SpineState;
  readonly trim: SpineTrimProjection;
  readonly anchors: readonly number[];
}

export function deriveSpineProjection(messages: readonly ContextMessage[]): SpineProjection {
  const evidence = scanSpineEvidence(messages);
  return {
    state: buildSpineState(messages, evidence),
    trim: evidence.trim,
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
  readonly trim: SpineTrimProjection;
  readonly anchors: readonly number[];
}

function scanSpineEvidence(messages: readonly ContextMessage[]): SpineEvidence {
  const callNames = new Map<string, string>();
  const spawnCalls = new Map<string, readonly SpawnTask[]>();
  const trimCalls = new Map<string, SpineTrimCallArgs>();
  const accepted = new Set<string>();
  const spawns = new Map<string, SpawnReceiptInfo>();
  const labels = new Map<number, string>();
  const tagIndex = new Map<string, number>();
  const masks = new Map<number, SpineTrimOp>();
  const consumed = new Set<string>();
  let eligible = new Set<string>();
  let pendingCalls = new Set<string>();
  let batchTags: string[] = [];
  let tagCounter = 0;
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
      if (pendingCalls.size === 0) eligible = new Set(batchTags);
      pendingCalls = new Set<string>();
      batchTags = [];
      for (const call of message.toolCalls) {
        callNames.set(call.id, call.name);
        pendingCalls.add(call.id);
        if (call.name === SPINE_TOOL_SPAWN) {
          const tasks = parseSpawnArgs(call.arguments);
          if (tasks !== undefined) spawnCalls.set(call.id, tasks);
        } else if (call.name === SPINE_TOOL_TRIM) {
          const args = parseSpineTrimCallArgs(call.arguments);
          if (args !== undefined) trimCalls.set(call.id, args);
        }
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    const callId = message.toolCallId;
    if (callId === undefined) continue;
    pendingCalls.delete(callId);
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
      continue;
    }
    if (name === SPINE_TOOL_TRIM) {
      if (message.isError === true) continue;
      if (messageText(message) !== TRIM_ACCEPTED_OUTPUT) continue;
      const args = trimCalls.get(callId);
      const target = args === undefined ? undefined : tagIndex.get(args.trimId);
      if (args === undefined || target === undefined || consumed.has(args.trimId)) continue;
      masks.set(target, args.op);
      consumed.add(args.trimId);
      continue;
    }
    if (name === undefined || name.startsWith('spine_')) continue;
    if (!message.content.every((part) => part.type === 'text')) continue;
    const text = messageText(message);
    if (utf8Length(text) <= SPINE_TRIM_THRESHOLD_BYTES) continue;
    tagCounter += 1;
    const tag = `trim_${String(tagCounter)}`;
    labels.set(i, tag);
    tagIndex.set(tag, i);
    batchTags.push(tag);
  }
  if (pendingCalls.size === 0) eligible = new Set(batchTags);

  return {
    accepted,
    spawns,
    trim: { labels, tagIndex, masks, eligible, consumed },
    anchors,
  };
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

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}
