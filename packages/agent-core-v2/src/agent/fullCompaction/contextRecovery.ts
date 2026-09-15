import { renderPrompt } from '#/_base/utils/render-prompt';
import type { WireLineRange } from '#/wire/record';

import contextRecoveryTemplate from './context-recovery-footer.md?raw';

export const CONTEXT_RECOVERY_HEADING = '## Context Recovery';

export interface ContextRecoveryPointer {
  readonly journalPath: string;
  readonly windows: readonly WireLineRange[];
}

export function renderContextRecoveryPointer(pointer: ContextRecoveryPointer): string {
  const windows = pointer.windows;
  const summarized = windows.length - 1;
  const lines = windows.map((range, index) => {
    const label = `window ${String(index + 1)}: lines ${String(range.start)}–${String(range.end)}`;
    return index === summarized ? `${label}   ← the conversation this note summarizes` : label;
  });
  const nextStart = windows[summarized]!.end + 1;
  lines.push(
    `window ${String(windows.length + 1)} (the one you are in now) starts at line ${String(nextStart)} with the \`context.apply_compaction\` record that carries this note — it is already in your context; no need to read it.`,
  );
  return renderPrompt(contextRecoveryTemplate, {
    wire_path: pointer.journalPath,
    window_lines: lines.map((line) => `  ${line}`).join('\n'),
  }).trimEnd();
}
