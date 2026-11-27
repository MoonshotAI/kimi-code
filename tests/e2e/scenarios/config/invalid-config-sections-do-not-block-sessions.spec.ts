import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'starts and resumes sessions when sections of the config file are invalid',
  { config: { extra: { permission: { rules: 'deny everything' } } } },
  async ({ product, model, configure }) => {
    model.script(say('The parser reads tokens.'), say('The emitter writes files.'));

    await product.send('Describe the parser.');
    await product.waitIdle();
    await product.expectReply('The parser reads tokens.');

    await configure((config) => ({ ...config, extra: { ...config.extra, environments: { default: 'missing' } } }));
    await product.restart();
    await product.send('Describe the emitter.');
    await product.waitIdle();
    await product.expectReply('The emitter writes files.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.texts('assistant')).toContain('The parser reads tokens.');
    expect(requests[1]?.userTextsSinceReply.at(-1)).toBe('Describe the emitter.');
  },
);
