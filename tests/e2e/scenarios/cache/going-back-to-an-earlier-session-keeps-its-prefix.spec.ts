import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps the prompt cache prefix of the earlier session when the user starts a new session and then goes back to the earlier one',
  {},
  async ({ product, model }) => {
    const earlier = 'Plan the launch checklist.';
    const later = 'Draft the release notes.';
    model.script(say('The checklist has three steps.'), say('The release notes are drafted.'), say('The checklist now has four steps.'));

    await product.send(earlier);
    await product.waitIdle();
    await product.expectReply('The checklist has three steps.');

    await product.newSession();
    await product.send(later);
    await product.waitIdle();
    await product.expectReply('The release notes are drafted.');

    await product.openSession(earlier);
    await product.expectTranscript(earlier);
    await product.expectReply('The checklist has three steps.');
    await product.expectAbsent('The release notes are drafted.');

    await product.send('Add a fourth step to the checklist.');
    await product.waitIdle();
    await product.expectReply('The checklist now has four steps.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    const [first, other, back] = requests;
    expect(back?.texts('user')).toContain(earlier);
    expect(back?.texts('assistant')).toContain('The checklist has three steps.');
    expect([...(back?.texts('user') ?? []), ...(back?.texts('assistant') ?? [])].some((text) => text.includes(later) || text.includes('The release notes are drafted.'))).toBe(false);
    expect(other?.texts('user').some((text) => text.includes(earlier))).toBe(false);
    expect(back?.view.system).toBe(first?.view.system);
    expect(back?.tools).toEqual(first?.tools);

    const main = model.promptCache().filter((entry) => entry.role === 'main' && !entry.rejected);
    expect(main).toHaveLength(3);
    const [opened, started, returned] = main;
    expect(started?.cacheKey).not.toBe(opened?.cacheKey);
    expect(returned?.cacheKey).toBe(opened?.cacheKey);
    expect(returned?.baseline).toBe(opened?.request);
    expect(returned?.break).toBeUndefined();
    expect(returned?.reusedTokens).toBeGreaterThanOrEqual(opened?.totalTokens ?? Number.POSITIVE_INFINITY);
    expect(model.promptCacheProblems()).toEqual([]);
  },
);
