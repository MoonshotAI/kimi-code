import { IBlobStore } from '@moonshot-ai/agent-core-v2';
import type { AgentTranscriptSnapshot, TranscriptFrame, TranscriptItem } from '@moonshot-ai/transcript';

import type { ContextRecord } from '../wireRecords';

interface FileBlobRef {
  readonly key: string;
  readonly bytes: number;
}

interface ResolvedFileEdit {
  readonly path: string;
  readonly before?: string | null;
  readonly after?: string;
  readonly truncated?: boolean;
}

function parseBlobRef(value: unknown): FileBlobRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const key = (value as { key?: unknown }).key;
  const bytes = (value as { bytes?: unknown }).bytes;
  if (typeof key !== 'string' || typeof bytes !== 'number') return undefined;
  return { key, bytes };
}

async function readBlobText(blobs: IBlobStore, scope: string, ref: FileBlobRef): Promise<string | undefined> {
  const data = await blobs.get(scope, ref.key);
  return data === undefined ? undefined : Buffer.from(data).toString('utf8');
}

async function resolveBefore(
  blobs: IBlobStore,
  scope: string,
  beforeValue: unknown,
): Promise<string | null | undefined> {
  if (beforeValue === null) return null;
  const ref = parseBlobRef(beforeValue);
  return ref === undefined ? undefined : readBlobText(blobs, scope, ref);
}

async function resolveRecord(
  blobs: IBlobStore,
  scope: string,
  record: ContextRecord,
): Promise<ResolvedFileEdit | undefined> {
  const path = record['path'];
  if (typeof path !== 'string') return undefined;
  if (record['truncated'] === true) return { path, truncated: true };

  const afterRef = parseBlobRef(record['after']);
  if (afterRef === undefined) return undefined;
  const [before, after] = await Promise.all([
    resolveBefore(blobs, scope, record['before']),
    readBlobText(blobs, scope, afterRef),
  ]);
  if (after === undefined) return undefined;
  return { path, before, after };
}

function patchFrames(
  items: readonly TranscriptItem[],
  resolvedByToolCallId: ReadonlyMap<string, ResolvedFileEdit>,
): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind !== 'turn') return item;
    let turnChanged = false;
    const steps = item.steps.map((step) => {
      let stepChanged = false;
      const frames = step.frames.map((frame): TranscriptFrame => {
        if (frame.kind !== 'tool') return frame;
        const resolved = resolvedByToolCallId.get(frame.toolCallId);
        if (resolved === undefined) return frame;
        stepChanged = true;
        return { ...frame, edit: resolved };
      });
      if (!stepChanged) return step;
      turnChanged = true;
      return { ...step, frames };
    });
    if (!turnChanged) return item;
    return { ...item, steps };
  });
}

export async function resolveColdFileEditSnapshots(
  snapshot: AgentTranscriptSnapshot,
  records: readonly ContextRecord[],
  blobs: IBlobStore,
  scope: string,
): Promise<AgentTranscriptSnapshot> {
  const candidates = records.filter(
    (record): record is ContextRecord & { toolCallId: string } =>
      record.type === 'file.edit_snapshot.recorded' && typeof record['toolCallId'] === 'string',
  );
  if (candidates.length === 0) return snapshot;

  const resolvedByToolCallId = new Map<string, ResolvedFileEdit>();
  for (const record of candidates) {
    const resolved = await resolveRecord(blobs, scope, record);
    if (resolved !== undefined) resolvedByToolCallId.set(record.toolCallId, resolved);
  }
  if (resolvedByToolCallId.size === 0) return snapshot;

  return { ...snapshot, items: patchFrames(snapshot.items, resolvedByToolCallId) };
}
