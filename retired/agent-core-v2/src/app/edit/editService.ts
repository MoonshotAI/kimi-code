/**
 * `edit` domain — {@link EditService}, the business rules of an edit.
 *
 * Owns the `old_string` uniqueness rule, the `replace_all` path, and the
 * user-facing error messages. Operates on a {@link TextModel} (pure text) and
 * returns a discriminated result: either the re-materialized raw content plus
 * the replacement count, or a ready-to-surface error message. No IO —
 * `FileEditService` handles reading/writing and no-op pre-checks.
 */

import type { TextModel } from './textModel';

export interface EditApplyInput {
  readonly path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
}

export type EditApplyResult =
  | { readonly ok: true; readonly rawContent: string; readonly count: number }
  | { readonly ok: false; readonly error: string };

function notFoundMessage(path: string): string {
  return `old_string not found in ${path}, the file contents may be out of date. Please use the Read Tool to reload the content.
`;
}

function notUniqueMessage(path: string, count: number): string {
  return (
    `old_string is not unique in ${path} (found ${String(count)} occurrences). ` +
    'To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.'
  );
}

export class EditService {
  apply(model: TextModel, input: EditApplyInput): EditApplyResult {
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
