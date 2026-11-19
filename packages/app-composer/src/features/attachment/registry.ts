

import { Plugin, PluginKey } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { composerSchema, type AttachmentAttrs } from '../../model';
import type { AttachmentEntry } from './entry';
import { attachmentInventoryKey, isAttachmentInventoryStep } from './inventory';

export {
  attachmentKeyFor,
  newAttId,
  normalizeAttachmentPath,
  serializableAttachmentEntry,
  type AttachmentEntry,
} from './entry';

export const attachmentRegistryKey = new PluginKey<Map<string, AttachmentEntry>>('composerAttachmentRegistry');

export function orderedDocAttachments(doc: PMNode): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  doc.descendants((node) => {
    if (node.type !== composerSchema.nodes.attachment) return true;
    const attId = (node.attrs as AttachmentAttrs).attId;
    if (!seen.has(attId)) {
      seen.add(attId);
      ordered.push(attId);
    }
    return false;
  });
  return ordered;
}

export function countDocAttachments(doc: PMNode): Map<string, number> {
  const counts = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type !== composerSchema.nodes.attachment) return true;
    const attId = (node.attrs as AttachmentAttrs).attId;
    counts.set(attId, (counts.get(attId) ?? 0) + 1);
    return false;
  });
  return counts;
}

function reconcileRegistry(
  entries: Map<string, AttachmentEntry>,
  counts: ReadonlyMap<string, number>,
  activeIds: ReadonlySet<string>,
  onEntryDropped?: (entry: AttachmentEntry) => void,
): Map<string, AttachmentEntry> {
  let changed = false;
  const next = new Map<string, AttachmentEntry>();
  for (const [attId, entry] of entries) {
    const count = counts.get(attId);
    if (count === undefined) {
      if (activeIds.has(attId)) {
        if (entry.refCount === 0) next.set(attId, entry);
        else {
          next.set(attId, { ...entry, refCount: 0 });
          changed = true;
        }
        continue;
      }
      changed = true;

      if (entry.previewUrl !== undefined) onEntryDropped?.(entry);
      continue;
    }
    if (count !== entry.refCount) {
      next.set(attId, { ...entry, refCount: count });
      changed = true;
    } else {
      next.set(attId, entry);
    }
  }
  return changed ? next : entries;
}

export type AttachmentRegistryCommand =
  | { type: 'upsert'; entry: AttachmentEntry }
  | { type: 'patch'; attId: string; patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>> };

function applyRegistryCommand(
  entries: Map<string, AttachmentEntry>,
  command: AttachmentRegistryCommand,
  onEntryDropped?: (entry: AttachmentEntry) => void,
): Map<string, AttachmentEntry> {
  if (command.type === 'upsert') {
    const next = new Map(entries);
    const existing = next.get(command.entry.attId);

    if (existing?.previewUrl !== undefined && existing.previewUrl !== command.entry.previewUrl) {
      onEntryDropped?.(existing);
    }
    next.set(command.entry.attId, { ...command.entry, refCount: existing ? existing.refCount : 0 });
    return next;
  }
  const existing = entries.get(command.attId);
  if (!existing) return entries;
  if (
    'previewUrl' in command.patch &&
    existing.previewUrl !== undefined &&
    existing.previewUrl !== command.patch.previewUrl
  ) {
    onEntryDropped?.(existing);
  }
  const next = new Map(entries);
  next.set(command.attId, { ...existing, ...command.patch });
  return next;
}

export interface AttachmentRegistryPluginOptions {

  initialEntries?: AttachmentEntry[];

  onEntryDropped?: (entry: AttachmentEntry) => void;
}

export function createAttachmentRegistryPlugin(options?: AttachmentRegistryPluginOptions): Plugin {
  return new Plugin<Map<string, AttachmentEntry>>({
    key: attachmentRegistryKey,
    state: {
      init(_config, state) {
        const entries = new Map<string, AttachmentEntry>();
        for (const entry of options?.initialEntries ?? []) entries.set(entry.attId, entry);
        const activeIds = attachmentInventoryKey.getState(state)?.activeIds ?? new Set<string>();
        return reconcileRegistry(entries, countDocAttachments(state.doc), activeIds, options?.onEntryDropped);
      },
      apply(tr, value, _oldState, newState) {
        let entries = value;

        const meta = tr.getMeta(attachmentRegistryKey) as
          | AttachmentRegistryCommand
          | AttachmentRegistryCommand[]
          | undefined;
        if (meta) {
          for (const command of Array.isArray(meta) ? meta : [meta]) {
            entries = applyRegistryCommand(entries, command, options?.onEntryDropped);
          }
        }
        if (tr.docChanged || tr.steps.some(isAttachmentInventoryStep)) {
          const activeIds = attachmentInventoryKey.getState(newState)?.activeIds ?? new Set<string>();
          entries = reconcileRegistry(entries, countDocAttachments(newState.doc), activeIds, options?.onEntryDropped);
        }
        return entries;
      },
    },
  });
}
