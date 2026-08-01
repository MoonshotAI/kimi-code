import type { TextModel } from './textModel';

export interface EditApplyInput {
  readonly path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
  readonly allow_large_delete?: boolean;
}

export type EditApplyResult =
  | { readonly ok: true; readonly rawContent: string; readonly count: number }
  | { readonly ok: false; readonly error: string };

/** Multi-line empty replacements without an explicit opt-in are refused (see #2427). */
const LARGE_DELETE_MIN_OLD_LINES = 3;

export function countEditLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

export function isOversizedEmptyDeletion(oldString: string, newString: string): boolean {
  return newString.trim().length === 0 && countEditLines(oldString) >= LARGE_DELETE_MIN_OLD_LINES;
}

function oversizedDeletionMessage(path: string): string {
  return (
    `Refusing a multi-line deletion in ${path}: new_string is empty (or whitespace-only) while ` +
    `old_string spans ${String(LARGE_DELETE_MIN_OLD_LINES)}+ lines. Read the file again, then either ` +
    `replace with the intended new content, delete fewer lines at a time, or set allow_large_delete=true ` +
    `if you intentionally want to remove that entire span.`
  );
}

function notFoundMessage(path: string): string {
  return (
    `old_string not found in ${path}, the file contents may be out of date. ` +
    `Read the full file (or a large enough region covering the edit) with the Read tool before retrying — ` +
    `do not keep retrying Edit from a short 30–50 line window.\n`
  );
}

function notUniqueMessage(path: string, count: number): string {
  return (
    `old_string is not unique in ${path} (found ${String(count)} occurrences). ` +
    'To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.'
  );
}

export class EditService {
  apply(model: TextModel, input: EditApplyInput): EditApplyResult {
    if (input.allow_large_delete !== true && isOversizedEmptyDeletion(input.old_string, input.new_string)) {
      return { ok: false, error: oversizedDeletionMessage(input.path) };
    }

    if (input.replace_all) {
      const { text, count } = model.replaceAll(input.old_string, input.new_string);
      if (count === 0) return { ok: false, error: notFoundMessage(input.path) };
      return { ok: true, rawContent: model.materialize(text), count };
    }

    const count = model.countOccurrences(input.old_string);
    if (count === 0) return { ok: false, error: notFoundMessage(input.path) };
    if (count > 1) return { ok: false, error: notUniqueMessage(input.path, count) };

    const text = model.replaceOnce(input.old_string, input.new_string);
    return { ok: true, rawContent: model.materialize(text), count: 1 };
  }
}
