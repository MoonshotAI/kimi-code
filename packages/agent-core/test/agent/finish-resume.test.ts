// finishResume — replay-time repair for turns killed between `step.begin` and
// the first content/tool record (issue #1404: empty assistant at the tail of
// history bricks every subsequent resume with provider 400s).
import { describe, expect, it } from 'vitest';

import { testAgent } from './harness/agent';

const PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' } as const;
const CAPS = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

function seedAgent() {
  const ctx = testAgent();
  ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'user one' }]);
  ctx.agent.context.appendLoopEvent({ type: 'step.begin', uuid: 's1', turnId: 't1', step: 1 });
  ctx.agent.context.appendLoopEvent({
    type: 'content.part',
    uuid: 'p1',
    turnId: 't1',
    step: 1,
    stepUuid: 's1',
    part: { type: 'text', text: 'assistant one' },
  });
  ctx.agent.context.appendLoopEvent({ type: 'step.end', uuid: 's1', turnId: 't1', step: 1 });
  return ctx;
}

describe('finishResume — empty assistant tail repair (#1404)', () => {
  it('drops a trailing assistant message left empty by a killed turn', () => {
    const ctx = seedAgent();
    const before = ctx.agent.context.history.length;
    // Turn dies right after step.begin: an empty assistant is appended and
    // never receives any content or tool calls.
    ctx.agent.context.appendLoopEvent({ type: 'step.begin', uuid: 'dead', turnId: 't2', step: 2 });
    expect(ctx.agent.context.history.at(-1)?.role).toBe('assistant');
    expect(ctx.agent.context.history.at(-1)?.content).toHaveLength(0);
    expect(ctx.agent.context.history.at(-1)?.toolCalls).toHaveLength(0);

    ctx.agent.context.finishResume();

    const history = ctx.agent.context.history;
    expect(history.length).toBe(before);
    const last = history.at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.content.map((p) => (p.type === 'text' ? p.text : '')).join('')).toBe(
      'assistant one',
    );
  });

  it('drops several consecutive empty assistant tails', () => {
    const ctx = seedAgent();
    ctx.agent.context.appendLoopEvent({ type: 'step.begin', uuid: 'dead1', turnId: 't2', step: 2 });
    ctx.agent.context.appendLoopEvent({ type: 'step.begin', uuid: 'dead2', turnId: 't2', step: 3 });

    ctx.agent.context.finishResume();

    const last = ctx.agent.context.history.at(-1);
    expect(last?.content.map((p) => (p.type === 'text' ? p.text : '')).join('')).toBe(
      'assistant one',
    );
  });

  it('keeps a trailing assistant that has content', () => {
    const ctx = seedAgent();
    ctx.agent.context.appendLoopEvent({ type: 'step.begin', uuid: 's2', turnId: 't2', step: 2 });
    ctx.agent.context.appendLoopEvent({
      type: 'content.part',
      uuid: 'p2',
      turnId: 't2',
      step: 2,
      stepUuid: 's2',
      part: { type: 'text', text: 'partial but real content' },
    });

    ctx.agent.context.finishResume();

    const last = ctx.agent.context.history.at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.content.map((p) => (p.type === 'text' ? p.text : '')).join('')).toBe(
      'partial but real content',
    );
  });

  it('keeps a trailing assistant that has tool calls (exchange closes with an error result)', () => {
    const ctx = seedAgent();
    ctx.agent.context.appendLoopEvent({ type: 'step.begin', uuid: 's2', turnId: 't2', step: 2 });
    ctx.agent.context.appendLoopEvent({
      type: 'tool.call',
      uuid: 'c1',
      turnId: 't2',
      step: 2,
      stepUuid: 's2',
      toolCallId: 'call-1',
      name: 'bash',
      args: { command: 'sleep 1' },
    });

    ctx.agent.context.finishResume();

    const history = ctx.agent.context.history;
    const assistant = history.findLast((m) => m.role === 'assistant');
    expect(assistant?.toolCalls.map((c) => c.id)).toContain('call-1');
    // The dangling call is closed in place by finishResume with an interrupted
    // tool result, so the exchange stays well-formed for the provider.
    expect(history.at(-1)?.role).toBe('tool');
    expect(history.at(-1)?.isError).toBe(true);
  });
});
