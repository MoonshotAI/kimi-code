import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ genAIConstructor: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: mocks.genAIConstructor,
}));

import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';

describe('Google GenAI client', () => {
  beforeEach(() => {
    mocks.genAIConstructor.mockClear();
  });

  it('passes Vertex project and location to the SDK when using ADC', () => {
    googleGenAIProtocol.client(
      {},
      { vertexai: true, project: 'test-project', location: 'test-location' },
    );

    expect(mocks.genAIConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.genAIConstructor).toHaveBeenCalledWith({
      apiKey: undefined,
      vertexai: true,
      project: 'test-project',
      location: 'test-location',
      httpOptions: undefined,
    });
  });

  it('keeps Vertex API key requests projectless', () => {
    googleGenAIProtocol.client(
      { apiKey: 'test-key' },
      { vertexai: true, project: 'test-project', location: 'test-location' },
    );

    expect(mocks.genAIConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.genAIConstructor).toHaveBeenCalledWith({
      apiKey: 'test-key',
      vertexai: true,
      project: undefined,
      location: undefined,
      httpOptions: undefined,
    });
  });
});
