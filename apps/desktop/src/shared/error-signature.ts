const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]+/gi;
const PATH_PATTERN = /(?:[a-z]:)?(?:[\\/][^\s\\/'"`():]+){2,}/gi;
const ID_PATTERN = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,})\b/gi;
const NUMBER_PATTERN = /\d+/g;
const FRAME_PATTERN = /\(?([^\s()]+):(\d+):(\d+)\)?$/;
const MAX_MESSAGE_CHARS = 200;
const MAX_FRAME_CHARS = 64;

export interface ErrorSignature {
  fingerprint: string;
  topFrame: string | null;
}

export function normalizeErrorMessage(message: string): string {
  return message
    .replace(URL_PATTERN, '<url>')
    .replace(PATH_PATTERN, '<path>')
    .replace(ID_PATTERN, '<id>')
    .replace(NUMBER_PATTERN, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

export function topStackFrame(stack: string | undefined): string | null {
  if (stack === undefined) return null;
  for (const line of stack.split('\n')) {
    const frame = line.trim();
    if (!frame.startsWith('at ')) continue;
    const match = FRAME_PATTERN.exec(frame);
    if (match === null) continue;
    const location = match[1] ?? '';
    if (location.startsWith('node:')) continue;
    const file = location.split(/[?#]/)[0]?.split(/[\\/]/).pop() ?? location;
    return `${file}:${match[2]}:${match[3]}`.slice(0, MAX_FRAME_CHARS);
  }
  return null;
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function errorSignature(name: string, message: string, stack?: string): ErrorSignature {
  const topFrame = topStackFrame(stack);
  return {
    fingerprint: fnv1a(`${name}|${normalizeErrorMessage(message)}|${topFrame ?? ''}`),
    topFrame,
  };
}

export function signatureOf(value: unknown): ErrorSignature & { name: string } {
  if (value instanceof Error) {
    return { name: value.name, ...errorSignature(value.name, value.message, value.stack) };
  }
  const name = typeof value;
  let message: string;
  try {
    message = String(value);
  } catch {
    message = '';
  }
  return { name, ...errorSignature(name, message) };
}
