import { describe, expect, it, vi } from 'vitest';

import type { SDKRpcClientBase } from '../src/rpc';
import { Session } from '../src/session';

describe('Session.prompt input normalization', () => {
  it('passes multimodal prompt parts through to the core RPC client', async () => {
    const prompt = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_multimodal_prompt',
      workDir: '/tmp/work',
      rpc: { prompt } as unknown as SDKRpcClientBase,
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

  it('starts btw and returns the forked agent id', async () => {
    const startBtw = vi.fn(async () => 'agent-btw');
    const session = new Session({
      id: 'ses_btw_start',
      workDir: '/tmp/work',
      rpc: { startBtw } as unknown as SDKRpcClientBase,
    });

    await expect(session.startBtw()).resolves.toBe('agent-btw');
    expect(startBtw).toHaveBeenCalledWith({
      sessionId: 'ses_btw_start',
    });
  });
});
