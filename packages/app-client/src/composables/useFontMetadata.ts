import { shallowRef } from 'vue';
import { getLocalFontFace } from '@moonshot-ai/app-core';
import { readFontMetadata, type FontMetadata } from '@moonshot-ai/app-core/lib';

export interface FontMetadataEntry {
  status: 'loading' | 'ready' | 'unavailable';
  metadata?: FontMetadata;
  face?: string;
}

const fontMetadata = shallowRef<Record<string, FontMetadataEntry>>({});
const pending = new Map<string, Promise<void>>();
const queue: { family: string; run: () => Promise<void>; cancel: () => void }[] = [];
const kept = new Set<string>();
let active = 0;

function pump(): void {
  while (active < 2 && queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    active++;
    void job.run().finally(() => { active--; pump(); });
  }
}

export function useFontMetadata() {
  function request(family: string, priority: boolean, keep: boolean): Promise<void> {
    if (keep) kept.add(family);
    const existing = pending.get(family);
    if (existing) {
      const index = queue.findIndex((job) => job.family === family);
      if (priority && index > 0) {
        const [job] = queue.splice(index, 1);
        if (job) queue.unshift(job);
      }
      return existing;
    }
    if (fontMetadata.value[family]) return Promise.resolve();
    const face = getLocalFontFace(family);
    if (!face) return Promise.resolve();
    fontMetadata.value = { ...fontMetadata.value, [family]: { status: 'loading' } };
    const promise = new Promise<void>((resolve) => {
      const cancel = () => {
        pending.delete(family);
        const next = { ...fontMetadata.value };
        delete next[family];
        fontMetadata.value = next;
        resolve();
      };
      const run = async () => {
        try {
          if (!face.blob) throw new Error('Font data is unavailable');
          const metadata = await readFontMetadata(await face.blob(), face.postscriptName);
          fontMetadata.value = { ...fontMetadata.value, [family]: { status: 'ready', metadata, face: face.postscriptName } };
        } catch {
          fontMetadata.value = { ...fontMetadata.value, [family]: { status: 'unavailable' } };
        } finally {
          pending.delete(family);
          resolve();
        }
      };
      if (priority) queue.unshift({ family, run, cancel });
      else queue.push({ family, run, cancel });
    });
    pending.set(family, promise);
    pump();
    return promise;
  }

  function ensureFontMetadata(family: string, priority = true): Promise<void> {
    return request(family, priority, true);
  }

  function previewFontMetadata(family: string): Promise<void> {
    return request(family, true, false);
  }

  function releaseFontMetadata(family: string): void {
    if (kept.has(family)) return;
    const index = queue.findIndex((job) => job.family === family);
    if (index < 0) return;
    const [job] = queue.splice(index, 1);
    job?.cancel();
  }

  return { fontMetadata, ensureFontMetadata, previewFontMetadata, releaseFontMetadata };
}
