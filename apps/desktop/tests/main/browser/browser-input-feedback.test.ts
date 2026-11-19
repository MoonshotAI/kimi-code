import type { WebContents } from 'electron';
import { expect, it, vi } from 'vitest';

const feedback = vi.hoisted(() => vi.fn(async (_contents: unknown, _method: string, _params: unknown, _before: boolean) => {}));
vi.mock('../../../src/main/browser/browser-control', () => ({
  browserInputScope: () => ({ run: undefined, revision: 0 }),
  isBrowserInputScopeCurrent: () => true,
  assertBrowserInputAllowed: () => {},
  showBrowserInputFeedback: feedback,
}));

import { runBrowserInput } from '../../../src/main/browser/browser-input';

it('validates the input target after asynchronous pointer feedback', async () => {
  const events: string[] = [];
  const contents = {
    isDestroyed: () => false,
    debugger: {
      on: () => {}, isAttached: () => true,
      sendCommand: async (method: string) => { if (method === 'Input.dispatchMouseEvent') events.push('dispatch'); },
    },
  } as unknown as WebContents;
  await feedback.withImplementation(async (_contents, _method, _params, before) => {
    await Promise.resolve();
    events.push(before ? 'feedback-before' : 'feedback-after');
  }, async () => {
    await runBrowserInput(contents, send => send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 30 }), undefined,
      async () => { events.push('validate'); }, async () => { events.push('target-guard'); });
  });
  expect(events.slice(events.indexOf('feedback-before'))).toEqual([
    'feedback-before', 'validate', 'target-guard', 'dispatch', 'feedback-after',
  ]);
});
