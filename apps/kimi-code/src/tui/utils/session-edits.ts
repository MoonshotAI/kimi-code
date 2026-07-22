/**
 * Collect file edits performed by the AI in the current session.
 *
 * Scans transcript entries for `Edit`/`Write` tool calls (and any tool whose
 * display is already a diff), returning the before/after snippets so the
 * `/diff` command can render them independently of git.
 */

import type { ToolInputDisplay } from '@moonshot-ai/kimi-code-sdk';

import type { TranscriptEntry } from '../types';

interface ToolCallViewLike {
  toolCallView?: {
    turnId?: string;
    display?: ToolInputDisplay;
  };
}

export interface SessionEdit {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export interface SessionEditWithTurn {
  readonly turnId: string | undefined;
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

function isFileIoDisplay(display: ToolInputDisplay): display is Extract<
  ToolInputDisplay,
  { kind: 'file_io' }
> {
  return display.kind === 'file_io';
}

function isDiffDisplay(display: ToolInputDisplay): display is Extract<
  ToolInputDisplay,
  { kind: 'diff' }
> {
  return display.kind === 'diff';
}

function extractEditsFromDisplay(display: ToolInputDisplay | undefined): SessionEdit[] {
  if (display === undefined) return [];

  if (isFileIoDisplay(display)) {
    if (display.operation === 'edit') {
      const before = display.before ?? '';
      const after = display.after ?? '';
      if (before !== after && display.path.length > 0) {
        return [{ path: display.path, before, after }];
      }
    } else if (display.operation === 'write') {
      const content = display.content ?? '';
      if (display.path.length > 0) {
        return [{ path: display.path, before: '', after: content }];
      }
    }
  } else if (isDiffDisplay(display)) {
    if (display.path.length > 0) {
      return [{ path: display.path, before: display.before, after: display.after }];
    }
  }
  return [];
}

function extractEditsWithTurnFromEntry(entry: TranscriptEntry): SessionEditWithTurn[] {
  return extractEditsFromDisplay(entry.toolCallData?.display).map((edit) => ({
    ...edit,
    turnId: entry.turnId,
  }));
}

function extractEditsWithTurnFromComponent(component: unknown): SessionEditWithTurn[] {
  const view = (component as ToolCallViewLike).toolCallView;
  if (view === undefined) return [];
  const turnId = view.turnId;
  return extractEditsFromDisplay(view.display).map((edit) => ({
    ...edit,
    turnId,
  }));
}

function editKey(edit: SessionEdit, turnId: string | undefined): string {
  return `${turnId ?? ''}:${edit.path}:${edit.before}:${edit.after}`;
}

export function collectSessionEditsByTurn(
  entries: readonly TranscriptEntry[],
  components?: readonly unknown[],
): readonly SessionEditWithTurn[] {
  const seen = new Set<string>();
  const edits: SessionEditWithTurn[] = [];
  for (const entry of entries) {
    for (const edit of extractEditsWithTurnFromEntry(entry)) {
      const key = editKey(edit, edit.turnId);
      if (seen.has(key)) continue;
      seen.add(key);
      edits.push(edit);
    }
  }
  if (components !== undefined) {
    for (const component of components) {
      for (const edit of extractEditsWithTurnFromComponent(component)) {
        const key = editKey(edit, edit.turnId);
        if (seen.has(key)) continue;
        seen.add(key);
        edits.push(edit);
      }
    }
  }
  return edits;
}


