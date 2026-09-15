import { afterEach, describe, expect, it } from 'vitest';

import { IEventService } from '#/app/event/event';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { createTestAgent, type TestAgentContext } from '../../harness';

describe('prompt submit', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('submits a prompt and returns the turn id', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'hi' });

    const launched = await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    expect(launched?.turn_id).toBe(0);
    await ctx.untilTurnEnd();
  });

  it('derives the session title and lastPrompt from the first prompt', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'hi' });

    const events: { type: string; payload?: unknown }[] = [];
    const sub = ctx.get(IEventService).subscribe((event) => events.push(event));

    const launched = await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello title' }] });
    expect(launched?.turn_id).toBe(0);
    sub.dispose();

    const metadata = await ctx.get(ISessionMetadata).read();
    expect(metadata.title).toBe('hello title');
    expect(metadata.lastPrompt).toBe('hello title');

    const updated = events.find((event) => event.type === 'session.meta.updated');
    expect(updated).toBeDefined();
    const payload = updated?.payload as
      | { title?: string; patch?: { lastPrompt?: string } }
      | undefined;
    expect(payload?.title).toBe('hello title');
    expect(payload?.patch?.lastPrompt).toBe('hello title');

    await ctx.untilTurnEnd();
  });

  it('keeps a custom title and only refreshes lastPrompt on a later prompt', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'hi' });

    await ctx.get(ISessionMetadata).setTitle('keep-me');

    const launched = await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'should not become the title' }],
    });
    expect(launched?.turn_id).toBe(0);

    const metadata = await ctx.get(ISessionMetadata).read();
    expect(metadata.title).toBe('keep-me');
    expect(metadata.lastPrompt).toBe('should not become the title');

    await ctx.untilTurnEnd();
  });
});
