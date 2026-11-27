import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const BACKUP = { provider: 'testkit', model: 'testkit-backup', maxContextSize: 262_144 };

scenario(
  'reopens a session with its history after the user removed its model from the config file',
  { config: { models: { backup: BACKUP } } },
  async ({ product, model, configure }) => {
    const reply = 'The parser reads tokens.';
    model.script(say(reply));

    await product.send('Describe the parser.');
    await product.waitIdle();
    await product.expectReply(reply);

    await configure((config) => ({ ...config, defaultModel: 'backup', models: { backup: BACKUP } }));
    await product.restart();
    await product.expectTranscript('Describe the parser.');
    await product.expectTranscript(reply);
    expect(model.requests('main')).toHaveLength(1);
  },
);
