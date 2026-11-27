import { decodeKittyPrintable } from '@moonshot-ai/pi-tui';

export function printableChar(data: string): string {
  return decodeKittyPrintable(data) ?? data;
}

export function isPrintableChar(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.codePointAt(0)!;
  return code >= 0x20 && code !== 0x7f;
}
