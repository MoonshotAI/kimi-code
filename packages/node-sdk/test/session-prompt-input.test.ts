import { describe, expect, it, vi } from 'vitest';

import type { SDKRpcClient } from '../src/rpc';
import { Session } from '../src/session';

describe('Session.prompt input normalization', () => {
  it('passes multimodal prompt parts through to the core RPC client', async () => {
    const prompt = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_multimodal_prompt',
      workDir: '/tmp/work',
      rpc: { prompt } as unknown as SDKRpcClient,
    });
    const input = [
      { type: 'text', text: 'describe these' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      { type: 'video_url', videoUrl: { url: 'ms://file-123', id: 'file-123' } },
    ] as const;

    await session.prompt(input);

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'ses_multimodal_prompt',
      input,
    });
  });

  it('normalizes btw prompt text before calling the core RPC client', async () => {
    const startBtw = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_btw_prompt',
      workDir: '/tmp/work',
      rpc: { startBtw } as unknown as SDKRpcClient,
    });

    await expect(session.startBtw('  side question  ')).resolves.toBeUndefined();
    expect(startBtw).toHaveBeenCalledWith({
      sessionId: 'ses_btw_prompt',
      prompt: 'side question',
    });

    await expect(session.startBtw('   ')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'request.prompt_input_empty',
    });
    expect(startBtw).toHaveBeenCalledTimes(1);
  });

  it('calls the core RPC client to cancel btw', async () => {
    const cancelBtw = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_btw_cancel',
      workDir: '/tmp/work',
      rpc: { cancelBtw } as unknown as SDKRpcClient,
    });

    await session.cancelBtw();

    expect(cancelBtw).toHaveBeenCalledWith({
      sessionId: 'ses_btw_cancel',
    });
  });
});
