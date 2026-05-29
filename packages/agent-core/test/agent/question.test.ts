import { describe, expect, it } from 'vitest';

import { testAgent } from './harness/agent';

describe('Agent question', () => {
  it('roundtrips a question request through wire rpc', async () => {
    const ctx = testAgent();

    const resultPromise = ctx.agent.rpc!.requestQuestion!(
      {
        questions: [
          {
            question: 'Pick one',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(await ctx.untilQuestion({ Yes: true })).toMatchInlineSnapshot(
      `[emit] requestQuestion   { "questions": [ { "question": "Pick one", "options": [ { "label": "Yes" }, { "label": "No" } ] } ] }`,
    );

    await expect(resultPromise).resolves.toEqual({ Yes: true });
    await ctx.expectResumeMatches();
  });

  it('sends multiple questions in one request', async () => {
    const ctx = testAgent();

    const resultPromise = ctx.agent.rpc!.requestQuestion!(
      {
        questions: [
          {
            question: 'Pick one',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
          {
            question: 'Pick storage',
            options: [{ label: 'Postgres' }, { label: 'SQLite' }],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(
      await ctx.untilQuestion({ Yes: true, 'Pick storage': 'Postgres' }),
    ).toMatchInlineSnapshot(
      `[emit] requestQuestion   { "questions": [ { "question": "Pick one", "options": [ { "label": "Yes" }, { "label": "No" } ] }, { "question": "Pick storage", "options": [ { "label": "Postgres" }, { "label": "SQLite" } ] } ] }`,
    );

    await expect(resultPromise).resolves.toEqual({ Yes: true, 'Pick storage': 'Postgres' });
    await ctx.expectResumeMatches();
  });
});
