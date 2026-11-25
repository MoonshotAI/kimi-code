import { held, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps a reply whole and shown once when the user narrows the window while it streams, and after widening it again',
  {
    onlyOn: ['tui', 'web'],
    reason: 'Only the terminal UI and the Web interface can be resized by a user operation the tests can perform; ACP has no window and Desktop needs code in Electron.',
  },
  async ({ product, model }) => {
    const prompt = 'Explain how the release pipeline works.';
    const opening = 'The release pipeline builds every package, runs the unit tests on Linux and Windows, ';
    const rest = 'signs the desktop installers, publishes the CLI to npm, and finally tags the commit it shipped.';
    const followUp = 'Thanks, that helps.';
    const closing = 'Glad it helped.';
    model.script(held('explaining', say([opening, rest]), 1), say(closing));

    await product.send(prompt);
    await model.hold('explaining').reached();
    await product.resize('narrow');
    model.hold('explaining').release();
    await product.waitIdle();
    await product.expectReply(`${opening}${rest}`);

    await product.resize('normal');
    await product.expectTranscript(prompt);
    await product.expectTranscript(`${opening}${rest}`);

    await product.send(followUp);
    await product.waitIdle();
    await product.expectReply(closing);
    expect(model.requests('main').map((request) => request.userTextsSinceReply)).toEqual([[prompt], [followUp]]);
  },
);
