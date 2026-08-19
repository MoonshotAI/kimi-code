import {
  type LineEndingStyle,
  materializeModelText,
  toModelTextView,
} from '#/_base/text/line-endings';

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
