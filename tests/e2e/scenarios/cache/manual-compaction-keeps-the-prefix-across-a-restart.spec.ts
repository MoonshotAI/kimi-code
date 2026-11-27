import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const summary = 'The user asked about the parser module, which tokenizes input and builds a syntax tree.';

scenario(
  'keeps the prompt cache prefix after the user compacts the context by hand, also across a restart',
  {},
  async ({ product, model }) => {
    model.script(say('The parser tokenizes the input.'), say('The emitter writes the files.'), say('The linker joins them.'));
    model.lane('compaction').script(say(summary));

    await product.send('Describe the parser.');
    await product.waitIdle();
    await product.expectReply('The parser tokenizes the input.');
    await product.compact();

    await product.send('Describe the emitter.');
    await product.waitIdle();
    await product.expectReply('The emitter writes the files.');

    await product.restart();
    await product.send('Describe the linker.');
    await product.waitIdle();
    await product.expectReply('The linker joins them.');

    expect(model.requests('compaction')).toHaveLength(1);
    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    for (const request of requests.slice(1)) {
      expect(request.texts('user').some((text) => text.includes(summary))).toBe(true);
      expect(request.texts('assistant')).not.toContain('The parser tokenizes the input.');
    }
    expect(requests[2]?.texts('assistant')).toContain('The emitter writes the files.');
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));

    const entries = model.promptCache().filter((entry) => entry.role === 'main' || entry.role === 'compaction');
    expect(entries.map((entry) => entry.role)).toEqual(['main', 'compaction', 'main', 'main']);
    expect(entries.map((entry) => entry.baseline)).toEqual([undefined, entries[0]?.request, entries[0]?.request, entries[2]?.request]);
    expect(entries.map((entry) => entry.break?.part)).toEqual([undefined, undefined, 'history', undefined]);
    expect(entries[2]?.explanation).toBe('the history restarts after compaction');
  },
);
