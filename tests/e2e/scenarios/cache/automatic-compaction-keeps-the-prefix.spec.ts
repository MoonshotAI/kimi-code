import { read, say, withUsage } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const summary = 'The user asked to read notes.txt, which says launch on friday.';

scenario(
  'keeps the prompt cache prefix when the context grows past the compaction trigger in the middle of a turn',
  { workspace: { 'notes.txt': 'launch on friday\n' }, config: { loopControl: { compaction_trigger_ratio: 0.5 } } },
  async ({ product, model, workspace }) => {
    model.script(say('Ready.'));
    await product.send('Get ready.');
    await product.waitIdle();
    await product.expectReply('Ready.');

    model.lane('compaction').script(say(summary));
    model.script(withUsage({ input: 160_000, output: 1 }, read('notes.txt')), say('The notes say launch on friday.'), say('Still friday.'));
    await product.send('Read notes.txt.');
    await product.waitIdle();
    await product.expectReply('The notes say launch on friday.');
    await product.send('Is it still friday?');
    await product.waitIdle();
    await product.expectReply('Still friday.');

    expect(model.requests('compaction')).toHaveLength(1);
    const requests = model.requests('main');
    expect(requests).toHaveLength(4);
    expect(requests[2]?.texts('user').some((text) => text.includes(summary))).toBe(true);
    const entries = model.promptCache().filter((entry) => entry.role === 'main' || entry.role === 'compaction');
    expect(entries.map((entry) => entry.role)).toEqual(['main', 'main', 'compaction', 'main', 'main']);
    expect(entries.map((entry) => entry.baseline)).toEqual([undefined, entries[0]?.request, entries[1]?.request, entries[1]?.request, entries[3]?.request]);
    expect(entries.map((entry) => entry.break?.part)).toEqual([undefined, undefined, undefined, 'history', undefined]);
    expect(entries[3]?.explanation).toBe('the history restarts after compaction');
    await workspace.expectFile('notes.txt', 'launch on friday\n');
  },
);
