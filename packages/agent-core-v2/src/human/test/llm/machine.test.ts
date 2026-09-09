import { describe, expect, it } from 'vitest';
import { createActor, waitFor } from '#/xstate2';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import type { LlmErrorMessage } from '#/llm/errors';
import type { StreamedMessagePart } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import {
  createLlmMachine,
  type CreateLlmMachineOptions,
  type LlmOutput,
} from '#/llm/requester/machine';
import type { LlmRequester } from '#/llm/requester/requester';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

async function runMachine(options: CreateLlmMachineOptions) {
  const parts: StreamedMessagePart[] = [];
  const actor = createActor(createLlmMachine(options), {
    input: {
      config: { model },
      content: { messages: [] },
      signal: new AbortController().signal,
    },
  });
  actor.on('llm.streaming.part', (event) => {
    parts.push(event.part);
  });
  actor.start();
  const snapshot = await waitFor(actor, (state) => state.status === 'done');
  actor.stop();
  return { output: snapshot.output as LlmOutput, parts };
}

describe('llm machine request actor', () => {
  it('completes with the streamed content on success', async () => {
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'hello' } });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };

    const { output, parts } = await runMachine({ requester });

    expect(output).toEqual({ type: 'succeeded' });
    expect(parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('fails when the requester reports a remote failure', async () => {
    const error: LlmErrorMessage = { kind: 'connection', message: 'down' };
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        onEvent?.({ type: 'llm.failed.remote', error });
        return Promise.resolve();
      },
    };

    const { output } = await runMachine({ requester });

    expect(output).toEqual({ type: 'failed', error });
  });

  it('fails instead of hanging when the requester throws', async () => {
    const requester: LlmRequester = {
      generate: () => Promise.reject(new Error('socket exploded')),
    };

    const { output } = await runMachine({ requester });

    expect(output).toEqual({
      type: 'failed',
      error: { kind: 'unknown', message: 'socket exploded' },
    });
  });

  it('fails instead of hanging when a message resolver throws', async () => {
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };

    const { output } = await runMachine({
      requester,
      messageResolvers: [
        { id: 'boom', resolve: () => Promise.reject(new Error('resolver exploded')) },
      ],
    });

    expect(output).toEqual({
      type: 'failed',
      error: { kind: 'unknown', message: 'resolver exploded' },
    });
  });
});
