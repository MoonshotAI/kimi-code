import { readFile, writeFile } from 'node:fs/promises';

import {
  type LineEndingStyle,
  materializeModelText,
  toModelTextView,
} from './line-endings';

export class TextModel {
  readonly lineEndingStyle: LineEndingStyle;
  readonly text: string;

  constructor(raw: string) {
    const view = toModelTextView(raw);
    this.text = view.text;
    this.lineEndingStyle = view.lineEndingStyle;
  }

  countOccurrences(needle: string): number {
    let count = 0;
    let pos = 0;
    while (pos < this.text.length) {
      const idx = this.text.indexOf(needle, pos);
      if (idx === -1) break;
      count += 1;
      pos = idx + needle.length;
    }
    return count;
  }

  replaceOnce(needle: string, replacement: string): string {
    const index = this.text.indexOf(needle);
    if (index === -1) return this.text;
    return this.text.slice(0, index) + replacement + this.text.slice(index + needle.length);
  }

  replaceAll(needle: string, replacement: string): { text: string; count: number } {
    const parts = this.text.split(needle);
    return { text: parts.join(replacement), count: parts.length - 1 };
  }

  materialize(modelText: string): string {
    return materializeModelText(modelText, this.lineEndingStyle);
  }
}

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
  return `old_string not found in ${path}, the file contents may be out of date. Please use the Read Tool to reload the content.\n`;
}

function notUniqueMessage(path: string, count: number): string {
  return (
    `old_string is not unique in ${path} (found ${String(count)} occurrences). ` +
    'To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.'
  );
}

export function applyEdit(model: TextModel, input: EditApplyInput): EditApplyResult {
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

export interface EditFileInput {
  readonly path: string;
  readonly displayPath: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
}

export type EditFileResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly error: string };

export async function editFile(input: EditFileInput): Promise<EditFileResult> {
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(input.path));
    const model = new TextModel(raw);
    const result = applyEdit(model, {
      path: input.displayPath,
      old_string: input.old_string,
      new_string: input.new_string,
      replace_all: input.replace_all,
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    await writeFile(input.path, result.rawContent);
    return { ok: true, count: result.count };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'EISDIR') {
      return { ok: false, error: `${input.displayPath} is not a file.` };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
