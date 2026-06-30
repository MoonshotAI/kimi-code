/**
 * Prompt-RPC image compression — the single ingestion chokepoint.
 *
 * Every client transport (CLI, web, desktop, ACP, SDK) submits prompts through
 * the `prompt` / `steer` RPC. This pins that an oversized image handed to that
 * RPC is downsampled before it is recorded into history (and therefore before
 * it is sent to the model), with a normal image left untouched.
 */

import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';

import type { ContentPart } from '@moonshot-ai/kosong';

import { sniffImageDimensions } from '../../src/tools/support/file-type';
import { testAgent } from './harness/agent';

async function pngDataUrl(width: number, height: number): Promise<string> {
  const buf = await new Jimp({ width, height, color: 0x3366ccff }).getBuffer('image/png');
  return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
}

function lastUserImagePart(history: readonly { role: string; content: readonly ContentPart[] }[]) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    if (message.role !== 'user') continue;
    const image = message.content.find((part) => part.type === 'image_url');
    if (image?.type === 'image_url') return image;
  }
  return undefined;
}

describe('prompt RPC image compression', () => {
  it('downsamples an oversized image submitted through the prompt RPC', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'ok' });

    const url = await pngDataUrl(2600, 2600);
    await ctx.rpc.prompt({
      input: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image_url', imageUrl: { url } },
      ],
    });
    await ctx.untilTurnEnd();

    const image = lastUserImagePart(ctx.agent.context.history);
    expect(image).toBeDefined();
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(image!.imageUrl.url);
    expect(match).not.toBeNull();
    const dims = sniffImageDimensions(Buffer.from(match![2]!, 'base64'));
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(2000);
  });

  it('leaves a within-budget image untouched', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'ok' });

    const url = await pngDataUrl(48, 48);
    await ctx.rpc.prompt({ input: [{ type: 'image_url', imageUrl: { url } }] });
    await ctx.untilTurnEnd();

    const image = lastUserImagePart(ctx.agent.context.history);
    expect(image?.imageUrl.url).toBe(url);
  });
});
