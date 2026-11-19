import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserFocusRequest } from '../../src/renderer/lib/browserFocusRequest';

afterEach(() => vi.unstubAllGlobals());

it.each(['pointerdown', 'keydown', 'blur', 'hidden', 'dispose', 'none'] as const)('respects %s while native focus is pending', async (action) => {
  const doc = Object.assign(new EventTarget(), { hasFocus: () => true });
  const win = new EventTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  const request = createBrowserFocusRequest();
  const focus = vi.fn();
  let visible = true;
  let finish!: () => void;
  const pending = request.run(() => new Promise<void>((done) => { finish = done; }), focus, () => visible);
  if (action === 'pointerdown' || action === 'keydown') doc.dispatchEvent(new Event(action));
  else if (action === 'blur') win.dispatchEvent(new Event('blur'));
  else if (action === 'hidden') visible = false;
  else if (action === 'dispose') request.cancel();
  finish();
  await pending;
  expect(focus).toHaveBeenCalledTimes(action === 'none' ? 1 : 0);
});
