import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, test, type DesktopApp } from './fixtures/app';
import { held, messageProblems, say, type StubModel } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

interface EventLink {
  readonly drop: () => Promise<void>;
  readonly restore: () => void;
}

async function routeEvents(window: Page): Promise<EventLink> {
  let online = true;
  const live = new Set<WebSocketRoute>();
  await window.routeWebSocket(/\/api\/v1\/ws/, async (socket) => {
    if (!online) {
      await socket.close({ code: 4000, reason: 'e2e offline' });
      return;
    }
    live.add(socket);
    const server = socket.connectToServer();
    socket.onClose(async (code, reason) => {
      live.delete(socket);
      await server.close({ code, reason }).catch(() => undefined);
    });
    server.onClose(async (code, reason) => {
      live.delete(socket);
      await socket.close({ code, reason }).catch(() => undefined);
    });
  });
  return {
    drop: async () => {
      online = false;
      await Promise.all([...live].map(socket => socket.close({ code: 4000, reason: 'e2e drop' })));
      live.clear();
    },
    restore: () => { online = true; },
  };
}

async function expectSettled(app: DesktopApp, reply: string): Promise<void> {
  const transcript = app.window.getByRole('list').first();
  await expect(transcript.getByText(reply, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  await expect(app.window.getByRole('status').filter({ hasText: /Working…|Requesting…/ })).toHaveCount(0);
  await expect(sidebarOf(app).getByRole('status', { name: 'Loading' })).toHaveCount(0);
  await expect(app.window.getByText(/waiting to send/)).toHaveCount(0);
}

async function expectSentOnce(model: StubModel, from: number, prompt: string, queued: string): Promise<void> {
  const requests = model.requests().slice(from);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.userTextsSinceReply).toEqual([prompt]);
  expect(requests[1]!.userTextsSinceReply).toEqual([queued]);
  for (const request of requests) expect(messageProblems(request.messages)).toEqual([]);
  expect(requests[1]!.texts('user').filter(text => text.includes(queued))).toHaveLength(1);
  expect(requests[1]!.texts('user').filter(text => text.includes(prompt))).toHaveLength(1);
}

async function queuePrompt(app: DesktopApp, prompt: string): Promise<void> {
  await app.window.getByRole('combobox', { name: 'Message input' }).click();
  await app.window.keyboard.type(prompt);
  await app.window.keyboard.press('ControlOrMeta+Enter');
}

test('a turn that finishes while the renderer is disconnected settles on reconnect and its queue runs once', async ({ app, model }) => {
  const link = await routeEvents(app.window);
  await app.window.reload();
  await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
  const transcript = app.window.getByRole('list').first();
  const sidebarBusy = sidebarOf(app).getByRole('status', { name: 'Loading' });

  const first = model.hold('first');
  model.script(held('first', say(['Indexing the ', 'repository now.']), 1), say('Tests are listed.'));
  const firstRequest = await app.startTurn('Index the repository');
  await first.reached();
  await expect(transcript.getByText('Indexing the', { exact: true })).toBeVisible();
  await expect(sidebarBusy).toHaveCount(1);
  await queuePrompt(app, 'Then list the tests');
  await expect(app.window.getByText('1 waiting to send')).toBeVisible();

  await link.drop();
  first.release();
  await expect.poll(() => firstRequest.finished, { message: 'waiting for the held reply to finish while disconnected' }).toBe(true);
  expect(model.requests()).toHaveLength(1);
  link.restore();

  await expectSettled(app, 'Tests are listed.');
  await expect(transcript.getByText('Indexing the repository now.', { exact: true })).toBeVisible();
  await expectSentOnce(model, 0, 'Index the repository', 'Then list the tests');
  await expect(transcript.getByText('Then list the tests', { exact: true })).toHaveCount(1);

  const second = model.hold('second');
  model.script(held('second', say(['Reading the ', 'changelog now.']), 1), say('The summary is ready.'));
  const secondRequest = await app.startTurn('Read the changelog');
  await second.reached();
  await expect(transcript.getByText('Reading the', { exact: true })).toBeVisible();

  await link.drop();
  await app.window.reload();
  await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
  await queuePrompt(app, 'Then summarize it');
  await expect(app.window.getByText('1 waiting to send')).toBeVisible();
  second.release();
  await expect.poll(() => secondRequest.finished, { message: 'waiting for the held reply to finish while reloading' }).toBe(true);
  expect(model.requests()).toHaveLength(3);
  link.restore();

  const reloaded = app.window.getByRole('list').first();
  await expectSettled(app, 'The summary is ready.');
  await expect(reloaded.getByText('Reading the changelog now.', { exact: true })).toBeVisible();
  await expectSentOnce(model, 2, 'Read the changelog', 'Then summarize it');
  for (const prompt of ['Index the repository', 'Then list the tests', 'Read the changelog', 'Then summarize it']) {
    await expect(reloaded.getByText(prompt, { exact: true })).toHaveCount(1);
  }
  expect(model.requests()).toHaveLength(4);
  expect(model.aborts()).toBe(0);
  await expect(app.window.getByRole('alert')).toHaveCount(0);
});
