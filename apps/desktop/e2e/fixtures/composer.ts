import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

import { stubModelConfig } from './model';

export interface ExtraModel {
  readonly id: string;
  readonly provider?: string;
  readonly model: string;
  readonly displayName: string;
  readonly capabilities?: readonly string[];
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly offEffort?: string;
}

export const providerBaseUrl = (baseUrl: string, provider: string): string =>
  provider === 'e2e' ? baseUrl : baseUrl.replace(/\/v1$/, `/${provider}/v1`);
export const providerApiKey = (provider: string): string => `sk-${provider}`;

export function multiModelConfig(baseUrl: string, models: readonly ExtraModel[]): string {
  const providers = [...new Set(models.map(entry => entry.provider ?? 'e2e'))].filter(name => name !== 'e2e');
  const providerBlocks = providers.flatMap(name => [`[providers.${name}]`, 'type = "openai"', `base_url = "${providerBaseUrl(baseUrl, name)}"`, `api_key = "${providerApiKey(name)}"`, '']);
  const extra = models.flatMap(entry => [
    `[models."${entry.id}"]`,
    `provider = "${entry.provider ?? 'e2e'}"`,
    `model = "${entry.model}"`,
    `display_name = "${entry.displayName}"`,
    'max_context_size = 128000',
    ...(entry.capabilities === undefined ? [] : [`capabilities = [${entry.capabilities.map(value => `"${value}"`).join(', ')}]`]),
    ...(entry.efforts === undefined ? [] : [`support_efforts = [${entry.efforts.map(value => `"${value}"`).join(', ')}]`]),
    ...(entry.defaultEffort === undefined ? [] : [`default_effort = "${entry.defaultEffort}"`]),
    ...(entry.offEffort === undefined ? [] : [`off_effort = "${entry.offEffort}"`]),
    '',
  ]);
  return [stubModelConfig(baseUrl), ...providerBlocks, ...extra].join('\n');
}

export async function writeModelConfig(home: string, baseUrl: string, models: readonly ExtraModel[]): Promise<void> {
  await writeFile(join(home, 'config.toml'), multiModelConfig(baseUrl, models));
}

export async function pasteImage(window: Page, name: string, colors: readonly [string, string]): Promise<Buffer> {
  const bytes = await window.evaluate(async ([fileName, outer, inner]) => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    const context = canvas.getContext('2d')!;
    context.fillStyle = outer;
    context.fillRect(0, 0, 120, 80);
    context.fillStyle = inner;
    context.fillRect(30, 20, 60, 40);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], fileName, { type: 'image/png' }));
    const input = document.querySelector('[aria-label="Message input"]');
    if (input === null) throw new Error('The composer input is not mounted');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, [name, colors[0], colors[1]] as const);
  return Buffer.from(bytes);
}

export async function dropTextFile(window: Page, name: string, content: string): Promise<void> {
  await window.evaluate(([fileName, body]) => {
    const data = new DataTransfer();
    data.items.add(new File([body], fileName, { type: 'text/plain' }));
    const target = document.querySelector('[aria-label="Message input"]')?.closest('.composer');
    if (target === null || target === undefined) throw new Error('The composer is not mounted');
    const box = target.getBoundingClientRect();
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, clientX: box.x + box.width / 2, clientY: box.y + box.height - 20 }));
    }
  }, [name, content] as const);
}
