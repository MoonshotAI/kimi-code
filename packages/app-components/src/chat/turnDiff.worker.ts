import { buildWholeFileDiffLines, type WholeFileDiffUnavailable } from '@moonshot-ai/app-core/client';
import type { DiffViewLine } from '@moonshot-ai/app-core/client/types';

export interface TurnDiffResult {
  lines: DiffViewLine[] | null;
  unavailable?: WholeFileDiffUnavailable;
}

self.onmessage = (event: MessageEvent<{ before: string; after: string }>) => {
  let unavailable: WholeFileDiffUnavailable | undefined;
  const lines = buildWholeFileDiffLines(event.data.before, event.data.after, (detail) => { unavailable = detail; }, 20_000);
  self.postMessage({ lines, unavailable } satisfies TurnDiffResult);
};
