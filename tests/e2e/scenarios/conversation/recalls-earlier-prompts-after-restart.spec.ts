import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'recalls earlier prompts with the up key, newest first, before and after a restart',
  {
    except: {
      acp: 'An editor writes prompts in its own input and keeps its own prompt history.',
      tui: 'The terminal UI records every line the user submits, so after a restart the up key first brings back the /exit that closed it; its prompt history is covered by the recallPrevious self-tests.',
    },
  },
  async ({ product, model }) => {
    const opener = 'Let us plan the release.';
    const older = 'List the packages that changed.';
    const newer = 'Draft the release notes.';
    model.script(say('Sure.'), say('Three packages changed.'), say('Here is a draft.'), say('The same three packages.'), say('Here is the draft once more.'));

    await product.send(opener);
    await product.waitIdle();
    await product.send(older);
    await product.waitIdle();
    await product.send(newer);
    await product.waitIdle();

    await product.recallPrevious();
    await product.expectComposer(newer);
    await product.recallPrevious();
    await product.expectComposer(older);
    await product.submit(older);
    await product.waitIdle();
    await product.expectReply('The same three packages.');

    await product.restart();
    await product.recallPrevious();
    await product.expectComposer(older);
    await product.recallPrevious();
    await product.expectComposer(newer);
    await product.submit(newer);
    await product.waitIdle();
    await product.expectReply('Here is the draft once more.');
    expect(model.requests('main').at(-1)?.userTextsSinceReply).toEqual([newer]);
  },
);
