import { read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const UNDO = 'the user withdrew the last prompt, so the history ends before it';

scenario(
  'breaks the prompt cache only in the history, and continues from there, when the user withdraws the last prompt with undo and sends it again',
  {
    except: { acp: 'ACP has no request to withdraw a message, and an editor keeps its own input.' },
    workspace: { 'notes.txt': 'alpha\n' },
  },
  async ({ product, model }) => {
    const question = 'What does notes.txt say?';
    model.script(say('Hello there.'), read('notes.txt'), say('It says alpha.'), say('It still says alpha.'), say('Goodbye.'));

    await product.send('Hello.');
    await product.waitIdle();
    await product.expectReply('Hello there.');
    await product.send(question);
    await product.waitIdle();
    await product.expectReply('It says alpha.');

    await product.undo();
    await product.expectComposer(question);
    await product.expectReply('Hello there.');

    model.expectCacheBreak(UNDO, { at: 'history' });
    await product.submit(question);
    await product.waitIdle();
    await product.expectReply('It still says alpha.');

    await product.send('Thanks, that is all.');
    await product.waitIdle();
    await product.expectReply('Goodbye.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(5);
    expect(requests[2]?.texts('tool').join('\n')).toContain('alpha');
    expect(requests[3]?.texts('tool')).toEqual([]);
    expect(requests[3]?.texts('assistant')).not.toContain('It says alpha.');
    expect(requests[3]?.texts('user').filter((text) => text === question)).toHaveLength(1);
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));

    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.break?.part)).toEqual([undefined, undefined, undefined, 'history', undefined]);
    expect(main[3]?.break?.region).toBe('messages');
    expect(main[3]?.explanation).toBe(UNDO);
    expect(main[3]?.reusedTokens).toBeGreaterThanOrEqual(main[0]?.totalTokens ?? Number.POSITIVE_INFINITY);
    expect(main[4]?.baseline).toBe(main[3]?.request);
  },
);
