import { freeze } from 'immer';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Step, StepMap, StepResult } from 'prosemirror-transform';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { parseBrowserCapture, parseBrowserReference, type BrowserCapture, type BrowserReference } from '@moonshot-ai/app-core/browser-reference';
import { browserReferenceNode, composerSchema } from '../../model/schema';
import { textOffsetToPos } from '../../model/positionMapping';
import { activateAttachmentStep, attachmentInventory, deactivateAttachmentStep } from '../attachment/inventory';

export interface BrowserReferenceInventory {
  references: ReadonlyMap<string, BrowserReference>;
  captures: ReadonlyMap<string, BrowserCapture>;
}

export interface BrowserReferenceInitialState {
  browserReferences?: readonly BrowserReference[];
  browserCaptures?: readonly BrowserCapture[];
}

export const browserReferenceKey = new PluginKey<BrowserReferenceInventory>('browserReferences');
const STEP_ID = 'composerBrowserReference';

export class BrowserReferenceStep extends Step {
  readonly before: BrowserReference | null;
  readonly after: BrowserReference | null;

  constructor(before: BrowserReference | null, after: BrowserReference | null) {
    super();
    this.before = before === null ? null : freeze(structuredClone(before));
    this.after = after === null ? null : freeze(structuredClone(after));
  }

  apply(doc: PMNode): StepResult {
    return StepResult.ok(doc);
  }

  override getMap(): StepMap {
    return StepMap.empty;
  }

  invert(): Step {
    return new BrowserReferenceStep(this.after, this.before);
  }

  map(): Step {
    return this;
  }

  toJSON() {
    return { stepType: STEP_ID, before: this.before, after: this.after };
  }

  static override fromJSON(_schema: Schema, raw: { before?: unknown; after?: unknown }): BrowserReferenceStep {
    const before = raw.before === null ? null : parseBrowserReference(raw.before);
    const after = raw.after === null ? null : parseBrowserReference(raw.after);
    if ((raw.before !== null && before === null) || (raw.after !== null && after === null) || (before === null && after === null) || (before !== null && after !== null && before.id !== after.id)) throw new RangeError('Invalid browser reference step');
    return new BrowserReferenceStep(before, after);
  }
}

try {
  Step.jsonID(STEP_ID, BrowserReferenceStep);
} catch (error) {
  if (!(error instanceof RangeError) || error.message !== `Duplicate use of step JSON ID ${STEP_ID}`) throw error;
  Object.defineProperty(BrowserReferenceStep.prototype, 'jsonID', { value: STEP_ID });
}

function isReferenceStep(step: Step): step is BrowserReferenceStep {
  return step instanceof BrowserReferenceStep || (step as Step & { jsonID?: string }).jsonID === STEP_ID;
}

export function activeBrowserReferenceIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type === composerSchema.nodes.browser_reference) ids.add(node.attrs.refId as string);
  });
  return ids;
}

export function browserReferenceInventory(state: EditorState): BrowserReferenceInventory {
  const inventory = browserReferenceKey.getState(state);
  if (inventory === undefined) throw new Error('Browser reference plugin is missing');
  return inventory;
}

export function createBrowserReferencePlugin(initial: BrowserReferenceInitialState = {}): Plugin<BrowserReferenceInventory> {
  return new Plugin<BrowserReferenceInventory>({
    key: browserReferenceKey,
    state: {
      init: () => ({
        references: new Map((initial.browserReferences ?? []).map((reference) => [reference.id, freeze(structuredClone(reference))])),
        captures: new Map((initial.browserCaptures ?? []).map((capture) => [capture.id, freeze(structuredClone(capture), true)])),
      }),
      apply(tr, value) {
        let references = value.references;
        let captures = value.captures;
        for (const step of tr.steps) {
          if (!isReferenceStep(step)) continue;
          const next = new Map(references);
          if (step.after !== null) next.set(step.after.id, step.after);
          else if (step.before !== null) next.delete(step.before.id);
          references = next;
        }
        const added = tr.getMeta(browserReferenceKey) as { captures: readonly BrowserCapture[] } | undefined;
        for (const capture of added?.captures ?? []) {
          if (!captures.has(capture.id)) captures = new Map(captures).set(capture.id, freeze(structuredClone(capture), true));
        }
        return references === value.references && captures === value.captures ? value : { references, captures };
      },
    },
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((tr) => tr.docChanged || tr.steps.some(isReferenceStep))) return null;
      const inventory = browserReferenceInventory(state);
      const wanted = new Set<string>();
      for (const id of activeBrowserReferenceIds(state.doc)) {
        const reference = inventory.references.get(id);
        const capture = reference === undefined ? undefined : inventory.captures.get(reference.captureId);
        if (capture?.screenshot !== undefined && (capture.target.kind === 'region' || reference?.includeScreenshot !== false)) wanted.add(capture.screenshot.attachmentId);
      }
      const assets = attachmentInventory(state);
      const tr = state.tr;
      for (const id of wanted) {
        if (!assets.activeIds.has(id)) tr.step(activateAttachmentStep(state, id));
      }
      for (const capture of inventory.captures.values()) {
        const id = capture.screenshot?.attachmentId;
        if (id === undefined || wanted.has(id) || (assets.refCounts.get(id) ?? 0) > 0) continue;
        const step = deactivateAttachmentStep(state, id);
        if (step !== null) tr.step(step);
      }
      return tr.steps.length === 0 ? null : tr;
    },
  });
}

export function insertBrowserReferenceTransaction(state: EditorState, capture: BrowserCapture, reference: BrowserReference, range?: { start: number; end: number }): Transaction {
  const normalizedCapture = parseBrowserCapture(capture);
  const normalizedReference = parseBrowserReference(reference);
  if (normalizedCapture === null || normalizedReference === null) throw new Error('Invalid browser reference data');
  capture = normalizedCapture;
  reference = normalizedReference;
  const inventory = browserReferenceInventory(state);
  if (reference.captureId !== capture.id || inventory.references.has(reference.id)) throw new Error('Invalid browser reference identity');
  const existing = inventory.captures.get(capture.id);
  if (existing !== undefined && JSON.stringify(parseBrowserCapture(existing)) !== JSON.stringify(capture)) throw new Error('Browser capture is immutable');
  const from = range === undefined ? state.selection.from : textOffsetToPos(state.doc, range.start);
  const to = range === undefined ? state.selection.to : textOffsetToPos(state.doc, range.end);
  const node = browserReferenceNode({ refId: reference.id, label: capture.label });
  const tr = state.tr.replaceWith(from, to, [node, composerSchema.text(' ')]);
  tr.step(new BrowserReferenceStep(null, reference));
  if (existing === undefined) tr.setMeta(browserReferenceKey, { captures: [capture] });
  tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize + 1));
  return tr.scrollIntoView();
}

export function updateBrowserReferenceTransaction(state: EditorState, id: string, comment: string, includeScreenshot?: boolean): Transaction | null {
  const inventory = browserReferenceInventory(state);
  const before = inventory.references.get(id);
  if (before === undefined || !activeBrowserReferenceIds(state.doc).has(id)) return null;
  const include = inventory.captures.get(before.captureId)?.target.kind === 'region' ? true : includeScreenshot ?? before.includeScreenshot;
  if ((before.comment ?? '') === comment && (before.includeScreenshot !== false) === (include !== false)) return null;
  if (comment.length > 10_000) throw new Error('Browser reference comment is too long');
  return state.tr.step(new BrowserReferenceStep(before, { ...before, comment: comment || undefined, includeScreenshot: include }));
}
