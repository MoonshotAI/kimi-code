import { held, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'runs messages queued during a turn one after another once it ends',
  { except: { acp: 'ACP has no way to send a message while a turn runs: the editor waits for the session/prompt answer before it sends the next one.' } },
  async ({ product, model }) => {
    const prompt = 'Draft the release notes.';
    const first = 'Also list the breaking changes.';
    const second = 'Finally thank the contributors.';
    const answers = ['Here are the release notes.', 'Two breaking changes are listed.', 'The contributors are thanked.'] as const;
    model.script(held('drafting', say(['Here are the ', 'release notes.']), 1), say(answers[1]), say(answers[2]));

    await product.send(prompt);
    await model.hold('drafting').reached();
    await product.queue(first);
    await product.queue(second);
    expect(model.requests('main')).toHaveLength(1);
    model.hold('drafting').release();
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests.map((request) => request.state)).toEqual(['finished', 'finished', 'finished']);
    expect(requests.map((request) => request.userTextsSinceReply)).toEqual([[prompt], [first], [second]]);
    await product.expectReply(answers[2]);
    for (const text of [prompt, first, second, ...answers]) await product.expectTranscript(text);
  },
);
