import type { WebContents } from 'electron';
import { assertBrowserInputAllowed, browserInputScope, isBrowserInputScopeCurrent, showBrowserInputFeedback } from './browser-control';
import { withBrowserDebugger, setBrowserInputActive } from './browser-debugger';

export type BrowserInputGuard = (method: string, params?: Record<string, unknown>) => Promise<void>;
export type BrowserInputSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
const pending = new WeakMap<WebContents, Promise<unknown>>();

export class BrowserInputError extends Error {
  constructor(message: string, readonly code: 'INVALID_REQUEST' | 'OPERATION_ABORTED' = 'INVALID_REQUEST') {
    super(message);
  }
}

interface KeyDescription {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text: string;
}

export function runBrowserInput<T>(contents: WebContents, work: (send: BrowserInputSend, check: () => Promise<void>) => Promise<T>, signal?: AbortSignal, validate?: () => Promise<void>, beforeSend?: BrowserInputGuard): Promise<T> {
  const controlScope = browserInputScope(contents);
  const checkAbort = (): void => {
    assertBrowserInputAllowed(contents, controlScope);
    if (signal?.aborted) throw new BrowserInputError('Browser operation was aborted.', 'OPERATION_ABORTED');
  };
  const check = async (): Promise<void> => {
    checkAbort();
    await validate?.();
    checkAbort();
  };
  const task = (pending.get(contents) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await check();
    return withBrowserDebugger(contents, async connection => {
      try {
        await setBrowserInputActive(contents, true);
        await check();
        return await work(async (method, params) => {
          const releasing = (method === 'Input.dispatchKeyEvent' && params?.['type'] === 'keyUp') ||
            (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseReleased');
          if (!releasing) {
            checkAbort();
            await showBrowserInputFeedback(contents, method, params, true);
            await check();
            if (beforeSend !== undefined) await beforeSend(method, params);
            checkAbort();
          }
          const result = await connection.sendCommand(method, params);
          if (isBrowserInputScopeCurrent(contents, controlScope)) await showBrowserInputFeedback(contents, method, params, false);
          return result;
        }, check);
      } finally {
        await setBrowserInputActive(contents, false);
      }
    });
  });
  pending.set(contents, task);
  void task.finally(() => {
    if (pending.get(contents) === task) pending.delete(contents);
  }).catch(() => undefined);
  return task;
}

const namedKeys: Record<string, [string, number, string?]> = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Backspace: ['Backspace', 8],
  Escape: ['Escape', 27], Delete: ['Delete', 46], Insert: ['Insert', 45],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  ' ': ['Space', 32, ' '],
};
const aliases: Record<string, string> = {
  Esc: 'Escape', Space: ' ', Spacebar: ' ', Return: 'Enter',
  Left: 'ArrowLeft', Up: 'ArrowUp', Right: 'ArrowRight', Down: 'ArrowDown',
};
const punctuation = [
  [';', ':', 'Semicolon', 186], ['=', '+', 'Equal', 187], [',', '<', 'Comma', 188],
  ['-', '_', 'Minus', 189], ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
  ['`', '~', 'Backquote', 192], ['[', '{', 'BracketLeft', 219],
  ['\\', '|', 'Backslash', 220], [']', '}', 'BracketRight', 221], ["'", '"', 'Quote', 222],
] as const;

const macEditingCommands: Record<string, string> = {
  a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo',
};

function keyDescription(raw: string, shift: boolean): KeyDescription {
  let key = Object.hasOwn(aliases, raw) ? aliases[raw]! : raw;
  let code = '';
  let keyCode = 0;
  let text = '';
  const named = Object.hasOwn(namedKeys, key) ? namedKeys[key] : undefined;
  if (named !== undefined) [code, keyCode, text = ''] = named;
  else if (/^[a-z]$/i.test(key)) {
    code = `Key${key.toUpperCase()}`;
    keyCode = key.toUpperCase().charCodeAt(0);
    if (shift) key = key.toUpperCase();
    text = key;
  } else if (/^[0-9]$/.test(key)) {
    code = `Digit${key}`;
    keyCode = key.charCodeAt(0);
    if (shift) key = ')!@#$%^&*('[Number(key)]!;
    text = key;
  } else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) {
    code = key;
    keyCode = 111 + Number(key.slice(1));
  } else {
    const symbol = punctuation.find(([plain, shifted]) => key === plain || key === shifted);
    const digit = ')!@#$%^&*('.indexOf(key);
    if (symbol !== undefined) {
      code = symbol[2];
      keyCode = symbol[3];
      if (shift) key = symbol[1];
    } else if (key.length === 1 && digit >= 0) {
      code = `Digit${digit}`;
      keyCode = 48 + digit;
    } else if (!/^.$/u.test(key)) {
      throw new BrowserInputError(`Unsupported browser key: ${raw}`);
    }
    text = key;
  }
  return { key, code, windowsVirtualKeyCode: keyCode, text };
}

export async function dispatchBrowserKeys(send: BrowserInputSend, keys: readonly string[]): Promise<void> {
  const modifierBits: Record<string, number> = {
    Alt: 1, Control: 2, Meta: 4, Shift: 8,
    ControlOrMeta: process.platform === 'darwin' ? 4 : 2,
  };
  let modifiers = 0;
  const ordinary: string[] = [];
  for (const key of keys) {
    if (Object.hasOwn(modifierBits, key)) modifiers |= modifierBits[key]!;
    else ordinary.push(key);
  }
  if (ordinary.length === 0) throw new BrowserInputError('A non-modifier key is required.');
  const descriptions = ordinary.map((key) => keyDescription(key, (modifiers & 8) !== 0));
  const pressed: Record<string, unknown>[] = [];
  let failure: unknown;
  try {
    for (const description of descriptions) {
      const { text, ...key } = description;
      const printable = (modifiers & 7) === 0 ? text : '';
      const edited = String(key.key).toLowerCase();
      const editing = process.platform !== 'darwin' ? undefined
        : modifiers === 4 ? macEditingCommands[edited]
        : modifiers === 12 && edited === 'z' ? 'redo'
        : undefined;
      const commands = editing === undefined ? undefined : [editing];
      pressed.push(key);
      await send('Input.dispatchKeyEvent', {
        ...key, modifiers, type: printable ? 'keyDown' : 'rawKeyDown',
        ...(printable ? { text: printable, unmodifiedText: text } : {}),
        ...(commands === undefined ? {} : { commands }),
      });
    }
  } catch (error) {
    failure = error;
  }
  for (const key of pressed.reverse()) {
    try {
      await send('Input.dispatchKeyEvent', { ...key, modifiers, type: 'keyUp' });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}
