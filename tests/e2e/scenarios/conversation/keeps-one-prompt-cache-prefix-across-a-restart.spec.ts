import { bash, read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps every request on one prompt cache prefix through tool calls, an approval and a restart',
  { workspace: { 'notes.txt': 'launch on friday\n' } },
  async ({ product, model, workspace }) => {
    model.script(read('notes.txt'), say('The notes say launch on friday.'));
    await product.send('Read notes.txt and tell me what it says.');
    await product.waitIdle();
    await product.expectTool({ name: 'Read', target: 'notes.txt', status: 'done' });
    await product.expectReply('The notes say launch on friday.');

    model.script(bash('echo checked | tee -a check.txt'), say('The check printed checked.'));
    await product.send('Append checked to check.txt with a shell command.');
    await product.approve();
    await product.waitIdle();
    await product.expectReply('The check printed checked.');

    await product.restart();
    await product.expectTranscript('The check printed checked.');

    model.script(read('notes.txt'), say('The notes still say launch on friday.'));
    await product.send('Read notes.txt once more.');
    await product.waitIdle();
    await product.expectReply('The notes still say launch on friday.');

    const requests = model.requests('main');
    expect(requests[1]?.texts('tool').join('\n')).toContain('launch on friday');
    expect(requests[3]?.texts('tool').join('\n')).toContain('checked');
    const main = model.promptCache().filter((entry) => entry.role === 'main' && !entry.rejected);
    expect(main).toHaveLength(6);
    expect(new Set(main.map((entry) => entry.cacheKey)).size).toBe(1);
    expect(main.slice(1).map((entry) => entry.baseline)).toEqual(main.slice(0, -1).map((entry) => entry.request));
    expect(main.slice(1).every((entry) => entry.reusedTokens > 0)).toBe(true);
    expect(model.promptCacheProblems()).toEqual([]);
    await workspace.expectFile('notes.txt', 'launch on friday\n');
    await workspace.expectFile('check.txt', 'checked\n');
  },
);
