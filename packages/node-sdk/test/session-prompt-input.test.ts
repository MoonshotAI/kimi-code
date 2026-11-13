import { describe, expect, it, vi } from 'vitest';

import { SDKRpcClientBase } from '../src/rpc';
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

  it('forwards a caller-chosen promptId to the core RPC client', async () => {
    const prompt = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_prompt_id',
      workDir: '/tmp/work',
      rpc: { prompt } as unknown as SDKRpcClientBase,
    });

    await session.prompt('hello', { promptId: 'sub-1' });

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'ses_prompt_id',
      input: [{ type: 'text', text: 'hello' }],
      promptId: 'sub-1',
    });
  });

  it('rejects an empty caller-chosen promptId before calling RPC', async () => {
    const prompt = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_prompt_id',
      workDir: '/tmp/work',
      rpc: { prompt } as unknown as SDKRpcClientBase,
    });

    await expect(session.prompt('hello', { promptId: '' })).rejects.toThrow(
      'promptId must not be empty',
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('returns the core steer identity and delivery state', async () => {
    const submission = {
      promptId: 'prompt-steer-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'running',
      steered: true,
      turnId: 4,
    } as const;
    const steer = vi.fn(async () => submission);
    const session = new Session({
      id: 'ses_steer_result',
      workDir: '/tmp/work',
      rpc: { steer } as unknown as SDKRpcClientBase,
    });

    await expect(session.steer('focus on tests')).resolves.toEqual(submission);
    expect(steer).toHaveBeenCalledWith({
      sessionId: 'ses_steer_result',
      input: [{ type: 'text', text: 'focus on tests' }],
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
