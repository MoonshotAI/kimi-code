import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Locator, type Page } from '@playwright/test';

import { textOf, withoutReminders, type ChatMessage } from './model';

export interface RecordedRequest {
  readonly index: number;
  readonly model: string;
  readonly body: Record<string, unknown>;
  readonly withTools: boolean;
  readonly lastUserText: string;
  readonly authorization: string | undefined;
}

export interface RecordingModel {
  readonly baseUrl: string;
  readonly requests: () => readonly RecordedRequest[];
  readonly turns: () => readonly RecordedRequest[];
  readonly sideRequests: () => readonly RecordedRequest[];
  readonly waitForTurn: (index: number, timeoutMs?: number) => Promise<RecordedRequest>;
  readonly close: () => Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function chunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-rec', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

export async function startRecordingModel(options: { apiKey: string; models: readonly string[]; reply: (prompt: string) => string; sideReply: string }): Promise<RecordingModel> {
  const records: RecordedRequest[] = [];
  const unauthorized: string[] = [];
  const waiters = new Set<() => void>();
  const server = createServer((request, response) => {
    void readBody(request).then((raw) => {
      if (request.headers.authorization !== `Bearer ${options.apiKey}`) {
        unauthorized.push(`${request.method ?? '?'} ${request.url ?? '?'} with Authorization ${JSON.stringify(request.headers.authorization ?? null)}`);
        response.writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } }));
        for (const wake of waiters) wake();
        return;
      }
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ object: 'list', data: options.models.map(id => ({ id, object: 'model', owned_by: 'e2e' })) }));
        return;
      }
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      const messages = (body['messages'] ?? []) as ChatMessage[];
      const withTools = Array.isArray(body['tools']) && body['tools'].length > 0;
      const userTexts = messages.filter(message => message.role === 'user').map(message => withoutReminders(textOf(message.content))).filter(text => text !== '');
      const record: RecordedRequest = {
        index: records.length,
        model: String(body['model']),
        body,
        withTools,
        lastUserText: userTexts.at(-1) ?? '',
        authorization: request.headers.authorization,
      };
      records.push(record);
      for (const wake of waiters) wake();
      const text = withTools ? options.reply(record.lastUserText) : options.sideReply;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(chunk(record.model, { role: 'assistant', content: text }));
      response.write(chunk(record.model, {}, 'stop'));
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-rec', object: 'chat.completion.chunk', created: 0, model: record.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const turns = (): RecordedRequest[] => records.filter(record => record.withTools);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => [...records],
    turns,
    sideRequests: () => records.filter(record => !record.withTools),
    waitForTurn: (index, timeoutMs = 30_000) => new Promise<RecordedRequest>((resolve, reject) => {
      const check = (): void => {
        if (unauthorized.length > 0) {
          clearTimeout(timer);
          waiters.delete(check);
          reject(new Error(`The recording model rejected ${unauthorized.length} request(s) without the configured API key: ${unauthorized.join('; ')}`));
          return;
        }
        const found = turns()[index];
        if (found === undefined) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`The recording model received ${turns().length} turn request(s); expected #${index}`));
      }, timeoutMs);
      waiters.add(check);
      check();
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(() => {
        if (unauthorized.length === 0) resolve();
        else reject(new Error(`The recording model rejected ${unauthorized.length} request(s) without the configured API key: ${unauthorized.join('; ')}`));
      });
    }),
  };
}

export async function openSettings(window: Page, tab?: string): Promise<Locator> {
  const dialog = window.getByRole('dialog', { name: /^(Settings|设置)$/ });
  if (!await dialog.isVisible()) await window.keyboard.press('ControlOrMeta+,');
  await expect(dialog).toBeVisible();
  if (tab !== undefined) {
    const button = dialog.getByRole('tablist').first().getByRole('tab', { name: tab, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-selected', 'true');
  }
  return dialog;
}

export async function closeSettings(window: Page): Promise<void> {
  const dialog = window.getByRole('dialog', { name: /^(Settings|设置)$/ });
  await dialog.getByRole('button', { name: /^(Close \(Esc\)|关闭 \(Esc\))$/ }).click();
  await expect(dialog).toBeHidden();
}

export async function chooseOption(window: Page, combobox: Locator, option: string | RegExp): Promise<void> {
  await combobox.click();
  const listbox = window.getByRole('listbox');
  await expect(listbox).toBeVisible();
  await listbox.getByRole('option', { name: option }).click();
  await expect(listbox).toBeHidden();
}
