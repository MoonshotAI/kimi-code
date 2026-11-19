import { enableMapSet, freeze, produce } from 'immer';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from 'prosemirror-state';
import { Step, StepMap, StepResult } from 'prosemirror-transform';
import { buildAttachmentInsertion, composerSchema, textOffsetToPos, type AttachmentAttrs } from '../../model';

enableMapSet();

export interface AttachmentInventoryState {
  readonly orderedIds: readonly string[];
  readonly activeIds: ReadonlySet<string>;
  readonly refCounts: ReadonlyMap<string, number>;
  readonly resourceRevision: number;
}

export type AttachmentInventoryOperation =
  | { type: 'activate'; attId: string; index: number }
  | { type: 'deactivate'; attId: string; index: number }
  | { type: 'reorder'; attId: string; from: number; to: number };

export type AttachmentInventoryMeta = { type: 'resource-revision' };

export const attachmentInventoryKey = new PluginKey<AttachmentInventoryState>('composerAttachmentInventory');

const ATTACHMENT_INVENTORY_STEP_ID = 'composerAttachmentInventory';

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Math.trunc(index), length));
}

export function attachmentRefCounts(doc: PMNode): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type !== composerSchema.nodes.attachment) return true;
    const attId = (node.attrs as AttachmentAttrs).attId;
    counts.set(attId, (counts.get(attId) ?? 0) + 1);
    return false;
  });
  return counts;
}

function nonMediaAttachmentIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type !== composerSchema.nodes.attachment) return true;
    const attrs = node.attrs as AttachmentAttrs;
    if (attrs.kind === 'file' || attrs.kind === 'folder') ids.add(attrs.attId);
    return false;
  });
  return ids;
}

function equalCounts(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [attId, count] of left) {
    if (right.get(attId) !== count) return false;
  }
  return true;
}

export function applyAttachmentInventoryOperation(
  state: AttachmentInventoryState,
  operation: AttachmentInventoryOperation,
): AttachmentInventoryState {
  return produce(state, (draft) => {
    if (operation.type === 'activate') {
      if (draft.activeIds.has(operation.attId)) return;
      const index = clampIndex(operation.index, draft.orderedIds.length);
      draft.activeIds.add(operation.attId);
      draft.orderedIds.splice(index, 0, operation.attId);
      return;
    }
    if (operation.type === 'deactivate') {
      if (!draft.activeIds.has(operation.attId)) return;
      draft.activeIds.delete(operation.attId);
      const index = draft.orderedIds.indexOf(operation.attId);
      if (index !== -1) draft.orderedIds.splice(index, 1);
      return;
    }
    if (!draft.activeIds.has(operation.attId)) return;
    const from = draft.orderedIds.indexOf(operation.attId);
    if (from === -1) return;
    const to = clampIndex(operation.to, draft.orderedIds.length - 1);
    if (from === to) return;
    draft.orderedIds.splice(from, 1);
    draft.orderedIds.splice(to, 0, operation.attId);
  });
}

export class AttachmentInventoryStep extends Step {
  constructor(readonly operation: AttachmentInventoryOperation) {
    super();
  }

  apply(doc: PMNode): StepResult {
    return StepResult.ok(doc);
  }

  override getMap(): StepMap {
    return StepMap.empty;
  }

  invert(): Step {
    const operation = this.operation;
    if (operation.type === 'activate') {
      return new AttachmentInventoryStep({ type: 'deactivate', attId: operation.attId, index: operation.index });
    }
    if (operation.type === 'deactivate') {
      return new AttachmentInventoryStep({ type: 'activate', attId: operation.attId, index: operation.index });
    }
    return new AttachmentInventoryStep({
      type: 'reorder',
      attId: operation.attId,
      from: operation.to,
      to: operation.from,
    });
  }

  map(): Step | null {
    return this;
  }

  toJSON(): { stepType: string; operation: AttachmentInventoryOperation } {
    return { stepType: ATTACHMENT_INVENTORY_STEP_ID, operation: this.operation };
  }

  static override fromJSON(_schema: Schema, value: { operation?: AttachmentInventoryOperation }): AttachmentInventoryStep {
    if (value.operation === undefined) throw new RangeError('Invalid attachment inventory step');
    return new AttachmentInventoryStep(value.operation);
  }
}

try {
  Step.jsonID(ATTACHMENT_INVENTORY_STEP_ID, AttachmentInventoryStep);
} catch (error) {
  if (
    !(error instanceof RangeError) ||
    error.message !== `Duplicate use of step JSON ID ${ATTACHMENT_INVENTORY_STEP_ID}`
  ) {
    throw error;
  }
  Object.defineProperty(AttachmentInventoryStep.prototype, 'jsonID', {
    value: ATTACHMENT_INVENTORY_STEP_ID,
  });
}

export function isAttachmentInventoryStep(step: Step): step is AttachmentInventoryStep {
  return step instanceof AttachmentInventoryStep ||
    (step as Step & { jsonID?: string }).jsonID === ATTACHMENT_INVENTORY_STEP_ID;
}

export function createAttachmentInventoryPlugin(initialIds: readonly string[] = []): Plugin<AttachmentInventoryState> {
  const orderedIds = [...new Set(initialIds)];
  return new Plugin<AttachmentInventoryState>({
    key: attachmentInventoryKey,
    state: {
      init(_config, state) {
        return freeze({
          orderedIds,
          activeIds: new Set(orderedIds),
          refCounts: attachmentRefCounts(state.doc),
          resourceRevision: 0,
        }, true);
      },
      apply(tr, value, _oldState, newState) {
        let next = value;
        for (const step of tr.steps) {
          if (isAttachmentInventoryStep(step)) {
            next = applyAttachmentInventoryOperation(next, step.operation);
          }
        }
        const meta = tr.getMeta(attachmentInventoryKey) as AttachmentInventoryMeta | undefined;
        if (meta?.type === 'resource-revision') {
          next = produce(next, (draft) => {
            draft.resourceRevision += 1;
          });
        }
        const refCounts = attachmentRefCounts(newState.doc);
        if (!equalCounts(next.refCounts, refCounts)) {
          next = produce(next, (draft) => {
            draft.refCounts = new Map(refCounts);
          });
        }
        return next;
      },
    },
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const inventory = attachmentInventoryKey.getState(newState);
      if (inventory === undefined) return null;
      const after = attachmentRefCounts(newState.doc);
      const removed = [...nonMediaAttachmentIds(oldState.doc)].filter(
        (attId) => inventory.activeIds.has(attId) && !after.has(attId),
      );
      if (removed.length === 0) return null;
      const tr = newState.tr;
      for (const attId of removed) {
        const index = inventory.orderedIds.indexOf(attId);
        if (index !== -1) tr.step(new AttachmentInventoryStep({ type: 'deactivate', attId, index }));
      }
      return tr.steps.length === 0 ? null : tr;
    },
  });
}

export function attachmentInventory(state: EditorState): AttachmentInventoryState {
  const inventory = attachmentInventoryKey.getState(state);
  if (inventory === undefined) throw new Error('Attachment inventory plugin is missing');
  return inventory;
}

export function activateAttachmentStep(state: EditorState, attId: string, index?: number): AttachmentInventoryStep {
  const inventory = attachmentInventory(state);
  const insertionIndex = index === undefined ? inventory.orderedIds.length : Math.max(0, Math.trunc(index));
  return new AttachmentInventoryStep({ type: 'activate', attId, index: insertionIndex });
}

export function deactivateAttachmentStep(state: EditorState, attId: string): AttachmentInventoryStep | null {
  const inventory = attachmentInventory(state);
  const index = inventory.orderedIds.indexOf(attId);
  if (index === -1) return null;
  return new AttachmentInventoryStep({ type: 'deactivate', attId, index });
}

export function reorderAttachmentStep(
  state: EditorState,
  attId: string,
  to: number,
): AttachmentInventoryStep | null {
  const inventory = attachmentInventory(state);
  const from = inventory.orderedIds.indexOf(attId);
  if (from === -1) return null;
  const destination = clampIndex(to, inventory.orderedIds.length - 1);
  if (from === destination) return null;
  return new AttachmentInventoryStep({ type: 'reorder', attId, from, to: destination });
}

function attachmentReferencePositions(state: EditorState, attId: string): { from: number; to: number }[] {
  const positions: { from: number; to: number }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type !== composerSchema.nodes.attachment) return true;
    if ((node.attrs as AttachmentAttrs).attId === attId) {
      positions.push({ from: pos, to: pos + node.nodeSize });
    }
    return false;
  });
  return positions;
}

export function deactivateAttachmentTransaction(state: EditorState, attId: string): Transaction | null {
  const step = deactivateAttachmentStep(state, attId);
  if (step === null) return null;
  const tr = state.tr.step(step);
  for (const position of attachmentReferencePositions(state, attId).reverse()) {
    tr.delete(position.from, position.to);
  }
  return tr.scrollIntoView();
}

export function removeAttachmentReferencesTransaction(state: EditorState, attId: string): Transaction | null {
  const positions = attachmentReferencePositions(state, attId);
  if (positions.length === 0) return null;
  const tr = state.tr;
  for (const position of positions.reverse()) tr.delete(position.from, position.to);
  return tr.scrollIntoView();
}

export function insertAttachmentsTransaction(
  state: EditorState,
  items: readonly {
    attrs: AttachmentAttrs;
    pos?: number;
    range?: { start: number; end: number };
    reference: boolean;
  }[],
): Transaction | null {
  if (items.length === 0) return null;
  let working = state;
  const combined = state.tr;
  for (const item of items) {
    const range = item.range ?? (item.pos === undefined ? undefined : { start: item.pos, end: item.pos });
    const inventory = attachmentInventory(working);
    const duplicateImageReference = item.reference &&
      item.attrs.kind === 'image' &&
      (inventory.refCounts.get(item.attrs.attId) ?? 0) > 0;
    const tr = item.reference && !duplicateImageReference
      ? buildAttachmentInsertion(working, item.attrs, range)
      : working.tr;
    if (duplicateImageReference && range !== undefined && range.end > range.start) {
      tr.delete(textOffsetToPos(working.doc, range.start), textOffsetToPos(working.doc, range.end));
    }
    if (!inventory.activeIds.has(item.attrs.attId)) {
      tr.step(activateAttachmentStep(working, item.attrs.attId));
    }
    if (tr.steps.length === 0) continue;
    for (const step of tr.steps) combined.step(step);
    combined.setSelection(Selection.fromJSON(combined.doc, tr.selection.toJSON()));
    working = working.apply(tr);
  }
  return combined.steps.length === 0 ? null : combined.scrollIntoView();
}
